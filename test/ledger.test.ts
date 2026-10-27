// The vendor ledger: what each vendor was allowed in the last 24 hours, kept across runs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DAY_MS, FileLedger, MemoryLedger } from "../src/ledger.js";

const dir = mkdtempSync(join(tmpdir(), "yebo-ledger-"));
const T0 = Date.parse("2026-10-27T12:00:00Z");

test("file ledger: totals per vendor inside the window, old entries dropped on write", () => {
  let now = T0;
  const ledger = new FileLedger(join(dir, "nested", "ledger.json"), () => now);
  assert.deepEqual(ledger.spentSince(0), new Map(), "a missing file is an empty ledger");
  ledger.record({ vendor: "Juniper & Rye Catering", amount_usd: 480, at: new Date(now).toISOString() });
  ledger.record({ vendor: "Juniper & Rye Catering", amount_usd: 480, at: new Date(now).toISOString(), receipt: "rcpt_1" });
  ledger.record({ vendor: "Nimbus Cloud Hosting", amount_usd: 89, at: new Date(now).toISOString() });
  assert.deepEqual(ledger.spentSince(now - DAY_MS), new Map([["Juniper & Rye Catering", 960], ["Nimbus Cloud Hosting", 89]]));
  now = T0 + DAY_MS + 1;
  assert.deepEqual(ledger.spentSince(now - DAY_MS), new Map(), "after 24 hours nothing counts");
  ledger.record({ vendor: "Nimbus Cloud Hosting", amount_usd: 10, at: new Date(now).toISOString() });
  assert.equal(JSON.parse(readFileSync(ledger.path, "utf8")).length, 1, "expired entries are dropped");
  ledger.reset();
  assert.equal(existsSync(ledger.path), false);
});

test("a broken ledger stops the run instead of giving every vendor its allowance back", () => {
  const path = join(dir, "broken.json");
  writeFileSync(path, '[{"vendor":"X","amount_usd":"lots"}]');
  assert.throws(() => new FileLedger(path).spentSince(0), /not valid.*npm run ledger -- reset/);
  writeFileSync(path, "not json");
  assert.throws(() => new FileLedger(path).spentSince(0));
});

test("memory ledger: same totals, nothing written", () => {
  const ledger = new MemoryLedger();
  ledger.record({ vendor: "A", amount_usd: 1.1, at: new Date(T0).toISOString() });
  ledger.record({ vendor: "A", amount_usd: 2.2, at: new Date(T0).toISOString() });
  assert.deepEqual(ledger.spentSince(T0 - 1), new Map([["A", 3.3]]));
});
