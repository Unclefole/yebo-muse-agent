// Reads invoices with Muse Spark and prints the extracted JSON. Nothing is paid.
//   npm run extract -- demo/invoices
//   npm run extract -- path/to/invoice.png path/to/other.pdf
import "dotenv/config";
import { readdir, stat } from "node:fs/promises";
import { extname, join } from "node:path";
import { extractInvoice, SUPPORTED_EXTENSIONS } from "./invoice.js";

async function files(args: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const arg of args) {
    if ((await stat(arg)).isDirectory()) {
      for (const name of (await readdir(arg)).sort()) {
        if (SUPPORTED_EXTENSIONS.includes(extname(name).toLowerCase())) out.push(join(arg, name));
      }
    } else out.push(arg);
  }
  return out;
}

async function main() {
  const paths = await files(process.argv.slice(2));
  if (!paths.length) throw new Error("usage: npm run extract -- <invoice files or folders>");
  const results = await Promise.allSettled(paths.map((p) => extractInvoice(p)));
  const out = results.map((r, i) =>
    r.status === "fulfilled" ? r.value : { file: paths[i], error: r.reason instanceof Error ? r.reason.message : String(r.reason) },
  );
  console.log(JSON.stringify(out, null, 2));
  if (results.some((r) => r.status === "rejected")) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
