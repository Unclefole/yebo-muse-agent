// Invoice reading: the request matches the Meta Model API shapes (image_url / file parts,
// json_schema structured output), and the model's answer is validated, fail-closed.
// The Meta API is mocked here; nothing leaves the machine.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { extractInvoice, invoicePart, parseInvoice, cleanPayee, normalizeDate, readerFor, OPEN_MAX_IMAGE_BYTES, INVOICE_FORMAT } from "../src/invoice.js";
import { modelSteps, readerGroups, readingLine } from "../src/runner.js";

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
  assert.throws(() => parseInvoice("f", JSON.stringify({ ...ok, payee: "  " })), /no usable payee/);
  assert.throws(() => parseInvoice("f", JSON.stringify({ ...ok, amount: -5 })), /no valid amount/);
  assert.throws(() => parseInvoice("f", JSON.stringify({ ...ok, amount: "400" })), /no valid amount/);
  assert.throws(() => parseInvoice("f", JSON.stringify({ ...ok, currency: "dollars" })), /no valid currency/);
  assert.equal(parseInvoice("f", JSON.stringify({ ...ok, due_date: "next Friday" })).due_date, null);
  assert.equal(parseInvoice("f", JSON.stringify({ ...ok, amount: 10.005 })).amount, 10.01);
});

test("payee: the Nimbus 'how to pay' block becomes just the business name", () => {
  const details = "Pay Nimbus Cloud Hosting\nFictional Bank, account ending 3350";
  // As the model returned it (newline), and as the page showed it (one line).
  assert.equal(cleanPayee("Pay Nimbus Cloud Hosting\nFictional Bank, account ending 3350", details), "Nimbus Cloud Hosting");
  assert.equal(cleanPayee("Pay Nimbus Cloud Hosting Fictional Bank, account ending 3350", details), "Nimbus Cloud Hosting");
  assert.equal(cleanPayee("Bank transfer to Brightleaf Design Studio", null), "Brightleaf Design Studio");
  assert.equal(cleanPayee("Nimbus Cloud Hosting", details), "Nimbus Cloud Hosting");
  assert.equal(cleanPayee("Juniper & Rye Catering", null), "Juniper & Rye Catering");
  // Still looks like bank details: refused, never paid.
  assert.equal(cleanPayee("Nimbus Cloud Hosting Fictional Bank, account ending 3350", null), null);
  assert.equal(cleanPayee("IBAN GB00 0000 0000", null), null);

  const parsed = parseInvoice("nimbus-hosting-NH-88317.pdf", JSON.stringify({
    payee: "Pay Nimbus Cloud Hosting\nFictional Bank, account ending 3350", amount: 89, currency: "USD", due_date: "Nov 1, 2026",
    invoice_number: "NH-88317", payment_details: details, notes: null,
  }));
  assert.equal(parsed.payee, "Nimbus Cloud Hosting");
  assert.equal(parsed.due_date, "2026-11-01");
  assert.throws(() => parseInvoice("f", JSON.stringify({ ...parsedJson(), payee: "Fictional Bank, account ending 3350" })), /no usable payee/);
});

test("due dates as printed on the samples are converted to YYYY-MM-DD", () => {
  assert.equal(normalizeDate("Nov 7, 2026"), "2026-11-07");
  assert.equal(normalizeDate("Nov 1, 2026"), "2026-11-01");
  assert.equal(normalizeDate("November 12 2026"), "2026-11-12");
  assert.equal(normalizeDate("5 Nov 2026"), "2026-11-05");
  assert.equal(normalizeDate("Nov. 5th, 2026"), "2026-11-05");
  assert.equal(normalizeDate("2026-11-07"), "2026-11-07");
  assert.equal(normalizeDate("2026/11/7"), "2026-11-07");
  assert.equal(normalizeDate("07/11/2026"), null, "day/month order is ambiguous");
  assert.equal(normalizeDate("Feb 30, 2026"), null);
  assert.equal(normalizeDate("next Friday"), null);
  assert.equal(normalizeDate(null), null);
});

function parsedJson() {
  return { payee: "A", amount: 10, currency: "USD", due_date: null, invoice_number: null, payment_details: null, notes: null };
}

test("a fenced or wrapped JSON answer still parses; a bad first answer is retried once", async () => {
  const good = { payee: "A", amount: 10, currency: "USD", due_date: null, invoice_number: null, payment_details: null, notes: null };
  assert.equal(parseInvoice("f", "```json\n" + JSON.stringify(good) + "\n```").payee, "A");
  assert.equal(parseInvoice("f", "Here is the invoice: " + JSON.stringify(good)).payee, "A");

  process.env.META_API_KEY = "test-key";
  process.env.META_API_BASE = "https://api.meta.test/v1";
  const answers = ["not json at all", JSON.stringify({ ...good, payee: "Brightleaf Design Studio" })];
  let calls = 0;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: answers[calls++] } }] }), { status: 200 })) as unknown as typeof fetch;
  assert.equal((await extractInvoice(PNG)).payee, "Brightleaf Design Studio");
  assert.equal(calls, 2);

  calls = 0;
  answers[1] = "still not json";
  await assert.rejects(extractInvoice(PNG), /did not return JSON/);
  assert.equal(calls, 2, "no more than one retry");
});

test("Open mode: images are read by Muse Spark Open; PDFs and images over 10 MB by Muse Spark", () => {
  const png = { name: "a.png", data: Buffer.alloc(10) };
  const pdf = { name: "b.PDF", data: Buffer.alloc(10) };
  const big = { name: "c.jpg", data: Buffer.alloc(OPEN_MAX_IMAGE_BYTES + 1) };
  assert.deepEqual(readerFor(png, "muse-spark"), { brain: "muse-spark" });
  assert.deepEqual(readerFor(pdf, "muse-spark"), { brain: "muse-spark" });
  assert.deepEqual(readerFor(png, "muse-spark-open"), { brain: "muse-spark-open" });
  assert.equal(readerFor(pdf, "muse-spark-open").brain, "muse-spark");
  assert.match(readerFor(pdf, "muse-spark-open").why!, /^PDF: .*does not accept PDFs/);
  assert.match(readerFor(big, "muse-spark-open").why!, /10 MB/);

  const open = readerGroups([png, pdf, png, png], "muse-spark-open");
  assert.equal(readingLine(4, open), "Reading 4 invoices: 3 with muse-spark-open, 1 with muse-spark-1.3 (PDF: Muse Spark Open on Baseten does not accept PDFs)");
  assert.equal(readingLine(2, readerGroups([png, png], "muse-spark-open")), "Reading 2 invoices with muse-spark-open");
  assert.equal(readingLine(1, readerGroups([pdf], "muse-spark")), "Reading 1 invoice with muse-spark-1.3");
  assert.deepEqual(modelSteps("muse-spark-open", open), [
    { step: "reading 3 of 4 invoices", model: "muse-spark-open", open: true },
    { step: "reading 1 of 4 invoices (PDF)", model: "muse-spark-1.3", open: false },
    { step: "hidden-request check", model: "muse-spark-open", open: true },
    { step: "planning and tool calls", model: "muse-spark-open", open: true },
  ]);
  assert.ok(modelSteps("muse-spark", readerGroups([png], "muse-spark")).every((st) => !st.open && st.model === "muse-spark-1.3"));
});
