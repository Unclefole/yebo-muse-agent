// Web app for the Yebo AP Agent: upload invoices, watch Muse Spark read them and plan the
// payments, open the approval link, and follow every Yebo decision live.
//   npm run web     then open http://127.0.0.1:3000
// Runs locally (binds 127.0.0.1) in judge mode or live mode, same as the CLI.

import "dotenv/config";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { startGateway, type GatewayMode } from "../gatewayMode.js";
import { model } from "../muse.js";
import { SUPPORTED_EXTENSIONS, type InvoiceSource } from "../invoice.js";
import { runAgent, type RunEvent } from "../runner.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(HERE, "public");
const SAMPLES = join(HERE, "..", "..", "demo", "invoices");

const MAX_FILES = 10;
const MAX_FILE_BYTES = 15 * 1024 * 1024;
const MAX_BODY_BYTES = 45 * 1024 * 1024; // base64 of 10 files plus JSON
const RUN_TTL_MS = 60 * 60_000;

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

type Run = { id: string; events: RunEvent[]; listeners: Set<ServerResponse>; finished: boolean; created: number };

export class WebApp {
  readonly runs = new Map<string, Run>();

  constructor(private readonly gateway: GatewayMode) {}

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
      return json(res, 200, { mode: this.gateway.mode, model: model(), gateway: this.gateway.url, dryRun: true });
    }
    if (req.method === "GET" && path === "/api/samples") return json(res, 200, { samples: await sampleNames() });
    const sample = path.match(/^\/api\/samples\/([A-Za-z0-9._-]+)$/);
    if (req.method === "GET" && sample) {
      const names = await sampleNames();
      if (!names.includes(sample[1])) return json(res, 404, { error: "no such sample" });
      res.writeHead(200, { "content-type": MIME[extname(sample[1]).toLowerCase()], ...SECURITY_HEADERS });
      res.end(await readFile(join(SAMPLES, sample[1])));
      return;
    }
    if (req.method === "POST" && path === "/api/runs") return this.startRun(req, res);
    const events = path.match(/^\/api\/runs\/([0-9a-f-]{36})\/events$/);
    if (req.method === "GET" && events) return this.stream(events[1], res);
    json(res, 404, { error: "not found" });
  }

  private async startRun(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // Same-origin only: the page posts JSON from this server's own origin.
    const origin = req.headers.origin;
    if (origin && origin !== `http://${req.headers.host}`) return json(res, 403, { error: "cross-origin request refused" });
    const raw = await readBody(req, MAX_BODY_BYTES);
    if (raw === null) return json(res, 413, { error: "upload too large" });
    let body: { goal?: unknown; files?: unknown; samples?: unknown; attackDemo?: unknown };
    try {
      body = JSON.parse(raw);
    } catch {
      return json(res, 400, { error: "bad JSON" });
    }
    const sources = await this.sources(body);
    if ("error" in sources) return json(res, 400, { error: sources.error });
    const goal = typeof body.goal === "string" && body.goal.trim() ? body.goal.trim().slice(0, 500) : "Pay these invoices.";

    const run: Run = { id: randomUUID(), events: [], listeners: new Set(), finished: false, created: Date.now() };
    this.runs.set(run.id, run);
    this.prune();
    const agentMode = body.attackDemo === true ? "attack-demo" : "guarded";
    runAgent({ goal, sources: sources.list, agentMode }, this.gateway, (e) => this.publish(run, e)).finally(() => {
      run.finished = true;
      for (const l of run.listeners) l.end();
      run.listeners.clear();
    });
    json(res, 201, { id: run.id });
  }

  // Uploaded files (base64) or the built-in samples, validated.
  private async sources(body: { files?: unknown; samples?: unknown }): Promise<{ list: InvoiceSource[] } | { error: string }> {
    if (body.samples === true) {
      const names = await sampleNames();
      return { list: await Promise.all(names.map(async (name) => ({ name, data: await readFile(join(SAMPLES, name)) }))) };
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
  const gateway = await startGateway();
  const app = new WebApp(gateway);
  const port = Number(process.env.WEB_PORT ?? 3000);
  createServer(app.handler).listen(port, "127.0.0.1", () => {
    console.log(`Yebo AP Agent: http://127.0.0.1:${port}`);
    console.log(gateway.mode === "judge"
      ? `Judge mode: local stand-in gateway at ${gateway.url} (simulated approval, dry run).`
      : `Live mode: Yebo gateway at ${gateway.url} (passkey approval, dry run).`);
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
