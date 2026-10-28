// Replays: real recorded runs that the hosted demo plays back with no model calls.
//
// Recording: start the web app with YEBO_RECORD_DIR=some/folder and every run that finishes
// is written there as JSON (the input and each event with its time). Then keep a good one:
//   npm run replay -- save <recording.json> <id> "<title>" "<one-line summary>"
// which cleans it (no local URLs) and writes demo/replays/<id>.json. Events are kept exactly
// as the run emitted them; only the approval link, which pointed at this machine, is removed.

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { RunEvent } from "../runner.js";

export type RecordedEvent = { ms: number; event: RunEvent };

// What the server writes for each finished run when YEBO_RECORD_DIR is set.
export type Recording = {
  recordedAt: string;
  mode: string; // gateway mode: judge or live
  input: { goal: string; brain: string; attackDemo: boolean; invoices: string[]; scenario?: string; heard?: { model: string; transcript: string } };
  events: RecordedEvent[];
};

export type Replay = Recording & { id: string; title: string; summary: string };

const ID = /^[a-z0-9-]{1,60}$/;

// Removes what only made sense on the machine that recorded it.
export function clean(rec: Recording): Recording {
  return {
    ...rec,
    events: rec.events.map(({ ms, event }) => ({ ms, event: event.type === "mission" ? { ...event, authorizeUrl: "" } : event })),
  };
}

export function toReplay(rec: Recording, id: string, title: string, summary: string): Replay {
  if (!ID.test(id)) throw new Error("the replay id must be lowercase letters, digits and dashes");
  if (!rec.events.some((e) => e.event.type === "done")) throw new Error("only a run that finished can be a replay");
  return { id, title, summary, ...clean(rec) };
}

function isReplay(v: any): v is Replay {
  return v && ID.test(v.id) && typeof v.title === "string" && typeof v.summary === "string" && typeof v.recordedAt === "string"
    && Array.isArray(v.events) && v.events.every((e: any) => Number.isFinite(e?.ms) && typeof e?.event?.type === "string");
}

export function loadReplays(dir: string): Replay[] {
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith(".json")).sort();
  } catch {
    return [];
  }
  return names.flatMap((n) => {
    try {
      const v = JSON.parse(readFileSync(join(dir, n), "utf8"));
      return isReplay(v) ? [v] : [];
    } catch {
      return [];
    }
  });
}

// When to play each event: the recorded timing, with long waits (reading, planning, the
// approval page) shortened so a replay takes well under a minute. Returns ms from start.
export const MAX_GAP_MS = 1500;
export function schedule(events: RecordedEvent[], maxGap = MAX_GAP_MS): number[] {
  let t = 0;
  return events.map((e, i) => {
    if (i > 0) t += Math.min(Math.max(0, e.ms - events[i - 1].ms), maxGap);
    return t;
  });
}

// What the page lists (no events).
export function describeReplays(replays: Replay[]) {
  return replays.map((r) => {
    const started = r.events.find((e) => e.event.type === "started")?.event;
    const decisions = r.events.flatMap((e) => (e.event.type === "decision" ? [e.event.decision] : []));
    return {
      id: r.id, title: r.title, summary: r.summary, recordedAt: r.recordedAt, mode: r.mode,
      model: started?.type === "started" ? started.model : null,
      heard: r.input.heard ?? null,
      invoices: r.input.invoices.length,
      allowed: decisions.filter((d) => d === "ALLOW").length,
      denied: decisions.filter((d) => d === "DENY").length,
    };
  });
}

function main() {
  const [cmd, file, id, title, summary] = process.argv.slice(2);
  if (cmd !== "save" || !file || !id || !title || !summary) {
    console.error('usage: npm run replay -- save <recording.json> <id> "<title>" "<summary>"');
    process.exit(1);
  }
  const replay = toReplay(JSON.parse(readFileSync(file, "utf8")), id, title, summary);
  const out = join(fileURLToPath(new URL("../../demo/replays/", import.meta.url)), `${id}.json`);
  writeFileSync(out, `${JSON.stringify(replay, null, 1)}\n`);
  console.log(`Saved ${out} (${replay.events.length} events, recorded ${replay.recordedAt}).`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
