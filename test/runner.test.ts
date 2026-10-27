// The agent plans first, then the limits are approved once for the whole plan. A model
// that proposes one payment per turn must get the same limits and decisions as one that
// proposes them all at once. Meta API mocked; the judge gateway is real.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { JudgeGateway } from "../src/judge/gateway.js";
import { runAgent, type RunEvent } from "../src/runner.js";

const META = "https://api.meta.test/v1";
const INVOICES = [
  { file: "a.png", payee: "Brightleaf Design Studio", amount: 400, invoice_number: "INV-1042" },
  { file: "b.png", payee: "Copperline Plumbing & Heating", amount: 1250, invoice_number: "CP-2291" },
  { file: "c.png", payee: "Nimbus Cloud Hosting", amount: 89, invoice_number: "NH-88317" },
];
const realFetch = globalThis.fetch;
let gw: JudgeGateway;
let perTurn = 1; // proposals per planning turn
let chatBodies: any[] = [];

function fakeMeta(body: any): unknown {
  const reply = (message: unknown) => ({ choices: [{ message: { role: "assistant", ...(message as object) } }] });
  const schema = body.response_format?.json_schema?.name;
  if (schema === "invoice") {
    const v = INVOICES.find((i) => JSON.stringify(body.messages).includes(`(${i.file})`))!;
    return reply({ content: JSON.stringify({ payee: v.payee, amount: v.amount, currency: "USD", due_date: "2026-11-07", invoice_number: v.invoice_number, payment_details: null, notes: null }) });
  }
  if (schema === "payment_requests") return reply({ content: JSON.stringify({ requests: [] }) });
  chatBodies.push(body);
  if (!body.tools) return reply({ content: "Report: done (dry run, no money moved)." });
  const done = body.messages.filter((m: any) => m.role === "tool").length;
  const batch = INVOICES.slice(done, done + perTurn);
  if (!batch.length) return reply({ content: "That is the whole plan." });
  return reply({
    content: null,
    tool_calls: batch.map((i, n) => ({ id: `c${done + n}`, type: "function", function: { name: "propose_payment", arguments: JSON.stringify({ payee: i.payee, amount_usd: i.amount, memo: i.invoice_number }) } })),
  });
}

before(async () => {
  process.env.META_API_BASE = META;
  process.env.META_API_KEY = "test";
  delete process.env.YEBO_MISSION_TOKEN;
  delete process.env.YEBO_VENDORS;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).startsWith(META)) return new Response(JSON.stringify(fakeMeta(JSON.parse(String(init?.body)))), { status: 200 });
    return realFetch(url, init);
  }) as typeof fetch;
  gw = new JudgeGateway({ secret: "runner-test", port: 0, autoApprove: true });
  process.env.YEBO_GATEWAY_URL = await gw.start();
  process.env.YEBO_HMAC_SECRET = "runner-test";
});

beforeEach(() => {
  chatBodies = [];
});

after(async () => {
  globalThis.fetch = realFetch;
  await gw.stop();
});

async function run(): Promise<RunEvent[]> {
  const events: RunEvent[] = [];
  const sources = INVOICES.map((i) => ({ name: i.file, data: Buffer.from("fake") }));
  await runAgent({ goal: "Pay these invoices.", sources }, { mode: "judge", url: process.env.YEBO_GATEWAY_URL!, stop: async () => {} }, (e) => events.push(e));
  return events;
}

for (const n of [1, 3]) {
  test(`${n === 1 ? "one proposal per turn" : "all proposals in one turn"}: one mission covers the whole plan and every invoice is paid`, async () => {
    perTurn = n;
    const missionsBefore = gw.missions.size;
    const ev = await run();
    const types = ev.map((e) => e.type);
    assert.equal(gw.missions.size - missionsBefore, 1, "exactly one mission");
    const mission = ev.find((e) => e.type === "mission");
    assert.ok(mission && mission.type === "mission");
    assert.deepEqual(mission.limits.payees, INVOICES.map((i) => i.payee));
    assert.equal(mission.limits.total_usd, 1739);
    const decisions = ev.flatMap((e) => (e.type === "decision" ? [e.decision] : []));
    assert.deepEqual(decisions, ["ALLOW", "ALLOW", "ALLOW"]);
    assert.ok(types.lastIndexOf("proposed") < types.indexOf("mission"), "planning finishes before the mission is requested");
    assert.ok(types.indexOf("mission_result") < types.indexOf("decision"), "nothing is checked before approval");
    assert.equal((ev.find((e) => e.type === "agent_message") as any)?.text, "Report: done (dry run, no money moved).");
  });
}

test("while planning, the agent only hears 'recorded'; the report turn gets the decisions and no tools", async () => {
  perTurn = 1;
  await run();
  const planning = chatBodies.filter((b) => b.tools);
  assert.equal(planning.length, 4, "three turns with one proposal each, then one that stops");
  const toolResults = planning.at(-1).messages.filter((m: any) => m.role === "tool").map((m: any) => JSON.parse(m.content));
  assert.equal(toolResults.length, 3);
  for (const r of toolResults) {
    assert.equal(r.status, "recorded");
    assert.equal(r.decision, undefined, "no decision exists yet while planning");
  }
  const report = chatBodies.at(-1);
  assert.equal(report.tools, undefined, "the report turn cannot propose anything");
  assert.equal(report.tool_choice, undefined);
  const last = report.messages.at(-1);
  assert.equal(last.role, "user");
  assert.match(last.content, /Yebo checked your plan/);
  assert.equal(JSON.parse(last.content.slice(last.content.indexOf("["), last.content.lastIndexOf("]") + 1)).length, 3);
  assert.doesNotMatch(last.content, /executed/, "the model never sees the gateway's raw 'executed' field");
});
