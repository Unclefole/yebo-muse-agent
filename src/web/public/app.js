// Yebo AP Agent web app. Plain JavaScript, no build step. Everything shown comes from the
// run's event stream (/api/runs/<id>/events) and is written with textContent, so nothing an
// invoice says can turn into HTML.
"use strict";

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
};
const usd = (n) => `$${Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const clock = () => new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

const state = { files: [], samples: false, sampleNames: [], mode: "judge", source: null, results: [] };

async function init() {
  try {
    const cfg = await (await fetch("/api/config")).json();
    state.mode = cfg.mode;
    const mode = $("mode-badge");
    mode.textContent = cfg.mode === "judge" ? "Judge mode · local gateway" : "Live · Yebo gateway";
    if (cfg.mode !== "judge") mode.classList.add("live");
    $("model-badge").textContent = cfg.model;
    $("foot").textContent = cfg.mode === "judge"
      ? "Judge mode: payments are checked by a local stand-in for the Yebo gateway that enforces the same mission rules. Approval is simulated; the live flow uses your passkey at yebo.dev. Dry run: no money moves."
      : `Live mode: payments are checked by the Yebo gateway (${cfg.gateway}). You approve the limits with your passkey. Dry run: no money moves.`;
    state.sampleNames = (await (await fetch("/api/samples")).json()).samples || [];
    $("use-samples").textContent = `Use the ${state.sampleNames.length} sample invoices`;
    if (!state.sampleNames.length) $("use-samples").hidden = true;
  } catch {
    showError("Could not reach the local server.");
  }
}

// ── Picking invoices ────────────────────────────────────────────────────────
const ACCEPT = /\.(png|jpe?g|gif|webp|pdf)$/i;

function addFiles(list) {
  state.samples = false;
  for (const f of list) {
    if (!ACCEPT.test(f.name)) { showError(`${f.name}: use PNG, JPEG, GIF, WebP or PDF`); continue; }
    if (f.size > 15 * 1024 * 1024) { showError(`${f.name} is larger than 15 MB`); continue; }
    if (state.files.length >= 10) { showError("At most 10 invoices per run"); break; }
    state.files.push(f);
  }
  renderChips();
}

function renderChips() {
  const chips = $("chips");
  chips.replaceChildren();
  const names = state.samples ? state.sampleNames : state.files.map((f) => f.name);
  names.forEach((name, i) => {
    const li = el("li");
    li.append(el("span", "", name));
    const x = el("button", "", "×");
    x.type = "button";
    x.setAttribute("aria-label", `Remove ${name}`);
    x.addEventListener("click", () => {
      if (state.samples) { state.samples = false; } else { state.files.splice(i, 1); }
      renderChips();
    });
    li.append(x);
    chips.append(li);
  });
  $("run").disabled = names.length === 0;
}

const drop = $("drop");
$("file-input").addEventListener("change", (e) => { hideError(); addFiles(e.target.files); e.target.value = ""; });
drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("over"); });
drop.addEventListener("dragleave", () => drop.classList.remove("over"));
drop.addEventListener("drop", (e) => { e.preventDefault(); drop.classList.remove("over"); hideError(); addFiles(e.dataTransfer.files); });
$("use-samples").addEventListener("click", () => { hideError(); state.files = []; state.samples = true; renderChips(); });

function showError(text) { const e = $("upload-error"); e.textContent = text; e.hidden = false; }
function hideError() { $("upload-error").hidden = true; }

const toBase64 = (file) => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(String(r.result).split(",")[1] || "");
  r.onerror = () => reject(r.error);
  r.readAsDataURL(file);
});

// ── Running ─────────────────────────────────────────────────────────────────
$("run").addEventListener("click", async () => {
  hideError();
  const run = $("run");
  run.disabled = true;
  run.textContent = "Starting…";
  try {
    const body = { goal: $("goal").value };
    if (state.samples) body.samples = true;
    else body.files = await Promise.all(state.files.map(async (f) => ({ name: f.name, data: await toBase64(f) })));
    const res = await fetch("/api/runs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `server returned ${res.status}`);
    resetRun();
    listen(data.id);
    run.textContent = "Running…";
  } catch (err) {
    showError(err.message || String(err));
    run.disabled = false;
    run.textContent = "Run the agent";
  }
});

function resetRun() {
  if (state.source) state.source.close();
  state.results = [];
  for (const id of ["invoices", "plan", "timeline"]) $(id).replaceChildren();
  for (const id of ["read-card", "plan-card", "mission", "totals", "agent-msg"]) $(id).hidden = true;
  $("timeline-empty").hidden = false;
  setMissionStatus("wait", "Waiting for your approval…");
}

function listen(id) {
  const source = new EventSource(`/api/runs/${id}/events`);
  state.source = source;
  let planningShown = false;
  source.onmessage = (msg) => {
    const e = JSON.parse(msg.data);
    if (e.type === "planning") {
      if (!planningShown) { planningShown = true; step("Muse Spark is planning the payments…"); }
      return;
    }
    handle(e);
    if (e.type === "done" || e.type === "error") { source.close(); finish(); }
  };
  source.onerror = () => { if (source.readyState === EventSource.CLOSED) finish(); };
}

function finish() {
  const run = $("run");
  run.disabled = !(state.samples || state.files.length);
  run.textContent = "Run the agent again";
}

function handle(e) {
  switch (e.type) {
    case "started":
      step(e.invoices ? `Reading ${e.invoices} invoice${e.invoices === 1 ? "" : "s"} with ${e.model}` : `Planning with ${e.model}`);
      break;
    case "invoice": return addInvoice(e.invoice);
    case "invoice_error": return addInvoiceError(e.file, e.error);
    case "proposed": return addProposal(e.id, e.proposal);
    case "proposal_refused": return step("Refused a malformed proposal from the model");
    case "mission": return showMission(e);
    case "mission_result":
      $("approve-link").hidden = true; // resolved: nothing left to approve
      if (e.approved) { setMissionStatus("ok", "Approved. Yebo now checks every payment."); step("You approved the limits"); }
      else { setMissionStatus("no", "Not approved. Nothing will run."); step("The limits were not approved, so nothing runs"); }
      break;
    case "decision": return addDecision(e);
    case "agent_message":
      $("agent-text").textContent = e.text;
      $("agent-msg").hidden = false;
      break;
    case "summary": return showTotals(e.results);
    case "error": return step(`Stopped: ${e.message}`, "DENY");
  }
}

// ── Rendering ───────────────────────────────────────────────────────────────
function addInvoice(v) {
  $("read-card").hidden = false;
  const tr = el("tr");
  const payee = el("td", "", v.payee);
  payee.append(el("span", "file", v.file));
  tr.append(payee, el("td", "num", `${v.currency === "USD" ? usd(v.amount) : `${v.currency} ${v.amount}`}`), el("td", "", v.due_date || "—"), el("td", "", v.invoice_number || "—"));
  $("invoices").append(tr);
  if (v.notes) {
    const note = el("tr", "note");
    const td = el("td", "", `Note on invoice (read as data, never as instructions): ${v.notes}`);
    td.colSpan = 4;
    note.append(td);
    $("invoices").append(note);
  }
}

function addInvoiceError(file, error) {
  $("read-card").hidden = false;
  const tr = el("tr", "err");
  const td = el("td", "", `${file}: could not read (${error})`);
  td.colSpan = 4;
  tr.append(td);
  $("invoices").append(tr);
}

function addProposal(id, p) {
  $("plan-card").hidden = false;
  const li = el("li");
  li.id = `plan-${id}`;
  li.append(el("span", "amt", usd(p.amount_usd)), document.createTextNode(` to ${p.payee}`));
  if (p.memo) li.append(el("span", "memo", p.memo));
  $("plan").append(li);
}

function showMission(e) {
  $("plan-card").hidden = false;
  $("mission").hidden = false;
  $("m-payees").textContent = e.limits.payees.join(", ");
  $("m-per").textContent = usd(e.limits.per_payment_usd);
  $("m-total").textContent = usd(e.limits.total_usd);
  $("m-expires").textContent = new Date(e.expiresAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const link = $("approve-link");
  link.hidden = false;
  link.href = e.authorizeUrl;
  link.textContent = state.mode === "judge" ? "Open approval page (simulated)" : "Approve with your passkey";
  step(`Mission requested: ${e.limits.payees.length} payee${e.limits.payees.length === 1 ? "" : "s"}, up to ${usd(e.limits.per_payment_usd)} each, ${usd(e.limits.total_usd)} in total`);
}

function setMissionStatus(kind, text) {
  const s = $("mission-status");
  s.className = `status ${kind === "ok" ? "ok" : kind === "no" ? "no" : ""}`;
  s.lastElementChild.textContent = text;
}

function step(text, kind) {
  $("timeline-empty").hidden = true;
  const li = el("li", `step-ev ${kind || ""}`);
  li.append(el("span", "time", clock()), el("span", "what", text));
  $("timeline").append(li);
}

function addDecision(d) {
  $("timeline-empty").hidden = true;
  state.results.push(d);
  const li = el("li", d.decision);
  const what = el("span", "what");
  what.append(el("span", `decision ${d.decision}`, d.decision), document.createTextNode(`${usd(d.proposal.amount_usd)} to ${d.proposal.payee}`));
  li.append(el("span", "time", clock()), what);
  li.append(el("span", "sub", d.decision === "ALLOW" ? d.outcome : `${d.outcome}${d.reason ? `: ${d.reason}` : ""}`));
  if (d.receipt) {
    const r = el("span", "receipt");
    r.append(document.createTextNode(`Receipt ${d.receipt}`));
    const copy = el("button", "", "Copy");
    copy.type = "button";
    copy.addEventListener("click", () => navigator.clipboard?.writeText(d.receipt).then(() => { copy.textContent = "Copied"; }));
    r.append(copy);
    li.append(r);
  }
  $("timeline").append(li);
}

function showTotals(results) {
  if (!results.length) return;
  const counts = results.reduce((acc, r) => ((acc[r.decision] = (acc[r.decision] || 0) + 1), acc), {});
  const allowed = results.filter((r) => r.decision === "ALLOW").reduce((s, r) => s + r.proposal.amount_usd, 0);
  const totals = $("totals");
  totals.replaceChildren();
  totals.append(el("span", "", `${counts.ALLOW || 0} allowed · ${usd(allowed)} (dry run, no money moved)`));
  if (counts.DENY) totals.append(el("span", "", `${counts.DENY} denied`));
  if (counts.REQUIRE_APPROVAL) totals.append(el("span", "", `${counts.REQUIRE_APPROVAL} waiting for approval`));
  totals.hidden = false;
}

init();
