// Web app: a run started from the API streams every step (invoices read, plan, mission,
// approval, one decision per payment, summary) over server-sent events, in judge mode.
// The real web server and judge gateway run locally; only the Meta API is mocked.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { JudgeGateway } from "../src/judge/gateway.js";
import { WebApp } from "../src/web/server.js";
import type { RunEvent } from "../src/runner.js";

const META = "https://api.meta.test/v1";
const SAMPLES: Record<string, { payee: string; amount: number }> = {
  "brightleaf-studio-INV-1042.png": { payee: "Brightleaf Design Studio", amount: 400 },
  "copperline-plumbing-CP-2291.jpg": { payee: "Copperline Plumbing & Heating", amount: 1250 },
  "juniper-rye-catering-JR-0507.png": { payee: "Juniper & Rye Catering", amount: 640 },
  "nimbus-hosting-NH-88317.pdf": { payee: "Nimbus Cloud Hosting", amount: 89 },
};

const realFetch = globalThis.fetch;
let gw: JudgeGateway;
let server: Server;
let base = "";

// Stands in for Muse Spark: reads each invoice by file name, proposes one payment per
// invoice, then writes a closing message.
function fakeMeta(body: any): unknown {
  if (body.response_format) {
    const name = Object.keys(SAMPLES).find((n) => JSON.stringify(body.messages).includes(n))!;
    const s = SAMPLES[name];
    const content = JSON.stringify({ payee: s.payee, amount: s.amount, currency: "USD", due_date: "2026-11-07", invoice_number: "X-1", payment_details: null, notes: null });
    return { choices: [{ message: { role: "assistant", content } }] };
  }
  if (!body.messages.some((m: any) => m.role === "tool")) {
    const tool_calls = Object.values(SAMPLES).map((s, i) => ({
      id: `c${i}`, type: "function", function: { name: "propose_payment", arguments: JSON.stringify({ payee: s.payee, amount_usd: s.amount, memo: "invoice" }) },
    }));
    return { choices: [{ message: { role: "assistant", content: null, tool_calls } }] };
  }
  return { choices: [{ message: { role: "assistant", content: "All four approved (dry run, no money moved)." } }] };
}

before(async () => {
  process.env.META_API_BASE = META;
  process.env.META_API_KEY = "test";
  delete process.env.YEBO_MISSION_TOKEN;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).startsWith(META)) return new Response(JSON.stringify(fakeMeta(JSON.parse(String(init?.body)))), { status: 200 });
    return realFetch(url, init);
  }) as typeof fetch;

  gw = new JudgeGateway({ secret: "web-test", port: 0, autoApprove: true });
  const url = await gw.start();
  process.env.YEBO_GATEWAY_URL = url;
  process.env.YEBO_HMAC_SECRET = "web-test";
  const app = new WebApp({ mode: "judge", url, stop: () => gw.stop() });
  server = createServer(app.handler);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  globalThis.fetch = realFetch;
  await new Promise<void>((r) => server.close(() => r()));
  await gw.stop();
});

async function events(id: string): Promise<RunEvent[]> {
  const res = await fetch(`${base}/api/runs/${id}/events`);
  assert.equal(res.headers.get("content-type"), "text/event-stream");
  const text = await res.text(); // the server ends the stream when the run finishes
  return text.split("\n\n").filter((f) => f.startsWith("data: ")).map((f) => JSON.parse(f.slice(6)));
}

test("a sample run streams invoices, plan, mission, approval and one decision per payment", async () => {
  const res = await fetch(`${base}/api/runs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ samples: true }) });
  assert.equal(res.status, 201);
  const ev = await events((await res.json()).id);
  const types = ev.map((e) => e.type);

  assert.equal(types[0], "started");
  assert.equal(ev.filter((e) => e.type === "invoice").length, 4);
  assert.equal(ev.filter((e) => e.type === "proposed").length, 4);
  const mission = ev.find((e) => e.type === "mission");
  assert.ok(mission && mission.type === "mission");
  assert.equal(mission.limits.total_usd, 2379);
  assert.equal(mission.limits.per_payment_usd, 1250);
  assert.deepEqual(ev.find((e) => e.type === "mission_result"), { type: "mission_result", approved: true });
  const decisions = ev.filter((e) => e.type === "decision");
  assert.equal(decisions.length, 4);
  for (const d of decisions) {
    assert.ok(d.type === "decision");
    assert.equal(d.decision, "ALLOW");
    assert.equal(d.outcome, "approved (dry run, no money moved)");
    assert.match(d.receipt ?? "", /^rcpt_/);
  }
  assert.ok(types.indexOf("mission_result") < types.indexOf("decision"), "nothing is checked before approval");
  assert.deepEqual(types.slice(-2), ["summary", "done"]);
});

test("a finished run replays its events to a late listener", async () => {
  const res = await fetch(`${base}/api/runs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ samples: true }) });
  const id = (await res.json()).id;
  const first = await events(id);
  const again = await events(id);
  assert.deepEqual(again, first);
});

test("uploads are checked before anything runs", async () => {
  const post = (body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${base}/api/runs`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  assert.equal((await post({ files: [] })).status, 400);
  assert.equal((await post({ files: [{ name: "invoice.exe", data: "AAAA" }] })).status, 400);
  assert.equal((await post({ files: Array.from({ length: 11 }, (_, i) => ({ name: `${i}.png`, data: "AAAA" })) })).status, 400);
  assert.equal((await post({ samples: true }, { origin: "http://evil.example" })).status, 403);
  assert.equal((await fetch(`${base}/api/runs/00000000-0000-0000-0000-000000000000/events`)).status, 404);
});

test("the page is served with a strict content security policy", async () => {
  const res = await fetch(`${base}/`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-security-policy") ?? "", /default-src 'self'/);
  assert.doesNotMatch(await res.text(), /<script>(?!<\/script>)/, "no inline scripts");
  const cfg = await (await fetch(`${base}/api/config`)).json();
  assert.equal(cfg.mode, "judge");
  assert.equal(cfg.dryRun, true);
});
