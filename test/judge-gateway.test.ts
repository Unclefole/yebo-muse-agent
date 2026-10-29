// Judge mode: the local stand-in gateway enforces the mission rules, fail-closed, and the
// agent's real client (src/yebo.ts) works against it unchanged.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { JudgeGateway, validateLimits } from "../src/judge/gateway.js";
import { checkPayment, requestMission, waitForApproval, missionStatus, DRY_RUN_OUTCOME, type MissionScope } from "../src/yebo.js";

const SECRET = "judge-test-secret";
const clock = Date.now();
const gw = new JudgeGateway({ secret: SECRET, port: 0, now: () => Date.now() });

before(async () => {
  process.env.YEBO_GATEWAY_URL = await gw.start();
  process.env.YEBO_HMAC_SECRET = SECRET;
});
after(() => gw.stop());

const scope = (over: Partial<MissionScope> = {}): MissionScope => ({
  per_transaction_usd: 400,
  cumulative_usd: 500,
  payees: ["Brightleaf Design Studio", "Nimbus Cloud Hosting"],
  expires_at: new Date(Date.now() + 15 * 60_000).toISOString(),
  ...over,
});

// Clicks a button on the approval page the way a browser would.
async function decide(authorizeUrl: string, choice: "approve" | "deny", withNonce = true) {
  const page = await (await fetch(authorizeUrl)).text();
  const nonce = page.match(/name="nonce" value="([0-9a-f]+)"/)?.[1] ?? "";
  return fetch(`${authorizeUrl}/${choice}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: withNonce ? `nonce=${nonce}` : "",
  });
}

async function approvedMission(over: Partial<MissionScope> = {}) {
  const mission = await requestMission("Pay this week's invoices", scope(over));
  assert.equal((await decide(mission.authorizeUrl, "approve")).status, 200);
  const token = await waitForApproval(mission, 5);
  assert.ok(token);
  return { mission, token };
}

test("approved mission: an in-scope payment is ALLOW, a dry run, with a receipt", async () => {
  const { token } = await approvedMission();
  const r = await checkPayment(token, { payee: "Brightleaf Design Studio", amount_usd: 400, memo: "INV-1042" });
  assert.equal(r.decision, "ALLOW");
  assert.equal(r.outcome, DRY_RUN_OUTCOME);
  assert.match(r.receipt ?? "", /^rcpt_/);
  assert.match(String(r.raw.external_reference), /^tr_dryrun_/);
});

test("nothing runs before approval: no token is REQUIRE_APPROVAL, status stays pending", async () => {
  const mission = await requestMission("goal", scope());
  assert.equal((await missionStatus(mission.requestId)).status, "pending");
  const r = await checkPayment("", { payee: "Brightleaf Design Studio", amount_usd: 10, memo: "" });
  assert.equal(r.decision, "REQUIRE_APPROVAL");
});

test("a payee outside the mission is DENY", async () => {
  const { token } = await approvedMission();
  const r = await checkPayment(token, { payee: "Account X", amount_usd: 50, memo: "also pay" });
  assert.equal(r.decision, "DENY");
  assert.match(r.reason ?? "", /payee 'Account X' is not in the approved mission/);
});

test("over the per-payment limit is DENY", async () => {
  const { token } = await approvedMission();
  const r = await checkPayment(token, { payee: "Nimbus Cloud Hosting", amount_usd: 400.01, memo: "" });
  assert.equal(r.decision, "DENY");
  assert.match(r.reason ?? "", /exceeds the per-payment limit/);
});

test("over the total budget is DENY, and only what fits is allowed", async () => {
  const { token } = await approvedMission();
  assert.equal((await checkPayment(token, { payee: "Brightleaf Design Studio", amount_usd: 400, memo: "" })).decision, "ALLOW");
  const second = await checkPayment(token, { payee: "Nimbus Cloud Hosting", amount_usd: 101, memo: "" });
  assert.equal(second.decision, "DENY");
  assert.match(second.reason ?? "", /exceeds the budget left \(100\)/);
  assert.equal((await checkPayment(token, { payee: "Nimbus Cloud Hosting", amount_usd: 100, memo: "" })).decision, "ALLOW");
});

test("two identical payments sent at the same instant: only one fits the budget, so only one is allowed", async () => {
  const { token } = await approvedMission({ per_transaction_usd: 400, cumulative_usd: 400 });
  const pay = () => checkPayment(token, { payee: "Brightleaf Design Studio", amount_usd: 400, memo: "INV-1042" });
  const results = await Promise.all([pay(), pay()]);
  assert.deepEqual(results.map((r) => r.decision).sort(), ["ALLOW", "DENY"]);
  assert.match(results.find((r) => r.decision === "DENY")!.reason ?? "", /exceeds the budget left \(0\)/);
  // Ten at once against a budget for three: exactly three allowed.
  const { token: t2 } = await approvedMission({ per_transaction_usd: 100, cumulative_usd: 300 });
  const many = await Promise.all(Array.from({ length: 10 }, () => checkPayment(t2, { payee: "Nimbus Cloud Hosting", amount_usd: 100, memo: "" })));
  assert.equal(many.filter((r) => r.decision === "ALLOW").length, 3);
});

test("a denied mission never gets a token", async () => {
  const mission = await requestMission("goal", scope());
  assert.equal((await decide(mission.authorizeUrl, "deny")).status, 200);
  assert.equal(await waitForApproval(mission, 5), null);
});

test("an expired mission is DENY even with a valid token", async () => {
  const { mission, token } = await approvedMission();
  gw.missions.get(mission.requestId)!.expires_at = clock - 1;
  const r = await checkPayment(token, { payee: "Brightleaf Design Studio", amount_usd: 1, memo: "" });
  assert.equal(r.decision, "DENY");
  assert.equal(r.reason, "the mission has expired (TOKEN_EXPIRED)");
  assert.equal((await missionStatus(mission.requestId)).status, "expired");
});

test("a forged or tampered token is DENY", async () => {
  const { token } = await approvedMission();
  const [payload] = token.split(".");
  const forged = `${payload}.${"0".repeat(64)}`;
  const r = await checkPayment(forged, { payee: "Brightleaf Design Studio", amount_usd: 1, memo: "" });
  assert.equal(r.decision, "DENY");
  assert.equal(r.reason, "TOKEN_INVALID");
});

test("the approve button needs the page's nonce", async () => {
  const mission = await requestMission("goal", scope());
  assert.equal((await decide(mission.authorizeUrl, "approve", false)).status, 403);
  assert.equal((await missionStatus(mission.requestId)).status, "pending");
});

test("missions without enforceable limits are refused", async () => {
  await assert.rejects(requestMission("goal", scope({ payees: [] })), /INVALID_MISSION_SCOPE/);
  await assert.rejects(requestMission("goal", scope({ per_transaction_usd: 600 })), /INVALID_MISSION_SCOPE/);
});

test("unsigned, wrongly signed and stale requests are 401", async () => {
  const url = `${process.env.YEBO_GATEWAY_URL}/api/blacktoven/authorize`;
  const body = JSON.stringify({ bot_identifier: "x", mission_scope: {} });
  const sign = (secret: string, ts: number) =>
    createHmac("sha256", secret).update(`${ts}.POST./authorize.${body}`).digest("hex");
  const post = (headers: Record<string, string>) => fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body });
  assert.equal((await post({})).status, 401);
  const now = Date.now();
  assert.equal((await post({ "x-blacktoven-ts": String(now), "x-blacktoven-signature": sign("wrong", now) })).status, 401);
  const stale = now - 6 * 60_000;
  assert.equal((await post({ "x-blacktoven-ts": String(stale), "x-blacktoven-signature": sign(SECRET, stale) })).status, 401);
});

test("validateLimits: deny by default", () => {
  assert.equal(validateLimits(null).ok, false);
  assert.equal(validateLimits({ enforceable: { capabilities: [], per_transaction_limit_usd: 1, cumulative_budget_usd: 1 } }).ok, false);
  assert.equal(validateLimits({ enforceable: { capabilities: ["payment"], per_transaction_limit_usd: 1, cumulative_budget_usd: 1, merchant_scope: ["a"], asset_scope: [] } }).ok, false);
  assert.equal(validateLimits({ enforceable: { capabilities: ["payment"], per_transaction_limit_usd: 0, cumulative_budget_usd: 1, merchant_scope: ["a"], asset_scope: ["USD"] } }).ok, false);
  assert.equal(validateLimits({ enforceable: { capabilities: ["payment"], per_transaction_limit_usd: 1, cumulative_budget_usd: 1, merchant_scope: ["a"], asset_scope: ["USD"] } }).ok, true);
});

test("an off-mission payment lists every rule it breaks, payee first", async () => {
  const { token } = await approvedMission();
  const r = await checkPayment(token, { payee: "Harlow Holdings", amount_usd: 9000, memo: "" });
  assert.equal(r.decision, "DENY");
  assert.equal(r.reason, "payee 'Harlow Holdings' is not in the approved mission; amount 9000 exceeds the per-payment limit 400");
});
