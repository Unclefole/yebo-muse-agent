// The hosted demo's guard (live-run limits) and replays. No network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IncomingMessage } from "node:http";
import { LiveGuard, costUsd, liveLimits, site, visitorId, type LiveLimits } from "../src/web/hosted.js";
import { clean, loadReplays, schedule, toReplay, type Recording } from "../src/web/replays.js";

const limits = (over: Partial<LiveLimits> = {}): LiveLimits => ({
  enabled: true, perVisitorPerHour: 3, dailyUsd: 5, reserveUsd: 0.5, maxConcurrent: 2, trustProxy: false, ...over,
});
const usage = (prompt: number, completion: number, cached = 0) => ({ brain: "muse-spark" as const, model: "muse-spark-1.3", prompt_tokens: prompt, completion_tokens: completion, cached_tokens: cached });

test("cost uses the published prices: $1.25 in, $0.15 cached, $4.25 out per million tokens", () => {
  assert.equal(costUsd(usage(1_000_000, 0)), 1.25);
  assert.equal(costUsd(usage(0, 1_000_000)), 4.25);
  assert.equal(costUsd(usage(1_000_000, 0, 1_000_000)), 0.15);
  assert.ok(Math.abs(costUsd(usage(40_000, 5_000, 10_000)) - (30_000 * 1.25 + 10_000 * 0.15 + 5_000 * 4.25) / 1e6) < 1e-12);
});

test("site and limits come from the environment, live is off without a key or with YEBO_LIVE=off", () => {
  const saved = process.env.YEBO_SITE;
  try {
    process.env.YEBO_SITE = "Replay";
    assert.equal(site(), "replay");
    process.env.YEBO_SITE = "something";
    assert.equal(site(), "local");
  } finally {
    if (saved === undefined) delete process.env.YEBO_SITE;
    else process.env.YEBO_SITE = saved;
  }
  assert.equal(liveLimits({ META_API_KEY: "k" }).enabled, true);
  assert.equal(liveLimits({}).enabled, false);
  assert.equal(liveLimits({ META_API_KEY: "k", YEBO_LIVE: "OFF" }).enabled, false);
  assert.deepEqual(
    { ...liveLimits({ META_API_KEY: "k", YEBO_LIVE_DAILY_USD: "2", YEBO_LIVE_RUNS_PER_VISITOR_PER_HOUR: "1", YEBO_LIVE_DAILY_USD_BAD: "x" }) },
    { enabled: true, perVisitorPerHour: 1, dailyUsd: 2, reserveUsd: 0.5, maxConcurrent: 2, trustProxy: false },
  );
  assert.equal(liveLimits({ YEBO_LIVE_DAILY_USD: "-3" }).dailyUsd, 5, "a negative cap falls back to the default");
});

test("visitor: the socket address, or the proxy's own (last) X-Forwarded-For entry when trusted", () => {
  const req = (xff?: string) => ({ headers: xff ? { "x-forwarded-for": xff } : {}, socket: { remoteAddress: "10.0.0.9" } }) as unknown as IncomingMessage;
  assert.equal(visitorId(req("1.1.1.1, 2.2.2.2"), false), "10.0.0.9");
  assert.equal(visitorId(req("1.1.1.1, 2.2.2.2"), true), "2.2.2.2", "a spoofed first entry is ignored");
  assert.equal(visitorId(req(), true), "10.0.0.9");
});

test("guard: off switch, per-visitor hourly limit, and at most N runs at once", () => {
  assert.equal(new LiveGuard(limits({ enabled: false }), null).admit("a").ok, false);
  let t = Date.parse("2026-11-01T10:00:00Z");
  const g = new LiveGuard(limits({ maxConcurrent: 10 }), null, () => t);
  for (let i = 0; i < 3; i++) {
    const a = g.admit("a");
    assert.ok(a.ok);
    a.done();
  }
  const fourth = g.admit("a");
  assert.ok(!fourth.ok && fourth.status === 429 && /3 live runs per visitor per hour/.test(fourth.error));
  assert.ok(g.admit("b").ok, "another visitor is not affected");
  t += 61 * 60_000;
  assert.ok(g.admit("a").ok, "an hour later the visitor can run again");

  const two = new LiveGuard(limits({ maxConcurrent: 2 }), null, () => t);
  const r1 = two.admit("x");
  const r2 = two.admit("y");
  assert.ok(r1.ok && r2.ok);
  const r3 = two.admit("z");
  assert.ok(!r3.ok && /in progress/.test(r3.error));
  r1.done();
  r1.done(); // done twice counts once
  assert.ok(two.admit("z").ok);
});

test("guard: the daily cap counts real spend plus a reserve for each run in progress, and resets at UTC midnight", () => {
  let t = Date.parse("2026-11-01T10:00:00Z");
  const g = new LiveGuard(limits({ dailyUsd: 1, reserveUsd: 0.4, perVisitorPerHour: 100, maxConcurrent: 10 }), null, () => t);
  const a = g.admit("v");
  const b = g.admit("v");
  assert.ok(a.ok && b.ok);
  const c = g.admit("v");
  assert.ok(!c.ok && /budget is used up/.test(c.error), "two runs in progress reserve $0.80 of $1");
  g.record(usage(100_000, 10_000)); // $0.1675
  a.done();
  b.done();
  assert.ok(g.admit("v").ok, "$0.17 spent + $0.40 reserve fits");
  g.record(usage(400_000, 0)); // +$0.50: $0.6675 spent, plus the $0.40 still reserved
  assert.ok(!g.admit("v").ok);
  assert.equal(g.status().spentUsd, 0.6675);
  t = Date.parse("2026-11-02T00:00:01Z");
  assert.equal(g.status().spentUsd, 0);
});

test("guard: spend survives a restart, and an unreadable spend file closes live runs for the day", () => {
  const dir = mkdtempSync(join(tmpdir(), "yebo-spend-"));
  const file = join(dir, "spend.json");
  const t = () => Date.parse("2026-11-01T10:00:00Z");
  const g = new LiveGuard(limits(), file, t);
  g.record(usage(0, 1_000_000)); // $4.25
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { day: "2026-11-01", usd: 4.25, runs: 0 });
  assert.equal(new LiveGuard(limits(), file, t).status().spentUsd, 4.25);
  const again = new LiveGuard(limits(), file, t);
  assert.ok(again.admit("v").ok, "$4.25 spent + a $0.50 reserve is within $5");
  assert.equal(again.admit("w").ok, false, "a second reserve is not");
  writeFileSync(file, "{ broken");
  const broken = new LiveGuard(limits(), file, t).admit("v");
  assert.ok(!broken.ok && broken.status === 429);
});

const rec = (): Recording => ({
  recordedAt: "2026-10-27T20:00:00.000Z",
  mode: "judge",
  input: { goal: "Pay these invoices.", brain: "muse-spark", attackDemo: false, invoices: ["a.png"] },
  events: [
    { ms: 0, event: { type: "planning" } },
    { ms: 9000, event: { type: "mission", requestId: "r1", authorizeUrl: "http://127.0.0.1:4400/authorize/r1", limits: { payees: ["A"], per_payment_usd: 1, total_usd: 1, currency: "USD" }, source: "invoices", expiresAt: "2026-10-27T20:15:00Z", requiredApprovals: 1 } },
    { ms: 9500, event: { type: "mission_result", approved: true } },
    { ms: 30000, event: { type: "done" } },
  ],
});

test("replays: the local approval link is removed, only finished runs qualify, long waits are shortened", () => {
  const cleaned = clean(rec());
  const mission = cleaned.events[1].event;
  assert.ok(mission.type === "mission" && mission.authorizeUrl === "");
  assert.deepEqual(cleaned.events.map((e) => e.event.type), ["planning", "mission", "mission_result", "done"]);
  assert.throws(() => toReplay({ ...rec(), events: rec().events.slice(0, 2) }, "x", "t", "s"), /finished/);
  assert.throws(() => toReplay(rec(), "Bad Id", "t", "s"), /lowercase/);
  assert.deepEqual(schedule(rec().events), [0, 1500, 2000, 3500]);
});

test("replays: bad files are skipped; the bundled replays are clean, finished runs", () => {
  const dir = mkdtempSync(join(tmpdir(), "yebo-replays-"));
  writeFileSync(join(dir, "good.json"), JSON.stringify(toReplay(rec(), "good", "Good", "A run")));
  writeFileSync(join(dir, "bad.json"), "{ nope");
  writeFileSync(join(dir, "wrong.json"), JSON.stringify({ id: "wrong" }));
  assert.deepEqual(loadReplays(dir).map((r) => r.id), ["good"]);
  assert.deepEqual(loadReplays(join(dir, "missing")), []);

  const bundled = loadReplays("demo/replays");
  assert.equal(bundled.length, readdirSync("demo/replays").filter((n) => n.endsWith(".json")).length, "every bundled replay loads");
  for (const r of bundled) {
    const text = JSON.stringify(r);
    assert.doesNotMatch(text, /127\.0\.0\.1|localhost|Bearer |sk-[A-Za-z0-9]/, `${r.id} has nothing local or secret`);
    assert.ok(r.events.some((e) => e.event.type === "done"), `${r.id} finished`);
    assert.equal(r.mode, "judge");
  }
});
