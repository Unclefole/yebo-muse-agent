// Judge mode: a local stand-in for the Yebo gateway so anyone can clone this repo and run
// it with only a Meta API key. It is NOT Yebo. It was written for this repo and shares no
// code with the real gateway; it speaks the same signed protocol and enforces the same
// mission rules, so the agent's client code (src/yebo.ts) is identical in both modes.
//
// Rules, all fail-closed (anything unexpected is refused):
//   - every API call is signed: hex HMAC-SHA256 over `${ts}.${METHOD}.${path}.${body}`,
//     timestamp within 5 minutes; a body that names a key twice is refused
//   - a payment carries only capability, amount, payee and currency; any other field
//     (recurring, fee, order or idempotency key) is refused, never silently ignored
//   - a mission must carry enforceable limits: capabilities, per-payment limit, total
//     budget, and for payments a non-empty payee list and currency list
//   - a mission lasts 1 to 60 minutes and needs a human approval before anything runs; the
//     human can revoke it from the same page, and its token stops working at once
//   - each payment must be in an approved, unexpired mission, for an allowed capability,
//     to a listed payee, in a listed currency, within the per-payment limit and within
//     what is left of the total budget
//   - exact-order mode (optional, per mission): a mission that carries an invoice list pays
//     only those invoices, each line once and for its exact amount; the rules above must
//     pass as well. A mission without a list stays a cap, as on the live gateway today.
// Approval is simulated on a local web page (no passkey) and every payment is a dry run.

import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { approvalPage, resultPage } from "./pages.js";
import { DuplicateKeyError, parseStrict } from "../json.js";

// One approved invoice in exact-order mode. Built by trusted code, shown to the human.
export type OrderLine = { invoice_number: string; payee: string; account: string; amount_usd: number; currency: string };

export type Limits = {
  capabilities: string[];
  per_transaction_limit_usd: number;
  cumulative_budget_usd: number;
  merchant_scope: string[];
  asset_scope: string[];
  order_lines?: OrderLine[]; // present: exact-order mode
};

export type JudgeMission = {
  id: string;
  bot_identifier: string;
  objective: string | null;
  limits: Limits;
  status: "pending" | "approved" | "denied" | "expired" | "revoked";
  expires_at: number;
  spent_usd: number;
  paid_lines: Set<string>; // exact-order mode: the lines already paid
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
const EXECUTE_FIELDS = new Set(["token", "action"]);
const ACTION_FIELDS = new Set(["capability", "amount", "merchant", "asset"]);
const EXACT_ACTION_FIELDS = new Set([...ACTION_FIELDS, "invoice_number", "account"]);
const LINE_FIELDS = ["invoice_number", "payee", "account", "amount_usd", "currency"];

const isPayment = (capability: string) => /^payment(\.|$)/i.test(capability);
const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string" && x.length > 0);
const money = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;

const lineKey = (payee: string, invoiceNumber: string) => JSON.stringify([payee, invoiceNumber]);

// Why an invoice list cannot be enforced under these limits. A list that is present but
// unusable is refused, never treated as "no list", so a mission cannot fall back to a cap.
function orderLineErrors(lines: unknown, perTx: number, total: number, merchants: string[], assets: string[]): string[] {
  if (!Array.isArray(lines) || lines.length === 0) return ["order_lines must be a non-empty list"];
  const errors: string[] = [];
  const seen = new Set<string>();
  let sum = 0;
  lines.forEach((raw, i) => {
    const l = raw as Partial<OrderLine> | null;
    const at = `order_lines[${i}]`;
    if (!l || typeof l !== "object" || Object.keys(l).some((k) => !LINE_FIELDS.includes(k))) return errors.push(`${at} must have only ${LINE_FIELDS.join(", ")}`);
    const { invoice_number: number, payee, account, amount_usd: amount, currency } = l;
    if (typeof number !== "string" || !number.trim()) errors.push(`${at} needs an invoice_number`);
    if (typeof payee !== "string" || !merchants.includes(payee)) errors.push(`${at} payee must be in merchant_scope`);
    if (typeof account !== "string" || !/^\d{4}$/.test(account)) errors.push(`${at} account must be the last 4 digits`);
    if (!money(amount) || amount === 0 || Math.round(amount * 100) / 100 !== amount) errors.push(`${at} amount_usd must be above zero, in whole cents`);
    else {
      sum += amount;
      if (amount > perTx) errors.push(`${at} amount_usd exceeds per_transaction_limit_usd`);
    }
    if (typeof currency !== "string" || !assets.includes(currency)) errors.push(`${at} currency must be in asset_scope`);
    const key = lineKey(String(payee), String(number));
    if (seen.has(key)) errors.push(`${at} repeats invoice ${String(number)} for ${String(payee)}`);
    seen.add(key);
  });
  if (sum > total + 1e-9) errors.push("order_lines add up to more than cumulative_budget_usd");
  return errors;
}

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
  const hasList = en.order_lines !== undefined;
  if (hasList && !errors.length) errors.push(...orderLineErrors(en.order_lines, perTx as number, total as number, merchants as string[], assets as string[]));
  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    limits: {
      capabilities: capabilities as string[],
      per_transaction_limit_usd: perTx as number,
      cumulative_budget_usd: total as number,
      merchant_scope: merchants as string[],
      asset_scope: assets as string[],
      ...(hasList ? { order_lines: en.order_lines as OrderLine[] } : {}),
    },
  };
}

// Exact-order mode: why this payment is not one approved invoice line, or null if it is. The
// cap rules in paymentRefusal still apply afterwards: both must pass.
export function orderRefusal(m: JudgeMission, action: Record<string, unknown>): { status: number; error: string; reason: string } | null {
  const { invoice_number: number, merchant, account, asset, amount } = action;
  const notApproved = (why: string) => ({ status: 403, error: "NOT_APPROVED_INVOICE", reason: `not an approved invoice: ${why}` });
  if (typeof number !== "string" || !number) return notApproved("the payment names no invoice");
  const line = m.limits.order_lines?.find((l) => l.invoice_number === number && l.payee === merchant);
  if (!line) return notApproved(`${String(merchant ?? "")} has no approved invoice ${number}`);
  if (account !== line.account) return notApproved(`account '${String(account ?? "")}' does not match invoice ${number}`);
  if (asset !== line.currency) return notApproved(`currency '${String(asset ?? "")}' does not match invoice ${number}`);
  if (m.paid_lines.has(lineKey(line.payee, line.invoice_number))) return { status: 409, error: "INVOICE_ALREADY_PAID", reason: `invoice already paid: ${number}` };
  if (amount !== line.amount_usd) return { status: 403, error: "AMOUNT_MISMATCH", reason: `amount does not match invoice: ${number} is ${line.amount_usd}, not ${String(amount)}` };
  return null;
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
export type JudgeExecution = { mission_id: string; merchant: string; amount: number; asset: string; receipt_id: string; invoice_number?: string };

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

  private revoke(m: JudgeMission): void {
    m.status = "revoked";
    m.token = undefined;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://judge.local");
    const raw = await readBody(req);
    if (raw === null) return send(res, 413, { error: "BODY_TOO_LARGE" });

    // Human side: the approval page (simulated approval, no passkey).
    const page = url.pathname.match(/^\/authorize\/([0-9a-f-]{36})(?:\/(approve|deny|revoke))?$/);
    if (page) {
      const m = this.mission(page[1]);
      if (!m) return html(res, 404, resultPage("Mission not found", "This mission does not exist."));
      if (req.method === "GET" && !page[2]) return html(res, 200, approvalPage(m, this.now()));
      if (req.method === "POST" && page[2]) {
        const nonce = new URLSearchParams(raw).get("nonce") ?? "";
        if (!safeEqualHex(Buffer.from(m.approval_nonce).toString("hex"), Buffer.from(nonce).toString("hex"))) {
          return html(res, 403, resultPage("Not allowed", "Open the approval link again and use its buttons."));
        }
        // Revoking takes back an approval: the mission token stops working at once, for every
        // payment not yet decided.
        if (page[2] === "revoke") {
          if (m.status !== "approved") return html(res, 409, resultPage(`Mission ${m.status}`, "Only an approved mission can be revoked."));
          this.revoke(m);
          return html(res, 200, resultPage("Mission revoked (judge mode)", `${m.bot_identifier} can no longer make payments under this mission.`));
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
        body = parseStrict(raw) as Record<string, unknown>;
      } catch (err) {
        if (err instanceof DuplicateKeyError) return send(res, 400, { error: "DUPLICATE_KEY", message: err.message });
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
      paid_lines: new Set(),
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
    // Only the fields the gateway enforces. Anything else (recurring, a fee, an order or
    // idempotency key, a note) would look like a promise the gateway does not keep.
    const unknownFields = (allowed: Set<string>) => [...Object.keys(body).filter((k) => !EXECUTE_FIELDS.has(k)), ...Object.keys(action).filter((k) => !allowed.has(k)).map((k) => `action.${k}`)];
    const refuseExtra = (extra: string[]) => send(res, 400, { error: "UNKNOWN_FIELD", message: `not supported: ${extra.join(", ")}` });
    if (unknownFields(EXACT_ACTION_FIELDS).length) return refuseExtra(unknownFields(EXACT_ACTION_FIELDS));
    const missionId = this.tokenMission(body.token);
    if (!missionId) return send(res, 401, { error: "TOKEN_INVALID" });
    const m = this.mission(missionId);
    if (!m) return send(res, 404, { error: "MISSION_NOT_FOUND" });
    if (m.status === "expired") return send(res, 401, { error: "TOKEN_EXPIRED" });
    if (m.status !== "approved" || m.token !== body.token) return send(res, 403, { error: "TOKEN_NOT_ACTIVE", status: m.status });

    // The invoice fields mean something only on a mission with an invoice list.
    const exact = !!m.limits.order_lines;
    if (!exact && unknownFields(ACTION_FIELDS).length) return refuseExtra(unknownFields(ACTION_FIELDS));

    // Both must pass. No await between these checks and recording the payment, so two copies
    // sent at the same instant cannot both pay one line.
    const refusal = (exact ? orderRefusal(m, action as Record<string, unknown>) : null) ?? paymentRefusal(m, action as Record<string, unknown>);
    if (refusal) return send(res, refusal.status, { error: refusal.error, reason: refusal.reason });

    const amount = (action as { amount: number }).amount;
    m.spent_usd = Math.round((m.spent_usd + amount) * 100) / 100;
    const receiptId = `rcpt_${randomUUID()}`;
    const { merchant, asset, invoice_number: invoiceNumber } = action as { merchant: string; asset: string; invoice_number?: string };
    if (exact) m.paid_lines.add(lineKey(merchant, invoiceNumber!));
    this.executions.push({ mission_id: m.id, merchant, amount, asset, receipt_id: receiptId, ...(exact ? { invoice_number: invoiceNumber } : {}) });
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
