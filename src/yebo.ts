// Yebo gateway client. This project talks to gateway.yebo.dev over HTTPS like any customer.
// The gateway's source code is NOT part of this repository.
//
// Flow:
//   1. requestMission()  agent asks for limits (who, how much, until when)
//   2. a human approves those limits with a passkey at yebo.dev/authorize/<id>
//   3. checkPayment()    every single payment is checked against the approved limits
//
// TODO(confirm): exact route names, payload fields and the signature scheme against the
// current gateway before the demo. Nothing here moves real money (dry run).

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

const gateway = () => process.env.YEBO_GATEWAY_URL ?? "https://gateway.yebo.dev";

function signedHeaders(body: string): Record<string, string> {
  const secret = process.env.YEBO_AGENT_SECRET;
  if (!secret) throw new Error("YEBO_AGENT_SECRET is not set");
  const signature = createHmac("sha256", secret).update(body).digest("hex");
  return { "Content-Type": "application/json", "x-agent-signature": signature };
}

async function post(path: string, payload: unknown) {
  const body = JSON.stringify(payload);
  const res = await fetch(`${gateway()}${path}`, { method: "POST", headers: signedHeaders(body), body });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

export async function requestMission(goal: string, scope: MissionScope) {
  // TODO(confirm): route and fields
  return post("/api/agent/authorize", { goal, mission_scope: scope });
}

export async function checkPayment(missionToken: string, proposal: PaymentProposal) {
  // TODO(confirm): route and fields
  const { status, data } = await post("/api/agent/execute", { token: missionToken, action: proposal, dry_run: true });
  // Fail closed: anything we cannot read as ALLOW is treated as DENY.
  const decision: Decision = data?.decision === "ALLOW" || data?.decision === "REQUIRE_APPROVAL" ? data.decision : "DENY";
  return { status, decision, receipt: data?.receipt_id as string | undefined, raw: data };
}
