// Checks on the invoices the agent chose, before their limits go to a human for approval.
// Both checks can only remove invoices from the limits, never add to them; Yebo then denies
// any payment for a removed invoice (payee not approved, or over the budget).
//
//   duplicates      always on: a second invoice with the same payee and invoice number
//                   (look-alike letters count as the real ones); an invoice number with a
//                   hidden character or mixed scripts is refused as tampered; copies of one
//                   invoice with different totals are all refused
//   vendor file     on by default (demo/vendors.json; YEBO_VENDORS=path/to/file to use
//                   another, YEBO_VENDORS=off to turn it off): the payee must be on the
//                   vendor file, and every account number in the invoice's payment details
//                   must be one the file has for that vendor. The mission's payees are the
//                   vendor file's names, so a payee that is not on it is outside the mission.
//                   An optional per-vendor "max_per_run_usd" caps what one run may pay that
//                   vendor in total (e.g. a monthly bill reissued under a new number).
//                   An optional "max_24h_usd" caps what that vendor may be paid in any 24
//                   hours, across runs (spend is kept in src/ledger.ts). A vendor with
//                   "status": "inactive" is kept on file but not paid.
//
// Yebo authorizes payments by payee name and amount; it never sees the bank account printed
// on an invoice. The vendor file is what ties a payee to the account it is really paid to.

import { readFileSync } from "node:fs";
import type { Invoice } from "./invoice.js";

export type Vendor = {
  name: string;
  accounts: string[]; // last 4 digits
  max_per_run_usd?: number;
  max_24h_usd?: number;
  status?: "active" | "inactive"; // active when absent
};
// Which check left an invoice out of the limits. All of them run in the agent's code.
export type Control = "reference" | "duplicate" | "unknown_vendor" | "inactive" | "account" | "per_run" | "24h";
export type Rejection = { file: string; payee: string; amount: number; control: Control; reason: string };

const norm = (s: string) => s.normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();
// Cyrillic and Greek letters that look like Latin ones, so a look-alike invoice number
// ("ОRD-1042" with a Cyrillic О) is the same invoice as the real one.
const LOOKALIKES: Record<string, string> = Object.fromEntries(
  [..."АВЕЅІЈКМНОРСТХУаеіјорсхуѕԁԛԝΑΒΕΖΗΙΚΜΝΟΡΤΥΧοιν"].map((c, i) => [c, "ABESIJKMHOPCTXYaeijopcxysdqwABEZHIKMNOPTYXoiv"[i]]),
);
const invoiceKey = (s: string) => [...s.normalize("NFKC")].map((c) => LOOKALIKES[c] ?? c).join("").replace(/[^0-9a-z]/gi, "").toUpperCase();

// Why an invoice number looks tampered with, or null: a hidden character (zero-width space,
// direction mark, soft hyphen...) or Latin letters mixed with Cyrillic or Greek ones. Such an
// invoice is refused, never paid as a new bill.
export function referenceRefusal(invoiceNumber: string | null): string | null {
  if (!invoiceNumber) return null;
  const hidden = [...invoiceNumber].filter((c) => /[\p{Cf}\p{Zl}\p{Zp}\u00a0\u2000-\u200a\u202f\u205f\u3000]/u.test(c));
  const shown = JSON.stringify(invoiceNumber.replace(/[^\x20-\x7e]/g, (c) => `<U+${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}>`));
  if (hidden.length) return `invoice number ${shown} contains a hidden character`;
  if (/\p{Script=Latin}/u.test(invoiceNumber) && /[\p{Script=Cyrillic}\p{Script=Greek}]/u.test(invoiceNumber)) {
    return `invoice number ${shown} mixes Latin letters with look-alike Cyrillic or Greek ones`;
  }
  return null;
}

// The vendor file: a JSON list of { "name": "...", "accounts": ["4821"], "max_per_run_usd": 89,
// "max_24h_usd": 1000, "status": "inactive" } (the last three are optional). Anything
// malformed throws, so a broken file never quietly turns a check off.
export function parseVendors(json: string): Vendor[] {
  const raw = JSON.parse(json);
  if (!Array.isArray(raw) || !raw.length) throw new Error("the vendor file must be a non-empty JSON list");
  return raw.map((v, i) => {
    if (typeof v?.name !== "string" || !v.name.trim()) throw new Error(`vendor ${i + 1}: "name" is required`);
    const accounts = v.accounts;
    if (!Array.isArray(accounts) || !accounts.length || !accounts.every((a: unknown) => typeof a === "string" && /^\d{4}$/.test(a))) {
      throw new Error(`vendor ${i + 1} (${v.name}): "accounts" must list the last 4 digits of each account, e.g. ["4821"]`);
    }
    for (const key of ["max_per_run_usd", "max_24h_usd"] as const) {
      const cap = v[key];
      if (cap !== undefined && !(typeof cap === "number" && Number.isFinite(cap) && cap > 0)) {
        throw new Error(`vendor ${i + 1} (${v.name}): "${key}" must be a number above zero`);
      }
    }
    if (v.status !== undefined && v.status !== "active" && v.status !== "inactive") {
      throw new Error(`vendor ${i + 1} (${v.name}): "status" must be "active" or "inactive"`);
    }
    return {
      name: v.name.trim(),
      accounts,
      ...(v.max_per_run_usd !== undefined ? { max_per_run_usd: v.max_per_run_usd } : {}),
      ...(v.max_24h_usd !== undefined ? { max_24h_usd: v.max_24h_usd } : {}),
      ...(v.status !== undefined ? { status: v.status } : {}),
    };
  });
}

export const DEFAULT_VENDOR_FILE = "demo/vendors.json";

// The vendor file (YEBO_VENDORS, or demo/vendors.json when unset), or null when
// YEBO_VENDORS=off.
export function loadVendors(): Vendor[] | null {
  const setting = process.env.YEBO_VENDORS?.trim();
  if (setting?.toLowerCase() === "off") return null;
  return loadVendorFile(setting || DEFAULT_VENDOR_FILE, "YEBO_VENDORS");
}

export function loadVendorFile(path: string, label = "vendor file"): Vendor[] {
  try {
    return parseVendors(readFileSync(path, "utf8"));
  } catch (err) {
    throw new Error(`${label} (${path}): ${err instanceof Error ? err.message : err}`);
  }
}

// The last 4 digits of every account-like number (4 or more digits) in the payment details.
export function accountEndings(paymentDetails: string | null): string[] {
  return [...(paymentDetails ?? "").matchAll(/\d[\d -]{2,}\d/g)]
    .map((m) => m[0].replace(/\D/g, ""))
    .filter((d) => d.length >= 4)
    .map((d) => d.slice(-4));
}

// The vendor file's name for this payee (case and spacing do not matter), or null.
export function vendorName(payee: string, vendors: Vendor[]): string | null {
  return vendors.find((v) => norm(v.name) === norm(payee))?.name ?? null;
}

// The vendor file's entry for this payee (case and spacing do not matter), or undefined.
export function vendorFor(payee: string, vendors: Vendor[]): Vendor | undefined {
  return vendors.find((v) => norm(v.name) === norm(payee));
}

// Why this invoice does not match the vendor file, and which check says so, or null if it does.
function vendorMismatch(invoice: Invoice, vendors: Vendor[]): { control: Control; reason: string } | null {
  const vendor = vendorFor(invoice.payee, vendors);
  if (!vendor) return { control: "unknown_vendor", reason: `payee '${invoice.payee}' is not on the vendor file` };
  if (vendor.status === "inactive") return { control: "inactive", reason: `${vendor.name} is inactive on the vendor file` };
  const endings = accountEndings(invoice.payment_details);
  if (!endings.length) return { control: "account", reason: `no account number in the payment details to check against the vendor file` };
  const unknown = endings.filter((e) => !vendor.accounts.includes(e));
  if (unknown.length) return { control: "account", reason: `account ending ${unknown.join(", ")} is not on file for ${vendor.name} (on file: ${vendor.accounts.join(", ")})` };
  return null;
}

// Why this invoice does not match the vendor file, or null if it does.
export function vendorRefusal(invoice: Invoice, vendors: Vendor[]): string | null {
  return vendorMismatch(invoice, vendors)?.reason ?? null;
}

const usd = (n: number) => `$${(Math.round(n * 100) / 100).toLocaleString("en-US")}`;

// Why paying this vendor `amount` more would break one of its caps, or null if it would not.
// thisRun: already accepted in this run; last24h: allowed in earlier runs in the last 24 hours.
export function capRefusal(vendor: Vendor, amount: number, thisRun: number, last24h: number): { control: Control; reason: string } | null {
  if (vendor.max_per_run_usd !== undefined && thisRun + amount > vendor.max_per_run_usd + 1e-9) {
    return { control: "per_run", reason: `over the vendor file's limit for ${vendor.name}: ${usd(vendor.max_per_run_usd)} per run (${usd(thisRun)} already in this run)` };
  }
  if (vendor.max_24h_usd !== undefined && last24h + thisRun + amount > vendor.max_24h_usd + 1e-9) {
    return { control: "24h", reason: `over the vendor file's 24-hour limit for ${vendor.name}: ${usd(vendor.max_24h_usd)} per 24 hours (${usd(last24h + thisRun)} already used)` };
  }
  return null;
}

// Splits the chosen invoices into the ones whose limits may be approved and the ones
// refused, with a reason for each. last24h: what each vendor (by the file's name) was
// allowed in earlier runs over the last 24 hours, for "max_24h_usd".
export function checkInvoices(
  invoices: Invoice[], vendors: Vendor[] | null, last24h: ReadonlyMap<string, number> = new Map(),
): { passed: Invoice[]; rejected: Rejection[] } {
  const passed: Invoice[] = [];
  const rejected: Rejection[] = [];
  const seen = new Map<string, Invoice>();
  const paid = new Map<string, number>(); // per vendor, in this run, for the caps
  const keyOf = (inv: Invoice) => (inv.invoice_number ? `${norm(inv.payee)}|${invoiceKey(inv.invoice_number)}` : null);
  // Copies of one invoice that disagree on the amount: none of them is paid, since there is
  // no telling which total is right (the first one read is not trusted over the others).
  const byKey = new Map<string, Invoice[]>();
  for (const inv of invoices) {
    const key = keyOf(inv);
    if (key) byKey.set(key, [...(byKey.get(key) ?? []), inv]);
  }
  const conflict = (key: string | null) => {
    const copies = key ? byKey.get(key) ?? [] : [];
    if (new Set(copies.map((c) => `${c.currency}|${Math.round(c.amount * 100)}`)).size < 2) return null;
    return `conflicting totals for invoice ${copies[0].invoice_number}: ${copies.map((c) => `${c.currency} ${c.amount} in ${c.file}`).join(", ")}`;
  };
  for (const inv of invoices) {
    const key = keyOf(inv);
    const first = key ? seen.get(key) : undefined;
    const tampered = referenceRefusal(inv.invoice_number);
    const conflicting = conflict(key);
    let refusal: { control: Control; reason: string } | null = tampered
      ? { control: "reference", reason: first ? `${tampered}; it matches invoice ${first.invoice_number} in ${first.file}` : tampered }
      : conflicting
        ? { control: "duplicate", reason: conflicting }
        : first
          ? { control: "duplicate", reason: `duplicate of invoice ${first.invoice_number} in ${first.file}` }
          : null;
    if (!refusal && vendors) refusal = vendorMismatch(inv, vendors);
    const vendor = vendors ? vendorFor(inv.payee, vendors) : undefined;
    const before = vendor ? paid.get(vendor.name) ?? 0 : 0;
    if (!refusal && vendor) refusal = capRefusal(vendor, inv.amount, before, last24h.get(vendor.name) ?? 0);
    if (refusal) rejected.push({ file: inv.file, payee: inv.payee, amount: inv.amount, ...refusal });
    else {
      passed.push(inv);
      if (key) seen.set(key, inv);
      if (vendor) paid.set(vendor.name, Math.round((before + inv.amount) * 100) / 100);
    }
  }
  return { passed, rejected };
}
