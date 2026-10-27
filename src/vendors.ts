// Checks on the invoices the agent chose, before their limits go to a human for approval.
// Both checks can only remove invoices from the limits, never add to them; Yebo then denies
// any payment for a removed invoice (payee not approved, or over the budget).
//
//   duplicates      always on: a second invoice with the same payee and invoice number
//   vendor file     opt-in (YEBO_VENDORS=path/to/vendors.json): the payee must be on the
//                   vendor file, and every account number in the invoice's payment details
//                   must be one the file has for that vendor
//
// Yebo authorizes payments by payee name and amount; it never sees the bank account printed
// on an invoice. The vendor file is what ties a payee to the account it is really paid to.

import { readFileSync } from "node:fs";
import type { Invoice } from "./invoice.js";

export type Vendor = { name: string; accounts: string[] }; // accounts: last 4 digits
export type Rejection = { file: string; payee: string; reason: string };

const norm = (s: string) => s.normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();
const invoiceKey = (s: string) => s.normalize("NFKC").replace(/[^0-9a-z]/gi, "").toUpperCase();

// The vendor file: a JSON list of { "name": "...", "accounts": ["4821"] }. Anything
// malformed throws, so a broken file never quietly turns the check off.
export function parseVendors(json: string): Vendor[] {
  const raw = JSON.parse(json);
  if (!Array.isArray(raw) || !raw.length) throw new Error("the vendor file must be a non-empty JSON list");
  return raw.map((v, i) => {
    if (typeof v?.name !== "string" || !v.name.trim()) throw new Error(`vendor ${i + 1}: "name" is required`);
    const accounts = v.accounts;
    if (!Array.isArray(accounts) || !accounts.length || !accounts.every((a: unknown) => typeof a === "string" && /^\d{4}$/.test(a))) {
      throw new Error(`vendor ${i + 1} (${v.name}): "accounts" must list the last 4 digits of each account, e.g. ["4821"]`);
    }
    return { name: v.name.trim(), accounts };
  });
}

// The vendor file named by YEBO_VENDORS, or null when the check is off.
export function loadVendors(): Vendor[] | null {
  const path = process.env.YEBO_VENDORS?.trim();
  if (!path) return null;
  try {
    return parseVendors(readFileSync(path, "utf8"));
  } catch (err) {
    throw new Error(`YEBO_VENDORS (${path}): ${err instanceof Error ? err.message : err}`);
  }
}

// The last 4 digits of every account-like number (4 or more digits) in the payment details.
export function accountEndings(paymentDetails: string | null): string[] {
  return [...(paymentDetails ?? "").matchAll(/\d[\d -]{2,}\d/g)]
    .map((m) => m[0].replace(/\D/g, ""))
    .filter((d) => d.length >= 4)
    .map((d) => d.slice(-4));
}

// Why this invoice does not match the vendor file, or null if it does.
export function vendorRefusal(invoice: Invoice, vendors: Vendor[]): string | null {
  const vendor = vendors.find((v) => norm(v.name) === norm(invoice.payee));
  if (!vendor) return `payee '${invoice.payee}' is not on the vendor file`;
  const endings = accountEndings(invoice.payment_details);
  if (!endings.length) return `no account number in the payment details to check against the vendor file`;
  const unknown = endings.filter((e) => !vendor.accounts.includes(e));
  if (unknown.length) return `account ending ${unknown.join(", ")} is not on file for ${vendor.name} (on file: ${vendor.accounts.join(", ")})`;
  return null;
}

// Splits the chosen invoices into the ones whose limits may be approved and the ones
// refused, with a reason for each.
export function checkInvoices(invoices: Invoice[], vendors: Vendor[] | null): { passed: Invoice[]; rejected: Rejection[] } {
  const passed: Invoice[] = [];
  const rejected: Rejection[] = [];
  const seen = new Map<string, Invoice>();
  for (const inv of invoices) {
    const key = inv.invoice_number ? `${norm(inv.payee)}|${invoiceKey(inv.invoice_number)}` : null;
    const first = key ? seen.get(key) : undefined;
    let reason: string | null = first ? `duplicate of invoice ${first.invoice_number} in ${first.file}` : null;
    if (!reason && vendors) reason = vendorRefusal(inv, vendors);
    if (reason) rejected.push({ file: inv.file, payee: inv.payee, reason });
    else {
      passed.push(inv);
      if (key) seen.set(key, inv);
    }
  }
  return { passed, rejected };
}
