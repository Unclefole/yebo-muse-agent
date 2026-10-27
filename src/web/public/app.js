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

// samples: false (uploaded files), true (the samples) or "demo-set" (the samples plus two test invoices)
const state = { files: [], samples: false, sampleNames: [], demoSetNames: [], mode: "judge", source: null, results: [] };

async function init() {
  try {
    const cfg = await (await fetch("/api/config")).json();
    state.mode = cfg.mode;
    const mode = $("mode-badge");
    mode.textContent = cfg.mode === "judge" ? "Judge mode · local gateway" : "Live · Yebo gateway";
    if (cfg.mode !== "judge") mode.classList.add("live");
    $("model-badge").textContent = cfg.model;
    $("brain-spark").textContent = `${cfg.model} · Meta Model API`;
    if (cfg.openAvailable) {
      $("brain-open-note").textContent = `${cfg.openModel} · open weights, via Baseten`;
    } else {
      $("brain-open").disabled = true;
      $("brain-open-label").classList.add("off");
      $("brain-open-note").textContent = "add BASETEN_API_KEY to .env to use it";
    }
    $("foot").textContent = cfg.mode === "judge"
      ? "Judge mode: payments are checked by a local stand-in for the Yebo gateway that enforces the same mission rules. Approval is simulated; the live flow uses your passkey at yebo.dev. Dry run: no money moves."
      : `Live mode: payments are checked by the Yebo gateway (${cfg.gateway}). You approve the limits with your passkey. Dry run: no money moves.`;
    const listed = await (await fetch("/api/samples")).json();
    state.sampleNames = listed.samples || [];
    state.demoSetNames = listed.demoSet || [];
    $("use-samples").textContent = `Use the ${state.sampleNames.length} sample invoices`;
    if (!state.sampleNames.length) $("use-samples").hidden = true;
    $("use-demo-set").textContent = `Use the demo set (${state.demoSetNames.length} invoices)`;
    $("use-demo-set").hidden = !state.demoSetNames.length;
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
  const names = state.samples === "demo-set" ? state.demoSetNames : state.samples ? state.sampleNames : state.files.map((f) => f.name);
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
$("use-demo-set").addEventListener("click", () => { hideError(); state.files = []; state.samples = "demo-set"; renderChips(); });

function showError(text) { const e = $("upload-error"); e.textContent = text; e.hidden = false; }
function hideError() { $("upload-error").hidden = true; }

const blobToBase64 = (blob) => toBase64(blob);
const toBase64 = (file) => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(String(r.result).split(",")[1] || "");
  r.onerror = () => reject(r.error);
  r.readAsDataURL(file);
});

// ── Running ─────────────────────────────────────────────────────────────────
$("run").addEventListener("click", () => startRun());

async function startRun() {
  hideError();
  const run = $("run");
  run.disabled = true;
  run.textContent = "Starting…";
  try {
    const brain = document.querySelector('input[name="brain"]:checked')?.value || "muse-spark";
    const body = { goal: $("goal").value, attackDemo: $("attack-demo").checked, brain };
    if (state.samples) body.samples = state.samples;
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
}

// ── Voice (Muse Voice Transcribe) ───────────────────────────────────────────
// Click to start, click again to stop (30 s at most). The browser records with
// MediaRecorder, then decodes and downsamples to 16 kHz mono and writes a 16-bit WAV,
// the format the transcription API takes. The server sends it to Muse Voice Transcribe.
const VOICE_RATE = 16000;
const MAX_RECORDING_MS = 30_000;
const voice = { recorder: null, chunks: [], timer: null };

$("mic").addEventListener("click", async () => {
  if (voice.recorder) return voice.recorder.stop();
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const recorder = new MediaRecorder(stream);
    voice.recorder = recorder;
    voice.chunks = [];
    recorder.ondataavailable = (e) => e.data.size && voice.chunks.push(e.data);
    recorder.onstop = () => {
      clearTimeout(voice.timer);
      stream.getTracks().forEach((t) => t.stop());
      voice.recorder = null;
      $("mic").classList.remove("recording");
      transcribeRecording(new Blob(voice.chunks, { type: recorder.mimeType }));
    };
    recorder.start();
    voice.timer = setTimeout(() => recorder.state === "recording" && recorder.stop(), MAX_RECORDING_MS);
    $("mic").classList.add("recording");
    voiceStatus("Listening… click the microphone again when you are done.");
  } catch (err) {
    voiceStatus(`Microphone unavailable: ${err.message || err}`, true);
  }
});

// The bundled sample command goes through exactly the same path as a recording.
$("voice-sample").addEventListener("click", async () => {
  try {
    const res = await fetch("/api/voice-sample");
    if (!res.ok) throw new Error(`server returned ${res.status}`);
    transcribeRecording(await res.blob());
  } catch (err) {
    voiceStatus(`Could not load the sample: ${err.message || err}`, true);
  }
});

async function transcribeRecording(blob) {
  const mic = $("mic");
  mic.disabled = true;
  voiceStatus("Transcribing with Muse Voice Transcribe…");
  try {
    const wav = await toWav16k(blob);
    const res = await fetch("/api/transcribe", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ audio: await blobToBase64(wav) }), // no keywords: in testing they made the model repeat words ("paypay")
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `server returned ${res.status}`);
    $("goal").value = data.transcript;
    const ready = state.samples || state.files.length;
    voiceStatus(`Heard: “${data.transcript}”${ready ? "" : " Add invoices, then run the agent."}`);
    if (ready && !$("run").disabled) startRun();
  } catch (err) {
    voiceStatus(`Could not transcribe: ${err.message || err}`, true);
  } finally {
    mic.disabled = false;
  }
}

function voiceStatus(text, isError) {
  const s = $("voice-status");
  s.textContent = text;
  s.classList.toggle("err", !!isError);
  s.hidden = false;
}

async function toWav16k(blob) {
  const ctx = new AudioContext();
  const decoded = await ctx.decodeAudioData(await blob.arrayBuffer());
  await ctx.close();
  const length = Math.max(1, Math.ceil(decoded.duration * VOICE_RATE));
  const offline = new OfflineAudioContext(1, length, VOICE_RATE); // mono, 16 kHz
  const source = offline.createBufferSource();
  source.buffer = decoded;
  source.connect(offline.destination);
  source.start();
  const samples = (await offline.startRendering()).getChannelData(0);
  const out = new DataView(new ArrayBuffer(44 + samples.length * 2));
  const text = (offset, str) => [...str].forEach((c, i) => out.setUint8(offset + i, c.charCodeAt(0)));
  text(0, "RIFF"); out.setUint32(4, 36 + samples.length * 2, true); text(8, "WAVE");
  text(12, "fmt "); out.setUint32(16, 16, true); out.setUint16(20, 1, true); out.setUint16(22, 1, true);
  out.setUint32(24, VOICE_RATE, true); out.setUint32(28, VOICE_RATE * 2, true); out.setUint16(32, 2, true); out.setUint16(34, 16, true);
  text(36, "data"); out.setUint32(40, samples.length * 2, true);
  samples.forEach((v, i) => out.setInt16(44 + i * 2, Math.max(-1, Math.min(1, v)) * 0x7fff, true));
  return new Blob([out], { type: "audio/wav" });
}

function resetRun() {
  if (state.source) state.source.close();
  state.results = [];
  for (const id of ["invoices", "plan", "timeline", "hidden-list"]) $(id).replaceChildren();
  for (const id of ["read-card", "hidden-card", "plan-card", "mission", "totals", "agent-msg"]) $(id).hidden = true;
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
      if (!planningShown) { planningShown = true; step("The agent is planning the payments…"); }
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
      step(`Instruction: “${e.goal}” · today is ${e.today}`);
      step(`Agent brain: ${e.brainLabel} (${e.model})`);
      state.vendorCheck = !!e.vendorCheck;
      if (e.vendorCheck) step("Vendor file on: each payee and bank account must match it");
      $("model-badge").textContent = e.brain === "muse-spark-open" ? `${e.model} (open)` : e.model;
      if (e.agentMode === "attack-demo") {
        step("Attack demo: payment requests hidden in the invoices will be forced through, as if the agent had been hijacked.", "attack-banner");
      }
      if (e.invoices) step(`Reading ${e.invoices} invoice${e.invoices === 1 ? "" : "s"} with ${e.readerModel}`);
      break;
    case "invoice": return addInvoice(e.invoice);
    case "invoice_error": return addInvoiceError(e.file, e.error);
    case "proposed": return addProposal(e);
    case "hidden_requests": return showHidden(e.requests);
    case "invoices_refused":
      for (const r of e.rejected) step(`Left out of the limits: ${r.payee} (${r.file}): ${r.reason}`, "DENY");
      return;
    case "no_mission": return step(`No mission requested: ${e.reason}. Nothing will run.`);
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
    // Collapsed by default: a small toggle under the payee opens the note in its own row.
    const note = el("tr", "note");
    note.hidden = true;
    const td = el("td", "", `Note on invoice (read as data, never as instructions): ${v.notes}`);
    td.colSpan = 4;
    note.append(td);
    const toggle = el("button", "note-toggle", "Show note");
    toggle.type = "button";
    toggle.setAttribute("aria-expanded", "false");
    toggle.addEventListener("click", () => {
      note.hidden = !note.hidden;
      toggle.textContent = note.hidden ? "Show note" : "Hide note";
      toggle.setAttribute("aria-expanded", String(!note.hidden));
    });
    payee.append(toggle);
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

function addProposal(e) {
  const p = e.proposal;
  $("plan-card").hidden = false;
  const li = el("li", e.forced ? "forced" : "");
  li.id = `plan-${e.id}`;
  li.append(el("span", "amt", usd(p.amount_usd)), document.createTextNode(` to ${p.payee}`));
  if (e.forced) li.append(el("span", "flag", "FORCED · attack demo"));
  else if (e.matchesInvoice === false) li.append(el("span", "flag", "NOT ON ANY INVOICE"));
  if (p.memo) li.append(el("span", "memo", p.memo));
  $("plan").append(li);
}

function showHidden(requests) {
  const list = $("hidden-list");
  for (const r of requests) {
    const li = el("li");
    li.append(el("strong", "", `${usd(r.amount_usd)} to ${r.payee}`));
    if (r.quote) li.append(el("span", "quote", `“${r.quote}”`));
    li.append(el("span", "from", `Written inside ${r.invoice_file}`));
    list.append(li);
  }
  $("hidden-card").hidden = false;
  step(`Found ${requests.length} hidden payment request${requests.length === 1 ? "" : "s"} inside the invoices`, "DENY");
}

function showMission(e) {
  $("plan-card").hidden = false;
  $("mission").hidden = false;
  $("m-payees").textContent = e.limits.payees.join(", ");
  $("m-per").textContent = usd(e.limits.per_payment_usd);
  $("m-total").textContent = usd(e.limits.total_usd);
  $("m-source").textContent = e.source === "invoices"
    ? `Built from the invoices the agent chose to pay, never wider than the invoices themselves.${state.vendorCheck ? " Payees and bank accounts must also be on the vendor file." : ""} Anything else is refused.`
    : "Built from the agent's plan (no invoices in this run).";
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
  if (d.forced) what.append(el("span", "flag", "FORCED"));
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
