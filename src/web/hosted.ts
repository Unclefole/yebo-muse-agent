// The hosted demo for judges (YEBO_SITE=replay or live). Nothing here runs locally by default.
//
//   replay  plays back real recorded runs (demo/replays/). No model calls, no keys, no cost.
//   live    replay, plus live runs on the bundled invoices only, behind strict limits:
//           the API keys stay on the server (never sent to the browser), each visitor gets a
//           few runs per hour, a hard daily spend cap stops live runs for the day, at most
//           two run at once, and YEBO_LIVE=off turns live runs off without a code change.
//
// The spend cap counts the tokens every model call reports (src/muse.ts onUsage) at the
// published prices, and reserves a worst-case amount for each run while it is going, so
// runs in progress can never take the day over the cap. Spend is kept in a small JSON file
// (.data/live-spend.json, gitignored) so a restart does not reset it.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { IncomingMessage } from "node:http";
import type { Usage } from "../muse.js";

export type Site = "local" | "replay" | "live";

export function site(): Site {
  const v = process.env.YEBO_SITE?.trim().toLowerCase();
  return v === "replay" || v === "live" ? v : "local";
}

// US dollars per million tokens, Standard mode. Checked on 2026-10-27:
// dev.meta.ai/docs/pricing-rate-limits (muse-spark-1.3) and baseten.co/pricing
// (Muse Spark Open): input $1.25, cached input $0.15, output $4.25 for both.
const PRICE = { input: 1.25, cached: 0.15, output: 4.25 };

export function costUsd(u: Usage): number {
  const cached = Math.min(u.cached_tokens, u.prompt_tokens);
  return ((u.prompt_tokens - cached) * PRICE.input + cached * PRICE.cached + u.completion_tokens * PRICE.output) / 1_000_000;
}

export type LiveLimits = {
  enabled: boolean; // YEBO_LIVE=off turns live runs off
  perVisitorPerHour: number; // YEBO_LIVE_RUNS_PER_VISITOR_PER_HOUR
  dailyUsd: number; // YEBO_LIVE_DAILY_USD, the hard cap
  reserveUsd: number; // YEBO_LIVE_RUN_RESERVE_USD, held for each run in progress
  maxConcurrent: number; // YEBO_LIVE_MAX_CONCURRENT
  trustProxy: boolean; // YEBO_TRUST_PROXY=true behind Railway or Render's proxy
};

const num = (v: string | undefined, fallback: number) => {
  const n = Number(v);
  return v !== undefined && v.trim() !== "" && Number.isFinite(n) && n >= 0 ? n : fallback;
};

export function liveLimits(env: NodeJS.ProcessEnv = process.env): LiveLimits {
  return {
    enabled: env.YEBO_LIVE?.trim().toLowerCase() !== "off" && !!env.META_API_KEY,
    perVisitorPerHour: num(env.YEBO_LIVE_RUNS_PER_VISITOR_PER_HOUR, 3),
    dailyUsd: num(env.YEBO_LIVE_DAILY_USD, 5),
    reserveUsd: num(env.YEBO_LIVE_RUN_RESERVE_USD, 0.5),
    maxConcurrent: Math.max(1, num(env.YEBO_LIVE_MAX_CONCURRENT, 2)),
    trustProxy: env.YEBO_TRUST_PROXY === "true",
  };
}

// Who is asking. Behind a proxy the last X-Forwarded-For entry is the one the proxy added
// (earlier entries are whatever the visitor sent, so they are not trusted).
export function visitorId(req: IncomingMessage, trustProxy: boolean): string {
  const forwarded = req.headers["x-forwarded-for"];
  const header = Array.isArray(forwarded) ? forwarded.at(-1) : forwarded;
  const last = header?.split(",").map((s) => s.trim()).filter(Boolean).at(-1);
  return (trustProxy && last) || req.socket.remoteAddress || "unknown";
}

type SpendFile = { day: string; usd: number; runs: number };

const HOUR_MS = 60 * 60_000;
const MAX_VISITORS = 10_000;

export class LiveGuard {
  private readonly visits = new Map<string, number[]>();
  private running = 0;
  private reserved = 0;
  private spend: SpendFile;

  constructor(
    readonly limits: LiveLimits,
    private readonly spendFile: string | null = ".data/live-spend.json",
    private readonly now: () => number = Date.now,
  ) {
    this.spend = this.load();
  }

  private today(): string {
    return new Date(this.now()).toISOString().slice(0, 10); // UTC day
  }

  private load(): SpendFile {
    const fresh = { day: this.today(), usd: 0, runs: 0 };
    if (!this.spendFile) return fresh;
    try {
      const v = JSON.parse(readFileSync(this.spendFile, "utf8"));
      if (v?.day === fresh.day && Number.isFinite(v.usd) && Number.isFinite(v.runs)) return { day: v.day, usd: v.usd, runs: v.runs };
      return fresh;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return fresh;
      // An unreadable spend file must not hand out a fresh budget: treat the day as spent.
      return { day: fresh.day, usd: Number.POSITIVE_INFINITY, runs: 0 };
    }
  }

  private save(): void {
    if (!this.spendFile || !Number.isFinite(this.spend.usd)) return;
    mkdirSync(dirname(this.spendFile), { recursive: true });
    const tmp = `${this.spendFile}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(this.spend)}\n`);
    renameSync(tmp, this.spendFile);
  }

  private rollover(): void {
    if (this.spend.day !== this.today()) this.spend = { day: this.today(), usd: 0, runs: 0 };
  }

  status() {
    this.rollover();
    return {
      enabled: this.limits.enabled,
      spentUsd: Math.round(this.spend.usd * 10000) / 10000,
      dailyUsd: this.limits.dailyUsd,
      runsToday: this.spend.runs,
      perVisitorPerHour: this.limits.perVisitorPerHour,
    };
  }

  // Lets a live run start, or says why not. On success the caller must call done() once.
  admit(visitor: string): { ok: true; done: () => void } | { ok: false; status: number; error: string } {
    this.rollover();
    if (!this.limits.enabled) return { ok: false, status: 503, error: "Live runs are switched off. The replays still work." };
    if (this.spend.usd + this.reserved + this.limits.reserveUsd > this.limits.dailyUsd) {
      return { ok: false, status: 429, error: "Today's live budget is used up. Live runs start again tomorrow (UTC); the replays still work." };
    }
    if (this.running >= this.limits.maxConcurrent) return { ok: false, status: 429, error: "Another live run is in progress. Try again in a minute, or watch a replay." };
    const t = this.now();
    const recent = (this.visits.get(visitor) ?? []).filter((v) => t - v < HOUR_MS);
    if (recent.length >= this.limits.perVisitorPerHour) {
      return { ok: false, status: 429, error: `At most ${this.limits.perVisitorPerHour} live run${this.limits.perVisitorPerHour === 1 ? "" : "s"} per visitor per hour. The replays still work.` };
    }
    if (!this.visits.has(visitor) && this.visits.size >= MAX_VISITORS) this.prune(t);
    this.visits.set(visitor, [...recent, t]);
    this.running++;
    this.reserved += this.limits.reserveUsd;
    this.spend.runs++;
    this.save();
    let finished = false;
    return {
      ok: true,
      done: () => {
        if (finished) return;
        finished = true;
        this.running--;
        this.reserved -= this.limits.reserveUsd;
      },
    };
  }

  // Every model call's tokens, at the published prices.
  record(u: Usage): void {
    this.rollover();
    this.spend.usd += costUsd(u);
    this.save();
  }

  private prune(t: number): void {
    for (const [k, v] of this.visits) if (!v.some((x) => t - x < HOUR_MS)) this.visits.delete(k);
  }
}
