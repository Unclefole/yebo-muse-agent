// What each vendor was allowed over the last 24 hours, for the vendor file's "max_24h_usd".
// Every payment Yebo allows to a vendor that has a 24-hour limit is recorded in a local
// JSON file, so the limit holds across runs: .data/vendor-ledger.json (gitignored), or
// YEBO_LEDGER=path/to/file.json. All payments are dry runs: these are allowed payments,
// no money moved.
//   npm run ledger            what each vendor has used in the last 24 hours
//   npm run ledger -- reset   start again from zero
//
// A ledger that cannot be read stops the run: treating it as empty would silently give
// every vendor its full allowance again.

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const DAY_MS = 24 * 60 * 60_000;
export const DEFAULT_LEDGER_FILE = ".data/vendor-ledger.json";

export type LedgerEntry = { vendor: string; amount_usd: number; at: string; receipt?: string };

export interface Ledger {
  // What each vendor was allowed since this time (ms), by the vendor file's name.
  spentSince(since: number): Map<string, number>;
  record(entry: LedgerEntry): void;
}

function totals(entries: LedgerEntry[], since: number): Map<string, number> {
  const out = new Map<string, number>();
  for (const e of entries) {
    if (Date.parse(e.at) >= since) out.set(e.vendor, Math.round(((out.get(e.vendor) ?? 0) + e.amount_usd) * 100) / 100);
  }
  return out;
}

// Kept in memory only: the Controls Lab uses a fresh one per run, so each scenario gives
// the same result however often it is run.
export class MemoryLedger implements Ledger {
  readonly entries: LedgerEntry[] = [];
  spentSince(since: number) {
    return totals(this.entries, since);
  }
  record(entry: LedgerEntry) {
    this.entries.push(entry);
  }
}

export class FileLedger implements Ledger {
  constructor(readonly path: string, private readonly now: () => number = Date.now) {}

  read(): LedgerEntry[] {
    let raw: string;
    try {
      raw = readFileSync(this.path, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    const data = JSON.parse(raw);
    const ok = Array.isArray(data) && data.every((e) =>
      typeof e?.vendor === "string" && typeof e.amount_usd === "number" && Number.isFinite(e.amount_usd) && !Number.isNaN(Date.parse(e.at)));
    if (!ok) throw new Error(`the vendor ledger (${this.path}) is not valid; fix it or run: npm run ledger -- reset`);
    return data;
  }

  spentSince(since: number) {
    return totals(this.read(), since);
  }

  // Synchronous read and write, so two payments recorded by this process never interleave.
  // Entries older than 24 hours are dropped; they no longer count.
  record(entry: LedgerEntry) {
    const keep = this.read().filter((e) => Date.parse(e.at) >= this.now() - DAY_MS);
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, `${JSON.stringify([...keep, entry], null, 2)}\n`);
    renameSync(tmp, this.path);
  }

  reset() {
    rmSync(this.path, { force: true });
  }
}

export function ledgerPath(): string {
  return process.env.YEBO_LEDGER?.trim() || DEFAULT_LEDGER_FILE;
}

export function fileLedger(): FileLedger {
  return new FileLedger(ledgerPath());
}

function main() {
  const ledger = fileLedger();
  if (process.argv[2] === "reset") {
    ledger.reset();
    console.log(`Vendor ledger reset (${ledger.path}). Every vendor's 24-hour allowance starts again from zero.`);
    return;
  }
  const spent = ledger.spentSince(Date.now() - DAY_MS);
  if (!spent.size) return console.log(`Nothing allowed in the last 24 hours (${ledger.path}).`);
  console.log(`Allowed in the last 24 hours (dry run, no money moved), from ${ledger.path}:`);
  for (const [vendor, amount] of spent) console.log(`  ${vendor}: $${amount}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    main();
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }
}
