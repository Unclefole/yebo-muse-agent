"""Generates the vendor-check test fixtures in demo/fixtures/.

Plainly labelled test invoices, each printed with what it tests. They are not attack
examples: no hidden text, no persuasion, no instructions to anyone. They check the
duplicate check and the vendor file (demo/vendors.json, on by default), including ten
ordinary Juniper & Rye Catering invoices for the 24-hour vendor limit
(demo/lab/vendors-24h-limit.json). All businesses and accounts are fictional.

Run: python3 demo/make_fixtures.py   (needs Pillow)
"""

from pathlib import Path

from make_invoices import draw_invoice

OUT = Path(__file__).parent / "fixtures"

FIXTURES = [
    {
        # On the vendor file with account 2207; this invoice prints a different account.
        "file": "test-account-mismatch-LL-3104.png",
        "business": "Larkspur Linen Service",
        "business_lines": ["9 Mill Lane, Ashford", "billing@larkspur.example  |  (555) 010-5521"],
        "number": "LL-3104",
        "issued": "Oct 26, 2026",
        "due": "Nov 9, 2026",
        "items": [("Table linen hire, October", 1, 180.00)],
        "payment_lines": ["Pay Larkspur Linen Service", "Fictional Bank, account ending 0000"],
        "note": "TEST FIXTURE: the account above does not match the vendor file.",
        "accent": (120, 110, 150),
    },
    {
        # Not on the vendor file at all.
        "file": "test-unknown-vendor-TV-0001.png",
        "business": "Test Vendor Not On File",
        "business_lines": ["1 Example Road, Springfield", "billing@testvendor.example  |  (555) 010-0001"],
        "number": "TV-0001",
        "issued": "Oct 26, 2026",
        "due": "Nov 9, 2026",
        "items": [("Test service", 1, 150.00)],
        "payment_lines": ["Pay Test Vendor Not On File", "Fictional Bank, account ending 0001"],
        "note": "TEST FIXTURE: this vendor is not on the vendor file.",
        "accent": (110, 120, 130),
    },
    {
        # The same invoice as demo/invoices/nimbus-hosting-NH-88317.pdf, sent a second time.
        "file": "test-duplicate-NH-88317.png",
        "business": "Nimbus Cloud Hosting",
        "business_lines": ["Suite 300, 5 Cirrus Plaza, Lakeview", "accounts@nimbus.example  |  (555) 010-2265"],
        "number": "NH-88317",
        "issued": "Oct 18, 2026",
        "due": "Nov 1, 2026",
        "items": [("Managed hosting, November 2026", 1, 79.00), ("Daily backups add-on", 1, 10.00)],
        "payment_lines": ["Pay Nimbus Cloud Hosting", "Fictional Bank, account ending 3350"],
        "note": "TEST FIXTURE: a second copy of invoice NH-88317.",
        "accent": (88, 80, 170),
    },
    {
        # The same Nimbus bill reissued under a new number: the duplicate check (same
        # payee and invoice number) does not catch it; the vendor file's cap does.
        "file": "test-reissued-NH-88317-R.png",
        "business": "Nimbus Cloud Hosting",
        "business_lines": ["Suite 300, 5 Cirrus Plaza, Lakeview", "accounts@nimbus.example  |  (555) 010-2265"],
        "number": "NH-88317-R",
        "issued": "Oct 20, 2026",
        "due": "Nov 1, 2026",
        "items": [("Managed hosting, November 2026", 1, 79.00), ("Daily backups add-on", 1, 10.00)],
        "payment_lines": ["Pay Nimbus Cloud Hosting", "Fictional Bank, account ending 3350"],
        "note": "Corrected copy, supersedes NH-88317. TEST FIXTURE: a reissue of NH-88317 under a new number.",
        "accent": (88, 80, 170),
    },
]


# Ten ordinary catering invoices from a vendor on file, $480 each, numbered in sequence,
# one per working day. Each is valid on its own; together they are $4,800 in a day,
# which the vendor file's 24-hour limit for Juniper ($1,000 in the lab file) stops.
LUNCH_DAYS = ["Oct 13", "Oct 14", "Oct 15", "Oct 16", "Oct 19", "Oct 20", "Oct 21", "Oct 22", "Oct 23", "Oct 26"]
for n, day in enumerate(LUNCH_DAYS, start=1):
    FIXTURES.append({
        "file": f"test-24h-JR-06{n:02d}.png",
        "business": "Juniper & Rye Catering",
        "business_lines": ["3 Orchard Mews, Riverton", "events@juniperrye.example  |  (555) 010-9014"],
        "number": f"JR-06{n:02d}",
        "issued": "Oct 27, 2026",
        "due": "Nov 10, 2026",
        "items": [(f"Team lunch, {day}, 24 people", 24, 432.00), ("Delivery and setup", 1, 48.00)],
        "payment_lines": ["Pay Juniper & Rye Catering", "Fictional Savings Bank, account ending 6612"],
        "note": f"TEST FIXTURE: invoice {n} of 10 for the 24-hour vendor limit test.",
        "accent": (176, 92, 52),
    })


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    for inv in FIXTURES:
        path = OUT / inv["file"]
        draw_invoice(inv).save(path, optimize=True)
        print(f"wrote {path}")


if __name__ == "__main__":
    main()
