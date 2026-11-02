// HTML for the judge-mode approval page. Plain server-rendered HTML, every value escaped.
// Clearly labelled: this is a local simulation of the yebo.dev passkey approval page.

import type { JudgeMission } from "./gateway.js";

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

// Shown wherever exact-order mode is on. It says what is true today; keep it that way.
export const EXACT_ORDER_LABEL = "Exact-order mode: enforced by the judge-mode stand-in in this repo. The live Yebo gateway enforces caps today; exact-order is planned there.";

const usd = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function shell(title: string, body: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
  :root { --bg:#05070a; --card:#0d1319; --line:#1f2a33; --ink:#e8eef2; --muted:#8c99a4; --green:#3ef0a0; --green-ink:#05070a; --info:#6aa8ff; }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--ink); font:16px/1.5 -apple-system, system-ui, Segoe UI, sans-serif; }
  main { max-width: 460px; margin: 0 auto; padding: 40px 16px; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:16px; padding:24px; }
  .kicker { color:var(--green); font-size:12px; letter-spacing:.12em; text-transform:uppercase; font-weight:600; margin:0 0 8px; }
  h1 { font-size:22px; margin:0 0 6px; overflow-wrap:anywhere; }
  .muted { color:var(--muted); font-size:14px; }
  .banner { border:1px solid var(--info); color:var(--info); border-radius:10px; padding:10px 12px; font-size:13px; margin:0 0 18px; }
  .scroll { overflow-x:auto; margin:12px 0; }
  table { width:100%; border-collapse:collapse; font-size:13px; }
  th { color:var(--muted); font-weight:500; text-align:left; white-space:nowrap; } th, td { padding:6px 8px 6px 0; border-bottom:1px solid var(--line); vertical-align:top; }
  .nw { white-space:nowrap; } .num { text-align:right; padding-right:0; white-space:nowrap; }
  dl { margin:18px 0; display:grid; grid-template-columns:auto 1fr; gap:8px 16px; font-size:15px; }
  dt { color:var(--muted); } dd { margin:0; text-align:right; overflow-wrap:anywhere; }
  button { width:100%; padding:14px; border-radius:12px; font-size:16px; font-weight:600; cursor:pointer; margin-top:10px; }
  .approve { background:var(--green); color:var(--green-ink); border:0; }
  .deny { background:transparent; color:var(--ink); border:1px solid var(--line); }
  code { font-size:12px; color:var(--muted); overflow-wrap:anywhere; }
</style></head><body><main><div class="card">${body}</div></main></body></html>`;
}

export function approvalPage(m: JudgeMission & { approval_nonce: string }, now: number): string {
  const nonceField = `<input type="hidden" name="nonce" value="${esc(m.approval_nonce)}">`;
  if (m.status === "approved") {
    return shell("Mission approved (judge mode)", `
    <p class="kicker">Yebo authorization · judge mode</p>
    <h1>Approved</h1>
    <p class="muted">${esc(m.bot_identifier)} can make payments within the approved limits. Revoking stops every payment not yet made.</p>
    <form method="post" action="/authorize/${esc(m.id)}/revoke">${nonceField}<button class="deny">Revoke approval</button></form>
    <p><code>${esc(m.id)}</code></p>`);
  }
  if (m.status !== "pending") return resultPage(`Already ${m.status}`, "This mission was already resolved.");
  const l = m.limits;
  const minutes = Math.max(0, Math.round((m.expires_at - now) / 60_000));
  const nonce = nonceField;
  const lines = l.order_lines ?? [];
  const invoiceList = l.order_lines ? `
    <p class="banner">${esc(EXACT_ORDER_LABEL)}</p>
    <div class="scroll"><table><thead><tr><th>Invoice</th><th>Payee</th><th>Account</th><th class="num">Amount</th></tr></thead><tbody>
    ${lines.map((i) => `<tr><td class="nw">${esc(i.invoice_number)}</td><td>${esc(i.payee)}</td><td class="nw">…${esc(i.account)}</td><td class="num">${usd(i.amount_usd)} ${esc(i.currency)}</td></tr>`).join("")}
    </tbody></table></div>
    <p class="muted">Only these ${lines.length} invoice${lines.length === 1 ? "" : "s"} can be paid, each once, for exactly this amount.</p>` : "";
  return shell("Approve mission (judge mode)", `
    <p class="kicker">Yebo authorization · judge mode</p>
    <p class="banner">Local simulation for judges. The real flow asks for your passkey (Face ID or Touch ID) at yebo.dev. Payments are a dry run: no money moves.</p>
    <h1>${esc(m.bot_identifier)} wants to run a mission</h1>
    ${m.objective ? `<p class="muted">${esc(m.objective)}</p>` : ""}
    <dl>
      <dt>Payees</dt><dd>${esc(l.merchant_scope.join(", ") || "Any")}</dd>
      <dt>Per payment</dt><dd>${usd(l.per_transaction_limit_usd)}</dd>
      <dt>Total budget</dt><dd>${usd(l.cumulative_budget_usd)}</dd>
      <dt>Currency</dt><dd>${esc(l.asset_scope.join(", ") || "Any")}</dd>
      <dt>Can do</dt><dd>${esc(l.capabilities.join(", "))}</dd>
      <dt>Expires</dt><dd>in ${minutes} min</dd>
    </dl>
    ${invoiceList}
    <p class="muted">Anything outside these limits is refused.</p>
    <form method="post" action="/authorize/${esc(m.id)}/approve">${nonce}<button class="approve">${l.order_lines ? "Approve invoice list (simulated)" : "Approve limits (simulated)"}</button></form>
    <form method="post" action="/authorize/${esc(m.id)}/deny">${nonce}<button class="deny">Deny</button></form>
    <p><code>${esc(m.id)}</code></p>`);
}

export function resultPage(title: string, text: string): string {
  return shell(title, `<p class="kicker">Yebo authorization · judge mode</p><h1>${esc(title)}</h1><p class="muted">${esc(text)}</p>`);
}
