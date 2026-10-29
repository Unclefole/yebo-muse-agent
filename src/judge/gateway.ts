// Judge mode: a local stand-in for the Yebo gateway so anyone can clone this repo and run
// it with only a Meta API key. It is NOT Yebo. It was written for this repo and shares no
// code with the real gateway; it speaks the same signed protocol and enforces the same
// mission rules, so the agent's client code (src/yebo.ts) is identical in both modes.
//
// Rules, all fail-closed (anything unexpected is refused):
//   - every API call is signed: hex HMAC-SHA256 over `${ts}.${METHOD}.${path}.${body}`,
//     timestamp within 5 minutes
//   - a mission must carry enforceable limits: capabilities, per-payment limit, total
//     budget, and for payments a non-empty payee list and currency list
//   - a mission lasts 1 to 60 minutes and needs a human approval before anything runs
//   - each payment must be in an approved, unexpired mission, for an allowed capability,
//     to a listed payee, in a listed currency, within the per-payment limit and within
//     what is left of the total budget
// Approval is simulated on a local web page (no passkey) and every payment is a dry run.

import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { approvalPage, resultPage } from "./pages.js";

export type Limits = {
  capabilities: string[];
  per_transaction_limit_usd: number;
  cumulative_budget_usd: number;
  merchant_scope: string[];
  asset_scope: string[];
};

export type JudgeMission = {
  id: string;
  bot_identifier: string;
  objective: string | null;
  limits: Limits;
  status: "pending" | "approved" | "denied" | "expired";
  expires_at: number;
  spent_usd: number;
  approval_nonce: string; // must come back with the approve/deny form, so other sites cannot submit it
  token?: string;
};

export type JudgeOptions = {
  secret: string;
  port?: number; // 0 picks a free port
  autoApprove?: boolean; // tests only: approve every mission as soon as it is created
  now?: () => number;
};

const API = "/api/blacktoven";
const MAX_SKEW_MS = 5 * 60_000;
const TTL_MIN_MS = 60_000;
const TTL_MAX_MS = 60 * 60_000;
const TTL_DEFAULT_MS = 10 * 60_000;
const MAX_BODY_BYTES = 64 * 1024;

const isPayment = (capability: string) => /^payment(\.|$)/i.test(capability);
const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string" && x.length > 0);
const money = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;

// Returns the limits, or the reasons they are not enforceable.
export function validateLimits(scope: unknown): { ok: true; limits: Limits } | { ok: false; errors: string[] } {
  const en = (scope as { enforceable?: unknown } | null)?.enforceable as Record<string, unknown> | undefined;
  if (!en || typeof en !== "object") return { ok: false, errors: ["mission_scope.enforceable is required"] };
  const errors: string[] = [];
  const { capabilities, per_transaction_limit_usd: perTx, cumulative_budget_usd: total } = en;
  const merchants = en.merchant_scope ?? [];
  const assets = en.asset_scope ?? [];
  if (!strings(capabilities) || capabilities.length === 0) errors.push("capabilities must be a non-empty list");
  if (!money(perTx)) errors.push("per_transaction_limit_usd must be a number >= 0");
  if (!money(total)) errors.push("cumulative_budget_usd must be a number >= 0");
  if (money(perTx) && money(total) && perTx > total) errors.push("per_transaction_limit_usd cannot exceed cumulative_budget_usd");
  if (!strings(merchants)) errors.push("merchant_scope must be a list of names");
  if (!strings(assets)) errors.push("asset_scope must be a list of currency codes");
  if (strings(capabilities) && capabilities.some(isPayment)) {
    if (!strings(merchants) || merchants.length === 0) errors.push("payments need a non-empty merchant_scope (payees)");
    if (!strings(assets) || assets.length === 0) errors.push("payments need a non-empty asset_scope (currencies)");
    if (!(money(perTx) && perTx > 0) || !(money(total) && total > 0)) errors.push("payments need limits above zero");
  }
  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    limits: {
      capabilities: capabilities as string[],
      per_transaction_limit_usd: perTx as number,
      cumulative_budget_usd: total as number,
      merchant_scope: merchants as string[],
      asset_scope: assets as string[],
    },
  };
}

// Why one payment is not allowed under these limits, or null if it is.
export function paymentRefusal(m: JudgeMission, action: Record<string, unknown>): { status: number; error: string; reason: string } | null {
  const { capability, amount, merchant, asset } = action;
  if (typeof capability !== "string" || !m.limits.capabilities.includes(capability)) {
    return { status: 403, error: "OUT_OF_SCOPE", reason: `capability '${String(capability)}' is not in the approved mission` };
  }
  if (!money(amount) || amount === 0) return { status: 400, error: "INVALID_AMOUNT", reason: "amount must be a number above zero" };
  // Every scope rule the payment breaks, payee first, so the reason tells the whole story.
  const outOfScope: string[] = [];
  if (m.limits.merchant_scope.length > 0 && (typeof merchant !== "string" || !m.limits.merchant_scope.includes(merchant))) {
    outOfScope.push(`payee '${String(merchant ?? "")}' is not in the approved mission`);
  }
  if (amount > m.limits.per_transaction_limit_usd) {
    outOfScope.push(`amount ${amount} exceeds the per-payment limit ${m.limits.per_transaction_limit_usd}`);
  }
  if (m.limits.asset_scope.length > 0 && (typeof asset !== "string" || !m.limits.asset_scope.includes(asset))) {
    outOfScope.push(`currency '${String(asset ?? "")}' is not in the approved mission`);
  }
  if (outOfScope.length) return { status: 403, error: "OUT_OF_SCOPE", reason: outOfScope.join("; ") };
  const left = m.limits.cumulative_budget_usd - m.spent_usd;
  if (amount > left + 1e-9) {
    return { status: 402, error: "BUDGET_EXHAUSTED", reason: `amount ${amount} exceeds the budget left (${Math.max(0, Math.round(left * 100) / 100)})` };
  }
  return null;
}

// One allowed payment (a dry run), for tests that count what was allowed.
export type JudgeExecution = { mission_id: string; merchant: string; amount: number; asset: string; receipt_id: string };

export class JudgeGateway {
  readonly missions = new Map<string, JudgeMission>();
  readonly executions: JudgeExecution[] = [];
  private server?: Server;
  private readonly tokenKey = randomBytes(32); // signs mission tokens; never leaves this process
  private readonly now: () => number;
  url = "";

  constructor(private readonly opts: JudgeOptions) {
    if (!opts.secret) throw new Error("judge gateway needs a secret");
    this.now = opts.now ?? Date.now;
  }

  async start(): Promise<string> {
    this.server = createServer((req, res) => {
      this.handle(req, res).catch(() => send(res, 500, { error: "INTERNAL", message: "judge gateway error" }));
    });
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(this.opts.port ?? 0, "127.0.0.1", resolve);
    });
    this.url = `http://127.0.0.1:${(this.server!.address() as AddressInfo).port}`;
    return this.url;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }

  private mission(id: string): JudgeMission | undefined {
    const m = this.missions.get(id);
    if (m && m.status !== "expired" && m.expires_at <= this.now()) m.status = "expired";
    return m;
  }

  private signToken(missionId: string): string {
    const payload = Buffer.from(JSON.stringify({ mission_id: missionId, nonce: randomUUID() })).toString("base64url");
    return `${payload}.${createHmac("sha256", this.tokenKey).update(payload).digest("hex")}`;
  }

  private tokenMission(token: unknown): string | null {
    if (typeof token !== "string") return null;
    const [payload, sig] = token.split(".");
    if (!payload || !sig || token.split(".").length !== 2) return null;
    const expected = createHmac("sha256", this.tokenKey).update(payload).digest("hex");
    if (!safeEqualHex(expected, sig)) return null;
    try {
      const id = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")).mission_id;
      return typeof id === "string" ? id : null;
    } catch {
      return null;
    }
  }

  private approve(m: JudgeMission): void {
    m.status = "approved";
    m.token = this.signToken(m.id);
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://judge.local");
    const raw = await readBody(req);
    if (raw === null) return send(res, 413, { error: "BODY_TOO_LARGE" });

    // Human side: the approval page (simulated approval, no passkey).
    const page = url.pathname.match(/^\/authorize\/([0-9a-f-]{36})(?:\/(approve|deny))?$/);
    if (page) {
      const m = this.mission(page[1]);
      if (!m) return html(res, 404, resultPage("Mission not found", "This mission does not exist."));
      if (req.method === "GET" && !page[2]) return html(res, 200, approvalPage(m, this.now()));
      if (req.method === "POST" && page[2]) {
        const nonce = new URLSearchParams(raw).get("nonce") ?? "";
        if (!safeEqualHex(Buffer.from(m.approval_nonce).toString("hex"), Buffer.from(nonce).toString("hex"))) {
          return html(res, 403, resultPage("Not allowed", "Open the approval link again and use its buttons."));
        }
        if (m.status !== "pending") return html(res, 409, resultPage(`Already ${m.status}`, "This mission was already resolved."));
        const approved = page[2] === "approve";
        if (approved) this.approve(m);
        else m.status = "denied";
        return html(res, 200, resultPage(approved ? "Mission approved (judge mode)" : "Mission denied",
          approved
            ? `${m.bot_identifier} can now run within these limits. Dry run: no money moves.`
            : `${m.bot_identifier} will not run this mission.`));
      }
      return send(res, 405, { error: "METHOD_NOT_ALLOWED" });
    }

    if (!url.pathname.startsWith(`${API}/`)) return send(res, 404, { error: "NOT_FOUND" });
    const path = url.pathname.slice(API.length);

    // Agent side: every call must be signed.
    let body: Record<string, unknown> = {};
    if (raw.length) {
      try {
        body = JSON.parse(raw);
      } catch {
        return send(res, 400, { error: "BAD_JSON" });
      }
      if (typeof body !== "object" || body === null || Array.isArray(body)) return send(res, 400, { error: "BAD_REQUEST" });
    }
    const ts = Number(req.headers["x-blacktoven-ts"]);
    if (!Number.isFinite(ts) || Math.abs(this.now() - ts) > MAX_SKEW_MS) return send(res, 401, { error: "INVALID_TIMESTAMP" });
    const canonical = `${ts}.${req.method}.${path}.${Object.keys(body).length ? JSON.stringify(body) : ""}`;
    const expected = createHmac("sha256", this.opts.secret).update(canonical).digest("hex");
    if (!safeEqualHex(expected, String(req.headers["x-blacktoven-signature"] ?? ""))) return send(res, 401, { error: "INVALID_HMAC" });

    if (req.method === "POST" && path === "/authorize") return this.authorize(res, body);
    const status = path.match(/^\/authorize\/([^/]+)\/status$/);
    if (req.method === "GET" && status) {
      const m = this.mission(status[1]);
      if (!m) return send(res, 404, { error: "NOT_FOUND" });
      return send(res, 200, {
        ok: true,
        status: m.status,
        expiresAt: new Date(m.expires_at).toISOString(),
        ...(m.status === "approved" ? { signedToken: m.token } : {}),
      });
    }
    if (req.method === "POST" && path === "/execute") return this.execute(res, body);
    return send(res, 404, { error: "NOT_FOUND" });
  }

  private authorize(res: ServerResponse, body: Record<string, unknown>): void {
    if (typeof body.bot_identifier !== "string" || !body.bot_identifier.trim() || body.bot_identifier.length > 128) {
      return send(res, 400, { error: "BAD_REQUEST", message: "bot_identifier required" });
    }
    const check = validateLimits(body.mission_scope);
    if (!check.ok) return send(res, 400, { error: "INVALID_MISSION_SCOPE", errors: check.errors });
    const ttlRaw = typeof body.ttl_ms === "number" && Number.isFinite(body.ttl_ms) ? body.ttl_ms : TTL_DEFAULT_MS;
    const ttl = Math.min(Math.max(ttlRaw, TTL_MIN_MS), TTL_MAX_MS);
    const objective = (body.mission_scope as { objective?: unknown }).objective;
    const m: JudgeMission = {
      id: randomUUID(),
      bot_identifier: body.bot_identifier.trim(),
      objective: typeof objective === "string" ? objective.slice(0, 500) : null,
      limits: check.limits,
      status: "pending",
      expires_at: this.now() + ttl,
      spent_usd: 0,
      approval_nonce: randomBytes(16).toString("hex"),
    };
    this.missions.set(m.id, m);
    if (this.opts.autoApprove) this.approve(m);
    send(res, 201, {
      ok: true,
      requestId: m.id,
      authorizeUrl: `${this.url}/authorize/${m.id}`,
      expiresAt: new Date(m.expires_at).toISOString(),
      requiredApprovals: 1,
    });
  }

  private execute(res: ServerResponse, body: Record<string, unknown>): void {
    const action = body.action;
    if (typeof body.token !== "string" || !action || typeof action !== "object") {
      return send(res, 400, { error: "BAD_REQUEST", message: "token + action required" });
    }
    const missionId = this.tokenMission(body.token);
    if (!missionId) return send(res, 401, { error: "TOKEN_INVALID" });
    const m = this.mission(missionId);
    if (!m) return send(res, 404, { error: "MISSION_NOT_FOUND" });
    if (m.status === "expired") return send(res, 401, { error: "TOKEN_EXPIRED" });
    if (m.status !== "approved" || m.token !== body.token) return send(res, 403, { error: "TOKEN_NOT_ACTIVE", status: m.status });

    const refusal = paymentRefusal(m, action as Record<string, unknown>);
    if (refusal) return send(res, refusal.status, { error: refusal.error, reason: refusal.reason });

    const amount = (action as { amount: number }).amount;
    m.spent_usd = Math.round((m.spent_usd + amount) * 100) / 100;
    const receiptId = `rcpt_${randomUUID()}`;
    const { merchant, asset } = action as { merchant: string; asset: string };
    this.executions.push({ mission_id: m.id, merchant, amount, asset, receipt_id: receiptId });
    send(res, 200, {
      ok: true,
      decision: "allow",
      executed: true, // same field as the real gateway; in judge mode nothing ever runs
      dry_run: true,
      mission_id: m.id,
      capability: (action as { capability: string }).capability,
      external_reference: `tr_dryrun_${receiptId.slice(5)}`,
      receipt_id: receiptId,
      budget_remaining: Math.round((m.limits.cumulative_budget_usd - m.spent_usd) * 100) / 100,
    });
  }
}

function safeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length || !/^[0-9a-f]+$/.test(b)) return false;
  return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
}

function readBody(req: IncomingMessage): Promise<string | null> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        resolve(null);
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function send(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) return;
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function html(res: ServerResponse, status: number, page: string): void {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8" });
  res.end(page);
}
