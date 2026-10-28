// Web app for the Yebo AP Agent: upload invoices, watch Muse Spark read them and plan the
// payments, open the approval link, and follow every Yebo decision live.
//   npm run web     then open http://127.0.0.1:3000
// Runs locally (binds 127.0.0.1) in judge mode or live mode, same as the CLI.
// YEBO_SITE=replay or live turns it into the hosted demo for judges (see src/web/hosted.ts):
// replays of real recorded runs, and optionally live runs on the bundled invoices behind
// strict limits. YEBO_RECORD_DIR=folder records every finished run (see src/web/replays.ts).

import "dotenv/config";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { startGateway, type GatewayMode } from "../gatewayMode.js";
import { model, endpoint, onUsage, openAvailable, type Brain } from "../muse.js";
import { SUPPORTED_EXTENSIONS, type InvoiceSource } from "../invoice.js";
import { runAgent, today, type AgentMode, type RunEvent } from "../runner.js";
import { openVoiceModel, transcribe, transcribeOpen, VOICE_MODEL } from "../voice.js";
import { MemoryLedger } from "../ledger.js";
import { loadVendorFile, type Vendor } from "../vendors.js";
import { describe as describeLab, scenario as labScenario } from "./lab.js";
import { LiveGuard, liveLimits, site as siteFromEnv, visitorId, type Site } from "./hosted.js";
import { describeReplays, loadReplays, schedule, type RecordedEvent, type Recording, type Replay } from "./replays.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(HERE, "public");
const ROOT = join(HERE, "..", "..");
const DEMO = join(ROOT, "demo");
const SAMPLES = join(DEMO, "invoices");
const FIXTURES = join(DEMO, "fixtures");
// The demo set (the video's run): the 5 samples plus two labelled test invoices, a known
// vendor with an account not on file and the Nimbus bill reissued under a new number.
const DEMO_SET_EXTRAS = ["test-account-mismatch-LL-3104.png", "test-reissued-NH-88317-R.png"];
const VOICE_SAMPLE = join(DEMO, "voice", "pay-this-weeks-invoices.wav");
export const REPLAYS = join(DEMO, "replays");

const MAX_FILES = 10;
const MAX_FILE_BYTES = 15 * 1024 * 1024;
const MAX_BODY_BYTES = 45 * 1024 * 1024; // base64 of 10 files plus JSON
const MAX_VOICE_BYTES = 12 * 1024 * 1024; // base64 of a few minutes of 16 kHz mono WAV
const RUN_TTL_MS = 60 * 60_000;
const MAX_RUNS = 500; // runs (and replays) kept in memory at once

const STATIC: Record<string, { file: string; type: string }> = {
  "/": { file: "index.html", type: "text/html; charset=utf-8" },
  "/app.js": { file: "app.js", type: "text/javascript; charset=utf-8" },
  "/app.css": { file: "app.css", type: "text/css; charset=utf-8" },
};

const MIME: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".pdf": "application/pdf",
};

const SECURITY_HEADERS = {
  "content-security-policy":
    "default-src 'self'; img-src 'self' data: blob:; object-src 'none'; frame-src 'self' blob:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
};

type Run = { id: string; events: RunEvent[]; times: number[]; listeners: Set<ServerResponse>; finished: boolean; created: number };

// site: local (default), or the hosted demo. guard: the live-run limits (hosted live only).
// replays: what the replay list offers. recordDir: where to write finished runs, if anywhere.
export type WebOptions = { site?: Site; guard?: LiveGuard | null; replays?: Replay[]; recordDir?: string | null };

export class WebApp {
  readonly runs = new Map<string, Run>();
  private readonly site: Site;
  private readonly guard: LiveGuard | null;
  private readonly replays: Replay[];
  private readonly recordDir: string | null;

  constructor(private readonly gateway: GatewayMode, options: WebOptions = {}) {
    this.site = options.site ?? "local";
    this.guard = options.guard ?? null;
    this.replays = options.replays ?? loadReplays(REPLAYS);
    this.recordDir = options.recordDir ?? null;
  }

  private get hosted(): boolean {
    return this.site !== "local";
  }

  // Live runs: always locally; on the hosted demo only in live mode, through the guard.
  private get liveRuns(): boolean {
    return this.site === "local" || (this.site === "live" && !!this.guard?.limits.enabled);
  }

  handler = (req: IncomingMessage, res: ServerResponse) => {
    this.route(req, res).catch((err) => json(res, 500, { error: err instanceof Error ? err.message : "server error" }));
  };

  private async route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://local");
    const path = url.pathname;

    if (req.method === "GET" && STATIC[path]) {
      const { file, type } = STATIC[path];
      res.writeHead(200, { "content-type": type, "cache-control": "no-store", ...SECURITY_HEADERS });
      res.end(await readFile(join(PUBLIC, file)));
      return;
    }
    if (req.method === "GET" && path === "/api/config") {
      return json(res, 200, {
        mode: this.gateway.mode, model: model(), voiceModel: VOICE_MODEL, today: today(), gateway: this.hosted ? "" : this.gateway.url, dryRun: true,
        openAvailable: this.liveRuns && openAvailable(), openModel: endpoint("muse-spark-open").model, openVoiceModel: openVoiceModel(),
        site: this.site, liveRuns: this.liveRuns, uploads: !this.hosted, voice: !this.hosted,
        live: this.site === "live" && this.guard ? this.guard.status() : null,
      });
    }
    if (req.method === "GET" && path === "/api/replays") return json(res, 200, { replays: describeReplays(this.replays) });
    const replay = path.match(/^\/api\/replays\/([a-z0-9-]{1,60})\/play$/);
    if (req.method === "POST" && replay) return this.playReplay(replay[1], req, res);
    if (req.method === "GET" && path === "/api/lab") return json(res, 200, { scenarios: describeLab(ROOT) });
    if (req.method === "GET" && path === "/api/samples") return json(res, 200, { samples: await sampleNames(), demoSet: (await demoSet()).map((s) => s.name) });
    const sample = path.match(/^\/api\/samples\/([A-Za-z0-9._-]+)$/);
    if (req.method === "GET" && sample) {
      const names = await sampleNames();
      if (!names.includes(sample[1])) return json(res, 404, { error: "no such sample" });
      res.writeHead(200, { "content-type": MIME[extname(sample[1]).toLowerCase()], ...SECURITY_HEADERS });
      res.end(await readFile(join(SAMPLES, sample[1])));
      return;
    }
    if (req.method === "GET" && path === "/api/voice-sample") {
      const wav = await readFile(VOICE_SAMPLE).catch(() => null);
      if (!wav) return json(res, 404, { error: "no voice sample" });
      res.writeHead(200, { "content-type": "audio/wav", ...SECURITY_HEADERS });
      res.end(wav);
      return;
    }
    if (req.method === "POST" && path === "/api/runs") return this.startRun(req, res);
    if (req.method === "POST" && path === "/api/transcribe") return this.transcribe(req, res);
    const events = path.match(/^\/api\/runs\/([0-9a-f-]{36})\/events$/);
    if (req.method === "GET" && events) return this.stream(events[1], res);
    json(res, 404, { error: "not found" });
  }

  private async startRun(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // Same-origin only: the page posts JSON from this server's own origin.
    if (!sameOrigin(req)) return json(res, 403, { error: "cross-origin request refused" });
    if (!this.liveRuns) {
      return json(res, 403, { error: this.site === "replay" ? "This is the replay site: it plays back recorded runs and makes no model calls." : "Live runs are switched off. The replays still work." });
    }
    const raw = await readBody(req, this.hosted ? 4096 : MAX_BODY_BYTES);
    if (raw === null) return json(res, 413, { error: this.hosted ? "uploads are not available on the hosted demo" : "upload too large" });
    let body: { goal?: unknown; files?: unknown; samples?: unknown; attackDemo?: unknown; brain?: unknown; scenario?: unknown; heard?: unknown };
    try {
      body = JSON.parse(raw);
    } catch {
      return json(res, 400, { error: "bad JSON" });
    }
    // The hosted demo runs only the bundled invoices: no uploads.
    if (this.hosted && body.scenario === undefined && body.samples !== true && body.samples !== "demo-set") {
      return json(res, 400, { error: "the hosted demo runs the bundled invoices only: pick the samples, the demo set or a Controls Lab scenario" });
    }
    // A Controls Lab scenario brings its own invoices, vendor file and (empty) 24-hour ledger.
    const lab = body.scenario === undefined ? undefined : labScenario(body.scenario);
    if (body.scenario !== undefined && !lab) return json(res, 400, { error: "no such scenario" });
    let labVendors: Vendor[] | undefined;
    if (lab) {
      try {
        labVendors = loadVendorFile(join(ROOT, lab.vendorFile));
      } catch (err) {
        return json(res, 500, { error: err instanceof Error ? err.message : String(err) });
      }
    }
    const sources = lab
      ? { list: await Promise.all(lab.invoices.map(async (p) => ({ name: p.split("/").pop()!, data: await readFile(join(DEMO, p)) }))) }
      : await this.sources(body);
    if ("error" in sources) return json(res, 400, { error: sources.error });
    const goal = typeof body.goal === "string" && body.goal.trim() ? body.goal.trim().slice(0, this.hosted ? 200 : 500) : "Pay these invoices.";

    if (body.brain === "muse-spark-open" && !openAvailable()) return json(res, 400, { error: "Muse Spark Open needs BASETEN_API_KEY in .env" });
    this.prune();
    if (this.runs.size >= MAX_RUNS) return json(res, 503, { error: "the server is busy; try again in a minute" });
    let done = () => {};
    if (this.hosted) {
      const admitted = this.guard!.admit(visitorId(req, this.guard!.limits.trustProxy));
      if (!admitted.ok) return json(res, admitted.status, { error: admitted.error });
      done = admitted.done;
    }
    const run = this.newRun();
    const agentMode: AgentMode = (lab ? lab.attackDemo : body.attackDemo === true) ? "attack-demo" : "guarded";
    const brain: Brain = body.brain === "muse-spark-open" ? "muse-spark-open" : "muse-spark";
    const labInput = lab ? { vendors: labVendors, ledger: new MemoryLedger() } : {};
    // A spoken instruction the page transcribed just before, kept with a recording.
    const h = body.heard as { model?: unknown; transcript?: unknown } | undefined;
    const heard = typeof h?.model === "string" && typeof h.transcript === "string" && h.transcript === goal ? { model: h.model.slice(0, 80), transcript: goal } : undefined;
    const input: Recording["input"] = {
      goal, brain, attackDemo: agentMode === "attack-demo", invoices: sources.list.map((s) => s.name),
      ...(lab ? { scenario: lab.id } : {}), ...(heard ? { heard } : {}),
    };
    runAgent({ goal, sources: sources.list, agentMode, brain, ...labInput }, this.gateway, (e) => this.publish(run, e)).finally(() => {
      done();
      this.end(run);
      if (this.recordDir) this.record(run, input).catch((err) => console.error(`Could not record run ${run.id}: ${err instanceof Error ? err.message : err}`));
    });
    json(res, 201, { id: run.id });
  }

  private newRun(): Run {
    const run: Run = { id: randomUUID(), events: [], times: [], listeners: new Set(), finished: false, created: Date.now() };
    this.runs.set(run.id, run);
    return run;
  }

  private end(run: Run): void {
    run.finished = true;
    for (const l of run.listeners) l.end();
    run.listeners.clear();
  }

  // Writes a finished run to YEBO_RECORD_DIR, for npm run replay -- save.
  private async record(run: Run, input: Recording["input"]): Promise<void> {
    const rec: Recording = {
      recordedAt: new Date(run.created).toISOString(), mode: this.gateway.mode, input,
      events: run.events.map((event, i) => ({ ms: run.times[i] - run.created, event })),
    };
    await mkdir(this.recordDir!, { recursive: true });
    await writeFile(join(this.recordDir!, `${new Date(run.created).toISOString().replace(/[:.]/g, "-")}-${run.id.slice(0, 8)}.json`), `${JSON.stringify(rec)}\n`);
  }

  // Plays a recorded run back through the same event stream as a live run. No model calls.
  private playReplay(id: string, req: IncomingMessage, res: ServerResponse): void {
    if (!sameOrigin(req)) return json(res, 403, { error: "cross-origin request refused" });
    const replay = this.replays.find((r) => r.id === id);
    if (!replay) return json(res, 404, { error: "no such replay" });
    this.prune();
    if (this.runs.size >= MAX_RUNS) return json(res, 503, { error: "the server is busy; try again in a minute" });
    const run = this.newRun();
    const at = schedule(replay.events);
    const timers = replay.events.map((e: RecordedEvent, i) => setTimeout(() => {
      this.publish(run, e.event);
      if (i === replay.events.length - 1) this.end(run);
    }, at[i]));
    if (!timers.length) this.end(run);
    json(res, 201, { id: run.id });
  }

  // A spoken instruction recorded in the browser (16 kHz mono WAV, base64) to text.
  // brain "muse-spark-open": Muse Spark Open transcribes it (open weights, via Baseten).
  private async transcribe(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!sameOrigin(req)) return json(res, 403, { error: "cross-origin request refused" });
    if (this.hosted) return json(res, 403, { error: "voice is not available on the hosted demo; watch the voice replay" });
    const raw = await readBody(req, MAX_VOICE_BYTES);
    if (raw === null) return json(res, 413, { error: "recording too long" });
    let body: { audio?: unknown; keywords?: unknown; brain?: unknown };
    try {
      body = JSON.parse(raw);
    } catch {
      return json(res, 400, { error: "bad JSON" });
    }
    if (typeof body.audio !== "string" || !body.audio) return json(res, 400, { error: "no audio" });
    const keywords = Array.isArray(body.keywords) ? body.keywords.filter((k): k is string => typeof k === "string" && k.length <= 80).slice(0, 50) : [];
    const open = body.brain === "muse-spark-open";
    if (open && !openAvailable()) return json(res, 400, { error: "Muse Spark Open needs BASETEN_API_KEY in .env" });
    try {
      const wav = Buffer.from(body.audio, "base64");
      if (open) return json(res, 200, { transcript: await transcribeOpen(wav), model: openVoiceModel() });
      return json(res, 200, { transcript: await transcribe(wav, keywords), model: VOICE_MODEL });
    } catch (err) {
      return json(res, 400, { error: err instanceof Error ? err.message : String(err) });
    }
  }

  // Uploaded files (base64) or the built-in samples, validated.
  private async sources(body: { files?: unknown; samples?: unknown }): Promise<{ list: InvoiceSource[] } | { error: string }> {
    if (body.samples === true) {
      const names = await sampleNames();
      return { list: await Promise.all(names.map(async (name) => ({ name, data: await readFile(join(SAMPLES, name)) }))) };
    }
    if (body.samples === "demo-set") {
      const set = await demoSet();
      if (!set.length) return { error: "the demo set is not available" };
      return { list: await Promise.all(set.map(async ({ name, path }) => ({ name, data: await readFile(path) }))) };
    }
    if (!Array.isArray(body.files) || body.files.length === 0) return { error: "add at least one invoice" };
    if (body.files.length > MAX_FILES) return { error: `at most ${MAX_FILES} invoices per run` };
    const list: InvoiceSource[] = [];
    for (const f of body.files as Array<{ name?: unknown; data?: unknown }>) {
      if (typeof f?.name !== "string" || typeof f.data !== "string") return { error: "each file needs a name and data" };
      const name = f.name.replace(/[^\w.\- ]/g, "_").slice(0, 120);
      if (!SUPPORTED_EXTENSIONS.includes(extname(name).toLowerCase())) return { error: `${name}: use ${SUPPORTED_EXTENSIONS.join(", ")}` };
      const data = Buffer.from(f.data, "base64");
      if (!data.length) return { error: `${name} is empty` };
      if (data.length > MAX_FILE_BYTES) return { error: `${name} is larger than 15 MB` };
      list.push({ name, data });
    }
    return { list };
  }

  private publish(run: Run, e: RunEvent): void {
    run.events.push(e);
    run.times.push(Date.now());
    const frame = `data: ${JSON.stringify(e)}\n\n`;
    for (const l of run.listeners) l.write(frame);
  }

  private stream(id: string, res: ServerResponse): void {
    const run = this.runs.get(id);
    if (!run) return json(res, 404, { error: "no such run" });
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive", ...SECURITY_HEADERS });
    for (const e of run.events) res.write(`data: ${JSON.stringify(e)}\n\n`); // replay, then live
    if (run.finished) return void res.end();
    run.listeners.add(res);
    res.on("close", () => run.listeners.delete(res));
  }

  private prune(): void {
    for (const [id, run] of this.runs) if (run.finished && Date.now() - run.created > RUN_TTL_MS) this.runs.delete(id);
  }
}

// The page posts from this server's own origin (http locally, https behind a host's proxy).
function sameOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    const u = new URL(origin);
    return (u.protocol === "http:" || u.protocol === "https:") && u.host === req.headers.host;
  } catch {
    return false;
  }
}

// The samples plus DEMO_SET_EXTRAS, or nothing if any of them is missing.
async function demoSet(): Promise<{ name: string; path: string }[]> {
  const samples = (await sampleNames()).map((name) => ({ name, path: join(SAMPLES, name) }));
  const fixtures = await readdir(FIXTURES).catch(() => [] as string[]);
  if (!samples.length || !DEMO_SET_EXTRAS.every((n) => fixtures.includes(n))) return [];
  return [...samples, ...DEMO_SET_EXTRAS.map((name) => ({ name, path: join(FIXTURES, name) }))];
}

async function sampleNames(): Promise<string[]> {
  const names = await readdir(SAMPLES).catch(() => [] as string[]);
  return names.filter((n) => SUPPORTED_EXTENSIONS.includes(extname(n).toLowerCase())).sort();
}

function readBody(req: IncomingMessage, limit: number): Promise<string | null> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        resolve(null);
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function json(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) return;
  res.writeHead(status, { "content-type": "application/json", ...SECURITY_HEADERS });
  res.end(JSON.stringify(body));
}

async function main() {
  const site = siteFromEnv();
  const recordDir = process.env.YEBO_RECORD_DIR?.trim() || null;
  if (site === "local") {
    const gateway = await startGateway();
    const app = new WebApp(gateway, { recordDir });
    const port = Number(process.env.WEB_PORT ?? 3000);
    createServer(app.handler).listen(port, "127.0.0.1", () => {
      console.log(`Yebo AP Agent: http://127.0.0.1:${port}`);
      console.log(gateway.mode === "judge"
        ? `Judge mode: local stand-in gateway at ${gateway.url} (simulated approval, dry run).`
        : `Live mode: Yebo gateway at ${gateway.url} (passkey approval, dry run).`);
      if (recordDir) console.log(`Recording every finished run to ${recordDir}.`);
    });
    return;
  }

  // The hosted demo. Always judge mode with simulated, automatic approval: it never talks to
  // the real Yebo gateway. The replay site makes no model calls at all.
  process.env.YEBO_MODE = "judge";
  process.env.YEBO_JUDGE_AUTO_APPROVE = "true";
  delete process.env.YEBO_HMAC_SECRET;
  delete process.env.YEBO_MISSION_TOKEN;
  let guard: LiveGuard | null = null;
  let gateway: GatewayMode = { mode: "judge", url: "", stop: async () => {} };
  if (site === "live") {
    guard = new LiveGuard(liveLimits(), process.env.YEBO_LIVE_SPEND_FILE?.trim() || ".data/live-spend.json");
    onUsage((u) => guard!.record(u));
    gateway = await startGateway();
  } else {
    for (const k of ["META_API_KEY", "BASETEN_API_KEY"]) delete process.env[k]; // replay: nothing can call a model
  }
  const app = new WebApp(gateway, { site, guard, recordDir });
  const port = Number(process.env.PORT ?? process.env.WEB_PORT ?? 3000);
  const host = process.env.HOST?.trim() || "0.0.0.0";
  createServer(app.handler).listen(port, host, () => {
    console.log(`Yebo AP Agent (hosted ${site} demo) on ${host}:${port}`);
    if (guard) {
      const l = guard.limits;
      console.log(l.enabled
        ? `Live runs ON: ${l.perVisitorPerHour} per visitor per hour, $${l.dailyUsd} a day hard cap, ${l.maxConcurrent} at once. YEBO_LIVE=off turns them off.`
        : "Live runs OFF (YEBO_LIVE=off or no META_API_KEY). Replays only.");
    } else console.log("Replays only: no model calls, no keys.");
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
