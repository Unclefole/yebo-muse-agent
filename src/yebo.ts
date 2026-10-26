// Yebo gateway client. This project talks to gateway.yebo.dev over HTTPS like any customer.
// The gateway's source code is NOT part of this repository.
//
// Mission flow:
//   1. requestMission()   POST /api/blacktoven/authorize  the agent asks for limits
//                         (payees, per payment ceiling, total budget, expiry)
//   2. waitForApproval()  a human approves those limits with a passkey at
//                         yebo.dev/authorize/<id>; we poll
//                         GET /api/blacktoven/authorize/<id>/status until a signed
//                         mission token comes back
//   3. checkPayment()     POST /api/blacktoven/execute  every payment is checked
//                         against the approved limits; only an in-scope payment runs
//
// Dry run: the gateway decides whether money really moves, and it stays in dry run
// unless the gateway itself is switched live. This client never asks for live
// execution, and it stops the moment a result comes back that is not a dry run.

import { createHmac } from "node:crypto";

export type Decision = "ALLOW" | "DENY" | "REQUIRE_APPROVAL";

export type PaymentProposal = {
  payee: string;
  amount_usd: number;
  memo: string;
};

export type MissionScope = {
  per_transaction_usd: number;
  cumulative_usd: number;
  payees: string[];
  expires_at: string; // ISO date
};

export type Mission = {
  requestId: string;
  authorizeUrl: string;
  expiresAt: string;
  requiredApprovals: number;
};

export type MissionStatus = "pending" | "approved" | "denied" | "expired" | "revoked";

const BASE_PATH = "/api/blacktoven";
const PAYMENT_CAPABILITY = "payment";
const CURRENCY = "USD";
const TTL_MIN_MS = 60_000; // the gateway clamps ttl to [1 min, 1 h]
const TTL_MAX_MS = 60 * 60_000;
const DRY_RUN_REFERENCE_PREFIX = "pi_dryrun_";

const gateway = () => process.env.YEBO_GATEWAY_URL ?? "https://gateway.yebo.dev";
const botIdentifier = () => process.env.YEBO_BOT_IDENTIFIER ?? "yebo-muse-agent";

// Signed request: hex HMAC-SHA256 over `${ts}.${METHOD}.${path}.${body}`, where path is
// relative to /api/blacktoven and body is "" when there is none.
function signedHeaders(method: string, path: string, body: string): Record<string, string> {
  const secret = process.env.YEBO_HMAC_SECRET;
  if (!secret) throw new Error("YEBO_HMAC_SECRET is not set");
  const ts = String(Date.now());
  const signature = createHmac("sha256", secret).update(`${ts}.${method}.${path}.${body}`).digest("hex");
  return {
    ...(body ? { "Content-Type": "application/json" } : {}),
    "x-blacktoven-ts": ts,
    "x-blacktoven-signature": signature,
  };
}

async function call(method: "GET" | "POST", path: string, payload?: unknown) {
  const body = payload === undefined ? "" : JSON.stringify(payload);
  const res = await fetch(`${gateway()}${BASE_PATH}${path}`, {
    method,
    headers: signedHeaders(method, path, body),
    ...(body ? { body } : {}),
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

export async function requestMission(goal: string, scope: MissionScope): Promise<Mission> {
  const ttl = Date.parse(scope.expires_at) - Date.now();
  const { status, data } = await call("POST", "/authorize", {
    bot_identifier: botIdentifier(),
    mission_scope: {
      objective: goal,
      enforceable: {
        capabilities: [PAYMENT_CAPABILITY],
        per_transaction_limit_usd: scope.per_transaction_usd,
        cumulative_budget_usd: scope.cumulative_usd,
        merchant_scope: scope.payees,
        asset_scope: [CURRENCY],
      },
    },
    ttl_ms: Math.min(Math.max(Number.isFinite(ttl) ? ttl : TTL_MIN_MS, TTL_MIN_MS), TTL_MAX_MS),
  });
  if (status !== 201 || !data?.requestId) {
    const detail = data?.errors ? ` ${JSON.stringify(data.errors)}` : "";
    throw new Error(`Yebo authorize failed (${status}): ${data?.error ?? "unknown"}${detail}`);
  }
  return {
    requestId: data.requestId,
    authorizeUrl: data.authorizeUrl,
    expiresAt: data.expiresAt,
    requiredApprovals: data.requiredApprovals ?? 1,
  };
}

export async function missionStatus(requestId: string): Promise<{ status: MissionStatus; token?: string }> {
  const { status, data } = await call("GET", `/authorize/${encodeURIComponent(requestId)}/status`);
  if (status !== 200) throw new Error(`Yebo status failed (${status}): ${data?.error ?? "unknown"}`);
  return { status: data.status, token: data.signedToken };
}

// Polls until the human approves (returns the mission token) or the mission ends.
// Returns null when it was denied, expired or revoked: nothing may run.
export async function waitForApproval(mission: Mission, pollMs = 3_000): Promise<string | null> {
  const deadline = Date.parse(mission.expiresAt);
  while (Date.now() < deadline) {
    const { status, token } = await missionStatus(mission.requestId);
    if (status === "approved" && token) return token;
    if (status !== "pending") return null;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  return null;
}

export async function checkPayment(missionToken: string, proposal: PaymentProposal) {
  if (!missionToken) {
    return { status: 0, decision: "REQUIRE_APPROVAL" as Decision, reason: "no approved mission", raw: {} };
  }
  const { status, data } = await call("POST", "/execute", {
    token: missionToken,
    action: { capability: PAYMENT_CAPABILITY, amount: proposal.amount_usd, merchant: proposal.payee, asset: CURRENCY },
  });
  // Fail closed: anything we cannot read as an allowed, executed payment is a DENY.
  const allowed = status === 200 && data?.decision === "allow" && data?.executed === true;
  if (allowed && !String(data.external_reference ?? "").startsWith(DRY_RUN_REFERENCE_PREFIX)) {
    throw new Error(`Yebo ran a payment that was not a dry run (${data.external_reference}). Stopping.`);
  }
  const decision: Decision = allowed ? "ALLOW" : "DENY";
  return {
    status,
    decision,
    reason: allowed ? undefined : ((data?.reason ?? data?.error ?? `gateway returned ${status}`) as string),
    receipt: data?.receipt_id as string | undefined,
    raw: data,
  };
}
