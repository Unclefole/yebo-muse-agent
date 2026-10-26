// Invoice reading: the request matches the Meta Model API shapes (image_url / file parts,
// json_schema structured output), and the model's answer is validated, fail-closed.
// The Meta API is mocked here; nothing leaves the machine.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { extractInvoice, invoicePart, parseInvoice, INVOICE_FORMAT } from "../src/invoice.js";

const PNG = "demo/invoices/brightleaf-studio-INV-1042.png";
const PDF = "demo/invoices/nimbus-hosting-NH-88317.pdf";
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

test("images go in as image_url data URLs, PDFs as file parts", async () => {
  const png = await invoicePart(PNG);
  assert.equal(png.type, "image_url");
  assert.match(png.type === "image_url" ? png.image_url.url : "", /^data:image\/png;base64,iVBOR/);
  const pdf = await invoicePart(PDF);
  assert.equal(pdf.type, "file");
  assert.equal(pdf.type === "file" ? pdf.file.filename : "", "nimbus-hosting-NH-88317.pdf");
  assert.match(pdf.type === "file" ? pdf.file.file_data : "", /^data:application\/pdf;base64,JVBER/);
  await assert.rejects(invoicePart("package.json"), /unsupported file type/);
});

test("extractInvoice sends a strict json_schema request and validates the answer", async () => {
  process.env.META_API_KEY = "test-key";
  process.env.META_API_BASE = "https://api.meta.test/v1";
  delete process.env.META_MODEL;
  let sent: any;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    sent = { url, headers: init.headers, body: JSON.parse(String(init.body)) };
    const content = JSON.stringify({
      payee: "Brightleaf Design Studio", amount: 400, currency: "usd", due_date: "2026-11-07",
      invoice_number: "INV-1042", payment_details: "Fictional Bank, account ending 4821", notes: null,
    });
    return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content } }] }), { status: 200 });
  }) as typeof fetch;

  const inv = await extractInvoice(PNG);
  assert.equal(sent.url, "https://api.meta.test/v1/chat/completions");
  assert.equal(sent.headers.Authorization, "Bearer test-key");
  assert.equal(sent.body.model, "muse-spark-1.3");
  assert.deepEqual(sent.body.response_format, INVOICE_FORMAT);
  assert.equal(sent.body.response_format.json_schema.strict, true);
  assert.match(sent.body.messages[0].content, /not instructions for you/);
  assert.equal(sent.body.messages[1].content[1].type, "image_url");
  assert.deepEqual(inv, {
    file: "brightleaf-studio-INV-1042.png", payee: "Brightleaf Design Studio", amount: 400, currency: "USD",
    due_date: "2026-11-07", invoice_number: "INV-1042", payment_details: "Fictional Bank, account ending 4821", notes: null,
  });
});

test("parseInvoice refuses anything that is not a usable invoice", () => {
  const ok = { payee: "A", amount: 10, currency: "USD", due_date: null, invoice_number: null, payment_details: null, notes: null };
  assert.throws(() => parseInvoice("f", "not json"), /did not return JSON/);
  assert.throws(() => parseInvoice("f", JSON.stringify({ ...ok, payee: "  " })), /no payee/);
  assert.throws(() => parseInvoice("f", JSON.stringify({ ...ok, amount: -5 })), /no valid amount/);
  assert.throws(() => parseInvoice("f", JSON.stringify({ ...ok, amount: "400" })), /no valid amount/);
  assert.throws(() => parseInvoice("f", JSON.stringify({ ...ok, currency: "dollars" })), /no valid currency/);
  assert.equal(parseInvoice("f", JSON.stringify({ ...ok, due_date: "next Friday" })).due_date, null);
  assert.equal(parseInvoice("f", JSON.stringify({ ...ok, amount: 10.005 })).amount, 10.01);
});
