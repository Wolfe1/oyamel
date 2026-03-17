import { describe, it, expect } from "vitest";
import { existsSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { resolve, join } from "path";
import { tmpdir } from "os";
import {
  parseStatementDate,
  parseAmount,
  cleanMerchantName,
  extractTextLines,
  parseTransactionsFromLines,
  resolvePdfPaths,
  CoinbaseOnePdfPlugin,
} from "../src/plugins/coinbase-one/pdf-parser.js";
import { TransactionType } from "../src/schema.js";

// ── parseStatementDate ──────────────────────────────────────────────

describe("parseStatementDate", () => {
  it("parses standard format", () => {
    expect(parseStatementDate("Sep 25, 2025")).toBe("2025-09-25");
  });

  it("parses single digit day", () => {
    expect(parseStatementDate("Oct 1, 2025")).toBe("2025-10-01");
  });

  it("parses January date", () => {
    expect(parseStatementDate("Jan 15, 2026")).toBe("2026-01-15");
  });

  it("parses December 31", () => {
    expect(parseStatementDate("Dec 31, 2025")).toBe("2025-12-31");
  });

  it("throws on invalid format", () => {
    expect(() => parseStatementDate("not-a-date")).toThrow("Cannot parse date");
  });

  it("throws on empty string", () => {
    expect(() => parseStatementDate("")).toThrow();
  });
});

// ── parseAmount ─────────────────────────────────────────────────────

describe("parseAmount", () => {
  it("parses simple amount", () => {
    expect(parseAmount("$49.99")).toBe(49.99);
  });

  it("parses amount with commas", () => {
    expect(parseAmount("$1,234.56")).toBe(1234.56);
  });

  it("parses large amount", () => {
    expect(parseAmount("$12,345.67")).toBe(12345.67);
  });

  it("parses small amount", () => {
    expect(parseAmount("$0.50")).toBe(0.5);
  });

  it("throws on invalid amount", () => {
    expect(() => parseAmount("abc")).toThrow("Cannot parse amount");
  });
});

// ── cleanMerchantName ───────────────────────────────────────────────

describe("cleanMerchantName", () => {
  it("cleans airline with address", () => {
    const result = cleanMerchantName(
      "SKYWAY AIRLINES INC 7890 SUMMIT RIDGE BLVD CLEARBROOK 30217 103 840",
    );
    expect(result.toLowerCase()).toContain("skyway airlines");
    expect(result).not.toMatch(/\d{5}/); // no zip code
  });

  it("removes TST* prefix", () => {
    const result = cleanMerchantName(
      "TST* GOLDEN DRAGON 0001234 123 E MAPLE AVE STE OAK VALLEY 90210 103 840",
    );
    expect(result.toLowerCase()).toContain("golden dragon");
    expect(result).not.toContain("TST*");
  });

  it("removes SQ* prefix", () => {
    const result = cleanMerchantName("SQ * COFFEE SHOP 12345");
    expect(result).not.toContain("SQ");
    expect(result.toLowerCase()).toContain("coffee shop");
  });

  it("removes PP* prefix", () => {
    const result = cleanMerchantName("PP*SUBSCRIPTION SERVICE 98765");
    expect(result).not.toContain("PP*");
    expect(result.toLowerCase()).toContain("subscription service");
  });

  it("removes CKE* prefix", () => {
    const result = cleanMerchantName("CKE*HARDEES 12345 MAIN ST");
    expect(result).not.toContain("CKE*");
  });

  it("handles BESTBUYCOM merged name", () => {
    const result = cleanMerchantName(
      "BESTBUYCOM123456789012 3 456 OAK BLVD LAKEWOOD 55001 083 840",
    );
    expect(result.toLowerCase()).toContain("bestbuy");
    expect(result.toLowerCase()).toContain(".com");
  });

  it("handles simple merchant", () => {
    const result = cleanMerchantName("COINBASE ONE SUBSCRIPTION FEE");
    expect(result.toLowerCase()).toContain("coinbase");
  });

  it("removes WWP* prefix", () => {
    const result = cleanMerchantName(
      "WWP*GREENLEAF LAWN CARE 789 RIVERSIDE DR SPRINGFIELD 62701 064 840",
    );
    expect(result).not.toContain("WWP*");
    expect(result.toLowerCase()).toContain("greenleaf");
  });

  it("removes trailing INC suffix", () => {
    const result = cleanMerchantName("ACME WIDGETS INC");
    expect(result).not.toMatch(/inc/i);
  });

  it("removes trailing LLC suffix", () => {
    const result = cleanMerchantName("TECH SERVICES LLC");
    expect(result).not.toMatch(/llc/i);
  });

  it("removes page footer text", () => {
    const result = cleanMerchantName(
      "STORE NAME Coinbase One Card is offered through Cardless",
    );
    expect(result.toLowerCase()).toContain("store name");
    expect(result).not.toContain("Cardless");
  });

  it("removes page numbers", () => {
    const result = cleanMerchantName("STORE NAME Page 2 of 5");
    expect(result.toLowerCase()).toContain("store name");
    expect(result).not.toContain("Page");
  });

  it("removes Coinbase One Card suffix", () => {
    const result = cleanMerchantName("STORE NAME Coinbase One Card");
    expect(result.toLowerCase()).toContain("store name");
    expect(result).not.toMatch(/coinbase one card/i);
  });

  it("title-cases all-uppercase merchants", () => {
    const result = cleanMerchantName("WALMART STORE");
    expect(result).toBe("Walmart Store");
  });

  it("title-cases all-lowercase merchants", () => {
    const result = cleanMerchantName("walmart store");
    expect(result).toBe("Walmart Store");
  });

  it("preserves mixed-case merchants", () => {
    const result = cleanMerchantName("McDonald's");
    expect(result).toBe("McDonald's");
  });

  it("returns empty string for whitespace-only input", () => {
    const result = cleanMerchantName("  ");
    expect(result).toBe("");
  });

  it("removes trailing terminal codes", () => {
    const result = cleanMerchantName("STORE NAME 103 840");
    expect(result).not.toMatch(/\b\d{3}\b/);
  });

  it("removes 5-digit zip codes", () => {
    const result = cleanMerchantName("STORE NAME CITY 99001");
    expect(result).not.toMatch(/99001/);
  });

  it("strips street addresses with various types", () => {
    const types = ["ST", "AVE", "BLVD", "RD", "DR", "LN", "WAY", "CT"];
    for (const t of types) {
      const result = cleanMerchantName(`STORE 123 MAIN ${t}`);
      expect(result.toLowerCase()).toContain("store");
    }
  });

  it("removes trailing numeric IDs", () => {
    const result = cleanMerchantName("STORE NAME 00023130");
    expect(result).not.toMatch(/\d{4,}/);
  });

  it("strips cardholder name appended from page footer", () => {
    const result = cleanMerchantName("AMAZON MARKETPLACE Jane Smith");
    expect(result).toBe("Amazon Marketplace");
  });

  it("strips cardholder name with longer last name", () => {
    const result = cleanMerchantName("UBER EATS John Fitzgerald");
    expect(result).toBe("Uber Eats");
  });

  it("does not strip single trailing word (not a name)", () => {
    const result = cleanMerchantName("TARGET STORE");
    expect(result).toBe("Target Store");
  });
});

// ── extractTextLines ────────────────────────────────────────────────

describe("extractTextLines", () => {
  it("strips blank lines", () => {
    const lines = extractTextLines("Hello\n\n\nWorld");
    expect(lines).toEqual(["Hello", "World"]);
  });

  it("filters Coinbase footer lines", () => {
    const text = [
      "Some transaction",
      "Coinbase One Card is offered through Cardless",
      "Page 2 of 5",
      "See Important Disclosures",
      "Another transaction",
      "Coinbase One Card",
    ].join("\n");
    const lines = extractTextLines(text);
    expect(lines).toEqual(["Some transaction", "Another transaction"]);
  });

  it("filters email-like lines", () => {
    const lines = extractTextLines("user@example.com\nReal data");
    expect(lines).toEqual(["Real data"]);
  });

  it("filters three-word name lines (cardholder name)", () => {
    const lines = extractTextLines("Jane Doe Smith\nReal data");
    expect(lines).toEqual(["Real data"]);
  });

  it("filters date-range header lines", () => {
    const lines = extractTextLines("Sep 10 – Oct 10\nTransaction data");
    expect(lines).toEqual(["Transaction data"]);
  });

  it("trims whitespace", () => {
    const lines = extractTextLines("  Hello World  ");
    expect(lines).toEqual(["Hello World"]);
  });
});

// ── parseTransactionsFromLines ──────────────────────────────────────

describe("parseTransactionsFromLines", () => {
  it("extracts basic transactions", () => {
    const lines = [
      "Some header stuff",
      "Transactions",
      "Date Description Amount",
      "Sep 25, 2025 COINBASE ONE SUBSCRIPTION FEE $49.99",
      "Sep 26, 2025 SKYWAY AIRLINES INC 7890 SUMMIT RIDGE $38.50",
      "BLVD CLEARBROOK 30217 103 840",
      "Total new charges in this period $88.49",
      "Fees",
    ];
    const { transactions, payments } = parseTransactionsFromLines(lines);
    expect(transactions).toHaveLength(2);
    expect(transactions[0].dateStr).toBe("Sep 25, 2025");
    expect(transactions[0].amountStr).toBe("$49.99");
    expect(transactions[0].description).toContain("COINBASE");
    expect(payments).toHaveLength(0);
  });

  it("handles multiline descriptions", () => {
    const lines = [
      "Transactions",
      "Date Description Amount",
      "Sep 26, 2025 TST* GOLDEN DRAGON 0001234 123 E MAPLE",
      "AVE STE OAK VALLEY 90210 103 840 $98.66",
      "Fees",
    ];
    const { transactions } = parseTransactionsFromLines(lines);
    expect(transactions).toHaveLength(1);
    expect(transactions[0].amountStr).toBe("$98.66");
    expect(transactions[0].description).toContain("GOLDEN DRAGON");
  });

  it("separates payments and transactions sections", () => {
    const lines = [
      "Payments and credits",
      "Date Description Amount",
      "Oct 15, 2025 ONLINE PAYMENT THANK YOU $500.00",
      "Total payments and credits in this period $500.00",
      "Transactions",
      "Date Description Amount",
      "Oct 16, 2025 SOME STORE $25.00",
      "Fees",
    ];
    const { transactions, payments } = parseTransactionsFromLines(lines);
    expect(payments).toHaveLength(1);
    expect(payments[0].section).toBe("payments");
    expect(transactions).toHaveLength(1);
    expect(transactions[0].section).toBe("transactions");
  });

  it("stops parsing at Interest charge section", () => {
    const lines = [
      "Transactions",
      "Sep 25, 2025 STORE A $10.00",
      "Interest charge on purchases",
      "Sep 25, 2025 SHOULD NOT APPEAR $99.00",
    ];
    const { transactions } = parseTransactionsFromLines(lines);
    expect(transactions).toHaveLength(1);
    expect(transactions[0].description).toContain("STORE A");
  });

  it("stops parsing at Important disclosures", () => {
    const lines = [
      "Transactions",
      "Sep 25, 2025 STORE A $10.00",
      "Important disclosures",
      "Sep 25, 2025 NOT A REAL TX $50.00",
    ];
    const { transactions } = parseTransactionsFromLines(lines);
    expect(transactions).toHaveLength(1);
  });

  it("stops parsing at Late payment warning", () => {
    const lines = [
      "Transactions",
      "Sep 25, 2025 STORE A $10.00",
      "Late payment warning",
      "Sep 30, 2025 FAKE $4290.00",
    ];
    const { transactions } = parseTransactionsFromLines(lines);
    expect(transactions).toHaveLength(1);
  });

  it("stops parsing at Minimum payment warning", () => {
    const lines = [
      "Transactions",
      "Sep 25, 2025 STORE A $10.00",
      "Minimum payment warning",
      "Sep 30, 2025 FAKE $4290.00",
    ];
    const { transactions } = parseTransactionsFromLines(lines);
    expect(transactions).toHaveLength(1);
  });

  it("stops parsing at Account summary", () => {
    const lines = [
      "Transactions",
      "Sep 25, 2025 STORE A $10.00",
      "Account summary",
      "Sep 30, 2025 FAKE $100.00",
    ];
    const { transactions } = parseTransactionsFromLines(lines);
    expect(transactions).toHaveLength(1);
  });

  it("skips Total rows", () => {
    const lines = [
      "Transactions",
      "Sep 25, 2025 STORE A $10.00",
      "Total new charges in this period $10.00",
      "Sep 26, 2025 STORE B $20.00",
      "Fees",
    ];
    const { transactions } = parseTransactionsFromLines(lines);
    expect(transactions).toHaveLength(2);
  });

  it("skips dash-prefixed rows", () => {
    const lines = [
      "Transactions",
      "Sep 25, 2025 STORE A $10.00",
      "- some subtotal note $10.00",
      "Fees",
    ];
    const { transactions } = parseTransactionsFromLines(lines);
    expect(transactions).toHaveLength(1);
  });

  it("ignores lines before any section header", () => {
    const lines = [
      "Sep 25, 2025 NOT A TX $10.00",
      "Random header text",
      "Transactions",
      "Sep 26, 2025 REAL TX $20.00",
      "Fees",
    ];
    const { transactions } = parseTransactionsFromLines(lines);
    expect(transactions).toHaveLength(1);
    expect(transactions[0].description).toContain("REAL TX");
  });

  it("handles continuation line that updates amount", () => {
    const lines = [
      "Transactions",
      "Sep 25, 2025 LONG MERCHANT NAME THAT WRAPS",
      "ACROSS LINES $55.00",
      "Fees",
    ];
    const { transactions } = parseTransactionsFromLines(lines);
    expect(transactions).toHaveLength(1);
    expect(transactions[0].amountStr).toBe("$55.00");
    expect(transactions[0].description).toContain("LONG MERCHANT");
    expect(transactions[0].description).toContain("ACROSS LINES");
  });

  it("handles continuation line with amount replacing existing amount", () => {
    const lines = [
      "Transactions",
      "Sep 25, 2025 MERCHANT NAME $10.00",
      "EXTRA INFO $20.00",
      "Fees",
    ];
    const { transactions } = parseTransactionsFromLines(lines);
    expect(transactions).toHaveLength(1);
    // The continuation line overwrites the amount
    expect(transactions[0].amountStr).toBe("$20.00");
  });

  it("handles multiple consecutive transactions", () => {
    const lines = [
      "Transactions",
      "Sep 25, 2025 STORE A $10.00",
      "Sep 26, 2025 STORE B $20.00",
      "Sep 27, 2025 STORE C $30.00",
      "Fees",
    ];
    const { transactions } = parseTransactionsFromLines(lines);
    expect(transactions).toHaveLength(3);
    expect(transactions[0].amountStr).toBe("$10.00");
    expect(transactions[1].amountStr).toBe("$20.00");
    expect(transactions[2].amountStr).toBe("$30.00");
  });

  it("flushes last record at end of input", () => {
    const lines = [
      "Transactions",
      "Sep 25, 2025 FINAL TX $99.00",
    ];
    const { transactions } = parseTransactionsFromLines(lines);
    expect(transactions).toHaveLength(1);
    expect(transactions[0].amountStr).toBe("$99.00");
  });

  it("returns empty when no sections found", () => {
    const lines = ["Random text", "More text"];
    const { transactions, payments } = parseTransactionsFromLines(lines);
    expect(transactions).toHaveLength(0);
    expect(payments).toHaveLength(0);
  });
});

// ── resolvePdfPaths ─────────────────────────────────────────────────

describe("resolvePdfPaths", () => {
  const tmpBase = join(tmpdir(), "monarch-test-" + Date.now());

  it("throws on non-existent path", () => {
    expect(() => resolvePdfPaths("/nonexistent/path/foo.pdf")).toThrow(
      "Path not found",
    );
  });

  it("returns single file for a file path", () => {
    mkdirSync(tmpBase, { recursive: true });
    const filePath = join(tmpBase, "test.pdf");
    writeFileSync(filePath, "fake pdf");
    try {
      const result = resolvePdfPaths(filePath);
      expect(result).toHaveLength(1);
      expect(result[0]).toBe(resolve(filePath));
    } finally {
      rmSync(tmpBase, { recursive: true });
    }
  });

  it("returns sorted PDFs from a directory", () => {
    mkdirSync(tmpBase, { recursive: true });
    writeFileSync(join(tmpBase, "b_statement.pdf"), "fake");
    writeFileSync(join(tmpBase, "a_statement.pdf"), "fake");
    writeFileSync(join(tmpBase, "readme.txt"), "not a pdf");
    try {
      const result = resolvePdfPaths(tmpBase);
      expect(result).toHaveLength(2);
      expect(result[0]).toContain("a_statement.pdf");
      expect(result[1]).toContain("b_statement.pdf");
    } finally {
      rmSync(tmpBase, { recursive: true });
    }
  });

  it("throws if directory has no PDFs", () => {
    mkdirSync(tmpBase, { recursive: true });
    writeFileSync(join(tmpBase, "readme.txt"), "not a pdf");
    try {
      expect(() => resolvePdfPaths(tmpBase)).toThrow("No PDF files found");
    } finally {
      rmSync(tmpBase, { recursive: true });
    }
  });

  it("handles .PDF uppercase extension", () => {
    mkdirSync(tmpBase, { recursive: true });
    writeFileSync(join(tmpBase, "STATEMENT.PDF"), "fake");
    try {
      const result = resolvePdfPaths(tmpBase);
      expect(result).toHaveLength(1);
    } finally {
      rmSync(tmpBase, { recursive: true });
    }
  });
});

// ── CoinbaseOnePdfPlugin.transform ──────────────────────────────────

describe("CoinbaseOnePdfPlugin.transform", () => {
  const plugin = new CoinbaseOnePdfPlugin();

  it("transforms debit records", () => {
    const raw = [
      {
        dateStr: "Sep 25, 2025",
        description: "WALMART STORE 1234 MAIN ST",
        amountStr: "$49.99",
        section: "transactions",
        txType: "debit",
      },
    ];
    const txs = plugin.transform(raw);
    expect(txs).toHaveLength(1);
    expect(txs[0].date).toBe("2025-09-25");
    expect(txs[0].amount).toBe(49.99);
    expect(txs[0].txType).toBe(TransactionType.DEBIT);
    expect(txs[0].merchant).toBe("Walmart Store");
    expect(txs[0].sourcePlugin).toBe("coinbase_one");
  });

  it("transforms credit records", () => {
    const raw = [
      {
        dateStr: "Oct 15, 2025",
        description: "ONLINE PAYMENT THANK YOU",
        amountStr: "$500.00",
        section: "payments",
        txType: "credit",
      },
    ];
    const txs = plugin.transform(raw);
    expect(txs).toHaveLength(1);
    expect(txs[0].txType).toBe(TransactionType.CREDIT);
    expect(txs[0].amount).toBe(500);
  });

  it("skips records with missing amountStr", () => {
    const raw = [
      {
        dateStr: "Sep 25, 2025",
        description: "INCOMPLETE",
        amountStr: "",
        section: "transactions",
        txType: "debit",
      },
    ];
    const txs = plugin.transform(raw);
    expect(txs).toHaveLength(0);
  });

  it("skips records with missing dateStr", () => {
    const raw = [
      {
        dateStr: "",
        description: "NO DATE",
        amountStr: "$10.00",
        section: "transactions",
        txType: "debit",
      },
    ];
    const txs = plugin.transform(raw);
    expect(txs).toHaveLength(0);
  });

  it("skips zero-amount records", () => {
    const raw = [
      {
        dateStr: "Sep 25, 2025",
        description: "ZERO TX",
        amountStr: "$0.00",
        section: "transactions",
        txType: "debit",
      },
    ];
    const txs = plugin.transform(raw);
    expect(txs).toHaveLength(0);
  });

  it("sets notes when merchant differs from raw description", () => {
    const raw = [
      {
        dateStr: "Sep 25, 2025",
        description: "TST* GOLDEN DRAGON 0001234 123 E MAPLE AVE",
        amountStr: "$98.66",
        section: "transactions",
        txType: "debit",
      },
    ];
    const txs = plugin.transform(raw);
    expect(txs).toHaveLength(1);
    expect(txs[0].notes).toBe(
      "TST* GOLDEN DRAGON 0001234 123 E MAPLE AVE",
    );
    expect(txs[0].merchant).not.toContain("TST*");
  });

  it("does not set notes when merchant matches description", () => {
    const raw = [
      {
        dateStr: "Sep 25, 2025",
        description: "Simple Store",
        amountStr: "$10.00",
        section: "transactions",
        txType: "debit",
      },
    ];
    const txs = plugin.transform(raw);
    expect(txs).toHaveLength(1);
    expect(txs[0].notes).toBeUndefined();
  });

  it("handles missing description gracefully", () => {
    const raw = [
      {
        dateStr: "Sep 25, 2025",
        amountStr: "$10.00",
        section: "transactions",
        txType: "debit",
      },
    ];
    const txs = plugin.transform(raw);
    expect(txs).toHaveLength(1);
    expect(txs[0].merchant).toBeTruthy();
  });

  it("transforms multiple records", () => {
    const raw = [
      {
        dateStr: "Sep 25, 2025",
        description: "STORE A",
        amountStr: "$10.00",
        section: "transactions",
        txType: "debit",
      },
      {
        dateStr: "Sep 26, 2025",
        description: "STORE B",
        amountStr: "$20.00",
        section: "transactions",
        txType: "debit",
      },
      {
        dateStr: "Oct 1, 2025",
        description: "PAYMENT",
        amountStr: "$30.00",
        section: "payments",
        txType: "credit",
      },
    ];
    const txs = plugin.transform(raw);
    expect(txs).toHaveLength(3);
    expect(txs[0].txType).toBe(TransactionType.DEBIT);
    expect(txs[2].txType).toBe(TransactionType.CREDIT);
  });

  it("throws on invalid date in record", () => {
    const raw = [
      {
        dateStr: "Invalid Date",
        description: "STORE",
        amountStr: "$10.00",
        section: "transactions",
        txType: "debit",
      },
    ];
    expect(() => plugin.transform(raw)).toThrow("Error parsing record 1");
  });

  it("does not leak raw record data in error messages", () => {
    const raw = [
      {
        dateStr: "Invalid Date",
        description: "SECRET MERCHANT",
        amountStr: "$999.99",
        section: "transactions",
        txType: "debit",
      },
    ];
    try {
      plugin.transform(raw);
      expect.unreachable("should have thrown");
    } catch (e: any) {
      expect(e.message).not.toContain("SECRET MERCHANT");
      expect(e.message).not.toContain("999.99");
      expect(e.message).toContain("Error parsing record 1");
    }
  });
});

// ── CoinbaseOnePdfPlugin.metadata ───────────────────────────────────

describe("CoinbaseOnePdfPlugin.metadata", () => {
  const plugin = new CoinbaseOnePdfPlugin();

  it("returns correct plugin id", () => {
    expect(plugin.metadata().id).toBe("coinbase-one");
  });

  it("returns a name and description", () => {
    const meta = plugin.metadata();
    expect(meta.name).toBeTruthy();
    expect(meta.description).toBeTruthy();
  });
});

// ── CoinbaseOnePdfPlugin integration (real PDF) ─────────────────────
// To run integration tests with a real PDF, set the OYAMEL_TEST_PDF
// environment variable to the path of a Coinbase One statement PDF.
//
//   OYAMEL_TEST_PDF=path/to/statement.pdf npm test

describe("CoinbaseOnePdfPlugin integration", () => {
  const REAL_PDF = process.env.OYAMEL_TEST_PDF ?? "";

  it("parses real PDF if available", async () => {
    if (!REAL_PDF || !existsSync(REAL_PDF)) {
      return; // Skip if no PDF path provided
    }

    const plugin = new CoinbaseOnePdfPlugin();
    const transactions = await plugin.sync({ file_path: REAL_PDF });

    expect(transactions.length).toBeGreaterThan(0);

    const first = transactions[0];
    expect(first.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(first.amount).toBeGreaterThan(0);
    expect(first.sourcePlugin).toBe("coinbase_one");

    for (const tx of transactions) {
      console.log(
        `  ${tx.date}  $${tx.amount.toFixed(2).padStart(10)}  ${tx.merchant}`,
      );
    }
  });
});
