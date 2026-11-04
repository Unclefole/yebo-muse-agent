// Turns docs/benchmark/results.json into the tables in docs/BENCHMARK.md.
//   npx tsx demo/benchmark/summarize.mts
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REPO = join(import.meta.dirname, "../..");
const data = JSON.parse(readFileSync(join(REPO, "docs/benchmark/results.json"), "utf8"));
const results: any[] = data.results;
const repeats: number[] = [...new Set(results.map((r) => r.repeat))] as number[];
const usd = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

// One number per repeat, shown as "mean (min to max)" when the repeats differ.
function span(values: number[], fmt: (n: number) => string = String): string {
  const mean = sum(values) / values.length;
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const m = Number.isInteger(mean) ? fmt(mean) : fmt(Math.round(mean * 100) / 100);
  return lo === hi ? fmt(lo) : `${m} (${fmt(lo)} to ${fmt(hi)})`;
}

function perRepeat(run: "A" | "B") {
  return repeats.map((r) => {
    const rows = results.filter((x) => x.repeat === r && x.run === run);
    const attacks = rows.flatMap((x) => x.score.attacks);
    const bad = rows.flatMap((x) => x.score.bad);
    const proposedBad = rows.flatMap((x) => x.proposed_bad);
    const invoices = sum(rows.map((x) => x.invoices));
    return {
      stopped: attacks.filter((a: any) => a.stopped).length,
      attacks: attacks.length,
      badCount: bad.length,
      badUsd: sum(bad.map((b: any) => b.amount)),
      protectedUsd: run === "A" ? 0 : sum(proposedBad.map((b: any) => b.amount)) - sum(bad.map((b: any) => b.amount)),
      clean: sum(rows.map((x) => x.score.clean_paid)),
      cleanTotal: sum(rows.map((x) => x.score.clean_total)),
      base: sum(rows.map((x) => x.score.hidden_base_paid)),
      baseTotal: sum(rows.map((x) => x.score.hidden_base_total)),
      costPer: sum(rows.map((x) => x.cost_usd)) / invoices,
      secondsPer: sum(rows.map((x) => x.seconds)) / invoices,
      problems: rows.flatMap((x) => x.problems),
      categories: attacks.reduce((m: Record<string, number>, a: any) => ({ ...m, [a.category]: (m[a.category] ?? 0) + (a.stopped ? 1 : 0) }), {}),
    };
  });
}

const A = perRepeat("A");
const B = perRepeat("B");
const col = (k: keyof (typeof A)[number], fmt?: (n: number) => string) => [span(A.map((x) => x[k] as number), fmt), span(B.map((x) => x[k] as number), fmt)];
const rows: [string, string[]][] = [
  ["Attacks stopped (of 15)", col("stopped")],
  ["Bad payments through", col("badCount")],
  ["Bad dollars through", col("badUsd", usd)],
  ["Dollars protected (bad payments Muse proposed that were blocked)", col("protectedUsd", usd)],
  ["Clean invoices paid (of 25)", col("clean")],
  ["False blocks (clean invoices not paid)", [span(A.map((x) => x.cleanTotal - x.clean)), span(B.map((x) => x.cleanTotal - x.clean))]],
  ["Real invoices behind a hidden instruction paid (of 3)", col("base")],
  ["Model cost per invoice", col("costPer", (n) => `$${n.toFixed(4)}`)],
  ["Time per invoice", col("secondsPer", (n) => `${n.toFixed(1)} s`)],
];
console.log(`${repeats.length} repeats, model ${data.model}, ${data.started} to ${data.finished}\n`);
console.log("| | Run A: Muse alone | Run B: Muse + Yebo (judge mode) |\n|---|---|---|");
for (const [name, [a, b]] of rows) console.log(`| ${name} | ${a} | ${b} |`);

const cats = ["hidden_instruction", "changed_account", "changed_payee", "over_limit", "duplicate", "expired_approval"];
const counts: Record<string, number> = { hidden_instruction: 3, changed_account: 2, changed_payee: 1, over_limit: 3, duplicate: 3, expired_approval: 3 };
console.log("\n| Attack | Count | Stopped, Run A | Stopped, Run B |\n|---|---|---|---|");
for (const c of cats) console.log(`| ${c.replace("_", " ")} | ${counts[c]} | ${span(A.map((x) => x.categories[c] ?? 0))} | ${span(B.map((x) => x.categories[c] ?? 0))} |`);

// What let each bad payment through, and what stopped each attack in Run B.
console.log("\nBad payments, every repeat:");
for (const r of results.filter((x) => x.score.bad.length)) {
  for (const b of r.score.bad) console.log(`  repeat ${r.repeat} run ${r.run} batch ${r.batch}: $${b.amount} to ${b.payee} (${b.attack ?? "matches no attack: misread or extra"})`);
}
console.log("\nRun B, what stopped things (first repeat):");
for (const r of results.filter((x) => x.run === "B" && x.repeat === repeats[0])) {
  for (const f of r.refused) console.log(`  batch ${r.batch} left out by the agent's checks: ${f.file} (${f.control}): ${f.reason}`);
  for (const d of r.decisions.filter((d: any) => d.decision !== "ALLOW")) console.log(`  batch ${r.batch} Yebo DENY: $${d.amount} to ${d.payee}: ${d.reason}`);
}
console.log("\nMissed correct payments:");
for (const r of results.filter((x) => x.score.missed.length)) console.log(`  repeat ${r.repeat} run ${r.run} batch ${r.batch}: ${r.score.missed.map((m: any) => `${m.invoice} $${m.amount}`).join(", ")}`);
const problems = results.flatMap((r) => r.problems.map((p: string) => `repeat ${r.repeat} run ${r.run} batch ${r.batch}: ${p}`));
console.log(`\nProblems: ${problems.length ? problems.join("\n  ") : "none"}`);
console.log(`Hosts contacted: ${JSON.stringify(data.hosts)}`);
