// The duplicate check and the vendor file (payee + bank account). Unit tests, then whole
// runs through the judge gateway with the Meta API mocked: invoices left out of the
// limits are denied by Yebo.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { JudgeGateway } from "../src/judge/gateway.js";
import { runAgent, type RunEvent } from "../src/runner.js";
import { accountEndings, checkInvoices, parseVendors, vendorRefusal, type Vendor } from "../src/vendors.js";
import type { Invoice } from "../src/invoice.js";

const VENDORS: Vendor[] = [
  { name: "Nimbus Cloud Hosting", accounts: ["3350"] },
  { name: "Brightleaf Design Studio", accounts: ["4821"] },
  { name: "Larkspur Linen Service", accounts: ["2207"] },
];

const inv = (file: string, payee: string, amount: number, invoice_number: string | null, payment_details: string | null): Invoice => ({
  file, payee, amount, currency: "USD", due_date: "2026-11-07", invoice_number, payment_details, notes: null,
});

const NIMBUS = inv("nimbus.pdf", "Nimbus Cloud Hosting", 89, "NH-88317", "Pay Nimbus Cloud Hosting\nFictional Bank, account ending 3350");
const NIMBUS_AGAIN = inv("nimbus-again.png", "Nimbus Cloud Hosting", 89, "nh 88317", "Pay Nimbus Cloud Hosting\nFictional Bank, account ending 3350");
const BRIGHTLEAF = inv("brightleaf.png", "Brightleaf Design Studio", 400, "INV-1042", "Bank transfer to Brightleaf Design Studio\nFictional Bank, account ending 4821");
const LARKSPUR_OTHER_ACCOUNT = inv("larkspur.png", "Larkspur Linen Service", 180, "LL-3104", "Pay Larkspur Linen Service\nFictional Bank, account ending 0000");
const UNKNOWN = inv("unknown.png", "Test Vendor Not On File", 150, "TV-0001", "Fictional Bank, account ending 0001");

test("account endings: the last 4 digits of each account-like number", () => {
  assert.deepEqual(accountEndings("Fictional Bank, account ending 4821"), ["4821"]);
  assert.deepEqual(accountEndings("Routing 021000021, account 1234 5678 9012"), ["0021", "9012"]);
  assert.deepEqual(accountEndings("Pay by card"), []);
  assert.deepEqual(accountEndings(null), []);
});

test("vendor file: payee and every account must match", () => {
  assert.equal(vendorRefusal(NIMBUS, VENDORS), null);
  assert.equal(vendorRefusal({ ...NIMBUS, payee: "  nimbus  cloud hosting " }, VENDORS), null, "case and spacing do not matter");
  assert.match(vendorRefusal(UNKNOWN, VENDORS)!, /not on the vendor file/);
  assert.match(vendorRefusal({ ...NIMBUS, payee: "Nimbus Cloud Hosting LLC" }, VENDORS)!, /not on the vendor file/, "a near-match name is a different payee");
  assert.match(vendorRefusal(LARKSPUR_OTHER_ACCOUNT, VENDORS)!, /account ending 0000 is not on file for Larkspur Linen Service \(on file: 2207\)/);
  assert.match(vendorRefusal({ ...BRIGHTLEAF, payment_details: "Account ending 4821 or account ending 7777" }, VENDORS)!, /7777/, "one unknown account is enough to refuse");
  assert.match(vendorRefusal({ ...BRIGHTLEAF, payment_details: null }, VENDORS)!, /no account number/);
});

test("duplicates: the same payee and invoice number again is refused, whatever the punctuation", () => {
  const { passed, rejected } = checkInvoices([NIMBUS, NIMBUS_AGAIN, BRIGHTLEAF], null);
  assert.deepEqual(passed, [NIMBUS, BRIGHTLEAF]);
  assert.deepEqual(rejected, [{ file: "nimbus-again.png", payee: "Nimbus Cloud Hosting", reason: "duplicate of invoice NH-88317 in nimbus.pdf" }]);
  assert.equal(checkInvoices([{ ...NIMBUS, invoice_number: null }, { ...NIMBUS_AGAIN, invoice_number: null }], null).rejected.length, 0, "no number, no duplicate claim");
});

test("without a vendor file only duplicates are refused; with one, unknown payees and accounts too", () => {
  const all = [NIMBUS, NIMBUS_AGAIN, BRIGHTLEAF, LARKSPUR_OTHER_ACCOUNT, UNKNOWN];
  assert.deepEqual(checkInvoices(all, null).passed, [NIMBUS, BRIGHTLEAF, LARKSPUR_OTHER_ACCOUNT, UNKNOWN]);
  const checked = checkInvoices(all, VENDORS);
  assert.deepEqual(checked.passed, [NIMBUS, BRIGHTLEAF]);
  assert.deepEqual(checked.rejected.map((r) => r.file), ["nimbus-again.png", "larkspur.png", "unknown.png"]);
});

test("a malformed vendor file is an error, never a silently disabled check", () => {
  assert.throws(() => parseVendors("[]"), /non-empty/);
  assert.throws(() => parseVendors('[{"name":"X","accounts":["12345"]}]'), /last 4 digits/);
  assert.throws(() => parseVendors('[{"accounts":["1234"]}]'), /"name" is required/);
  assert.deepEqual(parseVendors('[{"name":" X ","accounts":["1234"]}]'), [{ name: "X", accounts: ["1234"] }]);
});

// ── Whole runs ──────────────────────────────────────────────────────────────
const META = "https://api.meta.test/v1";
const BATCH = [NIMBUS, NIMBUS_AGAIN, BRIGHTLEAF, LARKSPUR_OTHER_ACCOUNT, UNKNOWN];
const realFetch = globalThis.fetch;
let gw: JudgeGateway;

// Stands in for Muse Spark: reads each invoice by file name and proposes one payment per
// invoice, duplicate included, as a careless agent would.
function fakeMeta(body: any): unknown {
  const reply = (message: unknown) => ({ choices: [{ message: { role: "assistant", ...(message as object) } }] });
  const schema = body.response_format?.json_schema?.name;
  if (schema === "invoice") {
    const v = BATCH.find((i) => JSON.stringify(body.messages).includes(`(${i.file})`))!;
    const { file: _file, ...fields } = v;
    return reply({ content: JSON.stringify(fields) });
  }
  if (schema === "payment_requests") return reply({ content: JSON.stringify({ requests: [] }) });
  if (body.messages.some((m: any) => m.role === "tool")) return reply({ content: "Done (dry run, no money moved)." });
  const tool_calls = BATCH.map((i, n) => ({
    id: `c${n}`, type: "function", function: { name: "propose_payment", arguments: JSON.stringify({ payee: i.payee, amount_usd: i.amount, memo: i.invoice_number }) },
  }));
  return reply({ content: null, tool_calls });
}

before(async () => {
  process.env.META_API_BASE = META;
  process.env.META_API_KEY = "test";
  delete process.env.YEBO_MISSION_TOKEN;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).startsWith(META)) return new Response(JSON.stringify(fakeMeta(JSON.parse(String(init?.body)))), { status: 200 });
    return realFetch(url, init);
  }) as typeof fetch;
  gw = new JudgeGateway({ secret: "vendor-test", port: 0, autoApprove: true });
  process.env.YEBO_GATEWAY_URL = await gw.start();
  process.env.YEBO_HMAC_SECRET = "vendor-test";
});

beforeEach(() => delete process.env.YEBO_VENDORS);

after(async () => {
  globalThis.fetch = realFetch;
  delete process.env.YEBO_VENDORS;
  await gw.stop();
});

async function runBatch(): Promise<RunEvent[]> {
  const events: RunEvent[] = [];
  const sources = BATCH.map((i) => ({ name: i.file === "nimbus.pdf" ? "nimbus.pdf" : i.file, data: Buffer.from("fake") }));
  await runAgent({ goal: "Pay these invoices.", sources }, { mode: "judge", url: process.env.YEBO_GATEWAY_URL!, stop: async () => {} }, (e) => events.push(e));
  return events;
}

// "held" means the checks stopped it before Yebo; otherwise Yebo decided.
const outcome = (ev: RunEvent[]) => ev.flatMap((e) => (e.type === "decision" ? [`${e.proposal.payee} ${e.proposal.amount_usd} ${e.decision}${e.held ? " held" : ""}`] : []));

test("run without a vendor file: the duplicate is held, but unknown payees and accounts are paid", async () => {
  const ev = await runBatch();
  assert.equal((ev.find((e) => e.type === "started") as any).vendorCheck, false);
  const refused = ev.find((e) => e.type === "invoices_refused");
  assert.ok(refused && refused.type === "invoices_refused");
  assert.deepEqual(refused.rejected.map((r) => r.file), ["nimbus-again.png"]);
  assert.deepEqual(outcome(ev), [
    "Nimbus Cloud Hosting 89 ALLOW",
    "Nimbus Cloud Hosting 89 DENY held",
    "Brightleaf Design Studio 400 ALLOW",
    "Larkspur Linen Service 180 ALLOW",
    "Test Vendor Not On File 150 ALLOW",
  ]);
});

test("run with the vendor file: only invoices whose payee and account are on file are paid", async () => {
  process.env.YEBO_VENDORS = "demo/vendors.json";
  const ev = await runBatch();
  assert.equal((ev.find((e) => e.type === "started") as any).vendorCheck, true);
  const mission = ev.find((e) => e.type === "mission");
  assert.ok(mission && mission.type === "mission");
  assert.deepEqual(mission.limits.payees, ["Nimbus Cloud Hosting", "Brightleaf Design Studio"]);
  assert.equal(mission.limits.total_usd, 489);
  assert.deepEqual(outcome(ev), [
    "Nimbus Cloud Hosting 89 ALLOW",
    "Nimbus Cloud Hosting 89 DENY held",
    "Brightleaf Design Studio 400 ALLOW",
    "Larkspur Linen Service 180 DENY held",
    "Test Vendor Not On File 150 DENY held",
  ]);
  const denied = ev.flatMap((e) => (e.type === "decision" && e.decision === "DENY" ? [e.reason] : []));
  assert.match(denied[1]!, /account ending 0000 is not on file for Larkspur Linen Service/);
  assert.match(denied[2]!, /payee 'Test Vendor Not On File' is not on the vendor file/);
});

test("the duplicate is held whichever copy the agent proposes first, and Yebo never sees it", async () => {
  const ev = await runBatch();
  const held = ev.flatMap((e) => (e.type === "decision" && e.held ? [e] : []));
  assert.equal(held.length, 1);
  assert.equal(held[0].outcome, "held, not sent to Yebo");
  assert.equal(held[0].receipt, undefined);
  const mission = [...gw.missions.values()].at(-1)!;
  assert.equal(mission.spent_usd, 89 + 400 + 180 + 150, "the gateway only ever saw one Nimbus payment");
});

test("a broken vendor file stops the run before anything is paid", async () => {
  process.env.YEBO_VENDORS = "demo/no-such-vendors.json";
  const ev = await runBatch();
  assert.equal(ev.filter((e) => e.type === "decision").length, 0);
  const err = ev.find((e) => e.type === "error");
  assert.ok(err && err.type === "error");
  assert.match(err.message, /YEBO_VENDORS \(demo\/no-such-vendors.json\)/);
});
