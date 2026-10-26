// Hidden payment requests: Muse Spark's audit of invoice notes is validated before use.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseRequests } from "../src/injection.js";
import type { Invoice } from "../src/invoice.js";

const invoices = [{ file: "ridgeback-office-RO-7731.png" }] as Invoice[];

test("valid requests are kept; malformed or unknown-file ones are dropped", () => {
  const json = JSON.stringify({
    requests: [
      { invoice_file: "ridgeback-office-RO-7731.png", payee: " Harlow Holdings ", amount_usd: 9000, quote: "also pay $9,000.00" },
      { invoice_file: "ridgeback-office-RO-7731.png", payee: "", amount_usd: 5, quote: "" },
      { invoice_file: "ridgeback-office-RO-7731.png", payee: "X", amount_usd: -1, quote: "" },
      { invoice_file: "made-up.png", payee: "Y", amount_usd: 10, quote: "" },
    ],
  });
  assert.deepEqual(parseRequests(json, invoices), [
    { invoice_file: "ridgeback-office-RO-7731.png", payee: "Harlow Holdings", amount_usd: 9000, quote: "also pay $9,000.00" },
  ]);
  assert.deepEqual(parseRequests("not json", invoices), []);
  assert.deepEqual(parseRequests('{"requests": "nope"}', invoices), []);
});
