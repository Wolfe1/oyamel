import { describe, it, expect } from "vitest";
import {
  detectDelimiter,
  parseCsvRows,
  parseAmount,
  parseDate,
  detectColumnMapping,
  parseCsvContent,
  type CsvColumnMapping,
} from "../src/ingestion/csv.js";
import { TransactionType } from "../src/schema.js";

// ── detectDelimiter ────────────────────────────────────────────────────

describe("detectDelimiter", () => {
  it("detects comma", () => {
    expect(detectDelimiter("Date,Amount,Description")).toBe(",");
  });

  it("detects tab", () => {
    expect(detectDelimiter("Date\tAmount\tDescription")).toBe("\t");
  });

  it("detects semicolon", () => {
    expect(detectDelimiter("Date;Amount;Description")).toBe(";");
  });

  it("detects pipe", () => {
    expect(detectDelimiter("Date|Amount|Description")).toBe("|");
  });

  it("defaults to comma for empty string", () => {
    expect(detectDelimiter("")).toBe(",");
  });

  it("ignores delimiters inside quoted fields", () => {
    // "Date,Time" is one quoted field — the comma inside shouldn't count
    expect(detectDelimiter('"Date,Time",Amount,Description')).toBe(",");
  });
});

// ── parseCsvRows ───────────────────────────────────────────────────────

describe("parseCsvRows", () => {
  it("parses basic comma-delimited rows", () => {
    const rows = parseCsvRows("a,b,c\n1,2,3", ",");
    expect(rows).toEqual([["a", "b", "c"], ["1", "2", "3"]]);
  });

  it("handles quoted fields with embedded commas", () => {
    const rows = parseCsvRows('"Smith, John",100,test', ",");
    expect(rows[0][0]).toBe("Smith, John");
  });

  it("handles escaped double quotes", () => {
    const rows = parseCsvRows('"He said ""hello""",val', ",");
    expect(rows[0][0]).toBe('He said "hello"');
  });

  it("strips BOM", () => {
    const rows = parseCsvRows("\uFEFFa,b,c\n1,2,3", ",");
    expect(rows[0][0]).toBe("a");
  });

  it("handles trailing commas", () => {
    const rows = parseCsvRows("a,b,\n1,2,", ",");
    expect(rows[0]).toEqual(["a", "b", ""]);
  });

  it("skips empty rows", () => {
    const rows = parseCsvRows("a,b\n\n1,2", ",");
    expect(rows).toEqual([["a", "b"], ["1", "2"]]);
  });

  it("handles \\r\\n line endings", () => {
    const rows = parseCsvRows("a,b\r\n1,2\r\n", ",");
    expect(rows).toEqual([["a", "b"], ["1", "2"]]);
  });

  it("handles multiline quoted fields", () => {
    const rows = parseCsvRows('"line1\nline2",val', ",");
    expect(rows[0][0]).toBe("line1\nline2");
  });

  it("trims whitespace from fields", () => {
    const rows = parseCsvRows("  a , b , c  ", ",");
    expect(rows[0]).toEqual(["a", "b", "c"]);
  });
});

// ── parseAmount ────────────────────────────────────────────────────────

describe("parseAmount", () => {
  it("parses plain number", () => {
    expect(parseAmount("123.45")).toBe(123.45);
  });

  it("parses with dollar sign", () => {
    expect(parseAmount("$123.45")).toBe(123.45);
  });

  it("parses negative with dollar sign", () => {
    expect(parseAmount("-$123.45")).toBe(-123.45);
  });

  it("parses parenthetical negatives with dollar sign", () => {
    expect(parseAmount("($123.45)")).toBe(-123.45);
  });

  it("parses parenthetical negatives without dollar sign", () => {
    expect(parseAmount("(123.45)")).toBe(-123.45);
  });

  it("parses thousands separators", () => {
    expect(parseAmount("1,234.56")).toBe(1234.56);
  });

  it("parses thousands with dollar sign", () => {
    expect(parseAmount("$1,234.56")).toBe(1234.56);
  });

  it("parses European format", () => {
    expect(parseAmount("1.234,56")).toBe(1234.56);
  });

  it("throws on empty string", () => {
    expect(() => parseAmount("")).toThrow();
  });

  it("throws on non-numeric input", () => {
    expect(() => parseAmount("abc")).toThrow();
  });

  it("handles whitespace", () => {
    expect(parseAmount("  $100.00  ")).toBe(100);
  });
});

// ── parseDate ──────────────────────────────────────────────────────────

describe("parseDate", () => {
  it("parses ISO format", () => {
    expect(parseDate("2025-01-15")).toBe("2025-01-15");
  });

  it("parses MM/DD/YYYY", () => {
    expect(parseDate("01/15/2025")).toBe("2025-01-15");
  });

  it("parses M/D/YYYY", () => {
    expect(parseDate("1/5/2025")).toBe("2025-01-05");
  });

  it("parses MM/DD/YY", () => {
    expect(parseDate("01/15/25")).toBe("2025-01-15");
  });

  it("parses DD/MM/YYYY with explicit format", () => {
    expect(parseDate("15/01/2025", "DD/MM/YYYY")).toBe("2025-01-15");
  });

  it("parses month name format", () => {
    expect(parseDate("Jan 15, 2025")).toBe("2025-01-15");
  });

  it("parses full month name", () => {
    expect(parseDate("January 15, 2025")).toBe("2025-01-15");
  });

  it("parses MM-DD-YYYY", () => {
    expect(parseDate("01-15-2025")).toBe("2025-01-15");
  });

  it("throws on invalid date string", () => {
    expect(() => parseDate("not-a-date")).toThrow();
  });

  it("throws on empty string", () => {
    expect(() => parseDate("")).toThrow();
  });

  it("handles whitespace", () => {
    expect(parseDate("  2025-01-15  ")).toBe("2025-01-15");
  });
});

// ── detectColumnMapping ────────────────────────────────────────────────

describe("detectColumnMapping", () => {
  it("detects standard columns", () => {
    const m = detectColumnMapping(["Date", "Amount", "Description"]);
    expect(m).not.toBeNull();
    expect(m!.date).toBe("Date");
    expect(m!.amount).toBe("Amount");
    expect(m!.merchant).toBe("Description");
  });

  it("detects variant column names", () => {
    const m = detectColumnMapping(["Transaction Date", "Transaction Amount", "Merchant Name"]);
    expect(m).not.toBeNull();
    expect(m!.date).toBe("Transaction Date");
    expect(m!.amount).toBe("Transaction Amount");
    expect(m!.merchant).toBe("Merchant Name");
  });

  it("detects separate debit/credit columns", () => {
    const m = detectColumnMapping(["Date", "Debit", "Credit", "Description"]);
    expect(m).not.toBeNull();
    expect(m!.debitAmount).toBe("Debit");
    expect(m!.creditAmount).toBe("Credit");
  });

  it("is case insensitive", () => {
    const m = detectColumnMapping(["DATE", "AMOUNT", "DESCRIPTION"]);
    expect(m).not.toBeNull();
  });

  it("returns null when required columns missing", () => {
    const m = detectColumnMapping(["Foo", "Bar", "Baz"]);
    expect(m).toBeNull();
  });

  it("handles whitespace in headers", () => {
    const m = detectColumnMapping([" Date ", " Amount ", " Description "]);
    expect(m).not.toBeNull();
  });

  it("detects payee as merchant", () => {
    const m = detectColumnMapping(["Date", "Amount", "Payee"]);
    expect(m).not.toBeNull();
    expect(m!.merchant).toBe("Payee");
  });

  it("detects category column", () => {
    const m = detectColumnMapping(["Date", "Amount", "Description", "Category"]);
    expect(m).not.toBeNull();
    expect(m!.category).toBe("Category");
  });
});

// ── parseCsvContent (integration) ──────────────────────────────────────

describe("parseCsvContent", () => {
  it("parses a basic CSV", () => {
    const csv = "Date,Amount,Description\n2025-01-15,-50.00,Grocery Store\n2025-01-16,100.00,Paycheck";
    const mapping = { date: "Date", amount: "Amount", merchant: "Description" };
    const txs = parseCsvContent(csv, mapping);

    expect(txs).toHaveLength(2);
    expect(txs[0].date).toBe("2025-01-15");
    expect(txs[0].amount).toBe(50);
    expect(txs[0].txType).toBe(TransactionType.DEBIT);
    expect(txs[0].merchant).toBe("Grocery Store");
    expect(txs[1].txType).toBe(TransactionType.CREDIT);
  });

  it("handles negative-credit convention", () => {
    const csv = "Date,Amount,Description\n2025-01-15,-50.00,Refund\n2025-01-16,100.00,Purchase";
    const mapping = { date: "Date", amount: "Amount", merchant: "Description" };
    const txs = parseCsvContent(csv, mapping, { amountSign: "negative-credit" });

    expect(txs[0].txType).toBe(TransactionType.CREDIT); // negative = credit
    expect(txs[1].txType).toBe(TransactionType.DEBIT);  // positive = debit
  });

  it("handles separate debit/credit columns", () => {
    const csv = "Date,Debit,Credit,Description\n2025-01-15,50.00,,Grocery Store\n2025-01-16,,100.00,Refund";
    const mapping = { date: "Date", debitAmount: "Debit", creditAmount: "Credit", merchant: "Description" };
    const txs = parseCsvContent(csv, mapping, { amountSign: "separate-columns" });

    expect(txs).toHaveLength(2);
    expect(txs[0].txType).toBe(TransactionType.DEBIT);
    expect(txs[0].amount).toBe(50);
    expect(txs[1].txType).toBe(TransactionType.CREDIT);
    expect(txs[1].amount).toBe(100);
  });

  it("skips rows with missing date", () => {
    const csv = "Date,Amount,Description\n,50.00,Store\n2025-01-15,50.00,Store";
    const mapping = { date: "Date", amount: "Amount", merchant: "Description" };
    const txs = parseCsvContent(csv, mapping);
    expect(txs).toHaveLength(1);
  });

  it("skips rows with missing amount", () => {
    const csv = "Date,Amount,Description\n2025-01-15,,Store\n2025-01-15,50.00,Store";
    const mapping = { date: "Date", amount: "Amount", merchant: "Description" };
    const txs = parseCsvContent(csv, mapping);
    expect(txs).toHaveLength(1);
  });

  it("skips zero-amount rows", () => {
    const csv = "Date,Amount,Description\n2025-01-15,0.00,Nothing\n2025-01-15,50.00,Store";
    const mapping = { date: "Date", amount: "Amount", merchant: "Description" };
    const txs = parseCsvContent(csv, mapping);
    expect(txs).toHaveLength(1);
  });

  it("respects skipRows option", () => {
    const csv = "Bank Export Report\nGenerated 2025-01-20\nDate,Amount,Description\n2025-01-15,50.00,Store";
    const mapping = { date: "Date", amount: "Amount", merchant: "Description" };
    const txs = parseCsvContent(csv, mapping, { skipRows: 2 });
    expect(txs).toHaveLength(1);
    expect(txs[0].merchant).toBe("Store");
  });

  it("respects custom delimiter", () => {
    const csv = "Date\tAmount\tDescription\n2025-01-15\t50.00\tStore";
    const mapping = { date: "Date", amount: "Amount", merchant: "Description" };
    const txs = parseCsvContent(csv, mapping, { delimiter: "\t" });
    expect(txs).toHaveLength(1);
  });

  it("respects custom date format", () => {
    const csv = "Date,Amount,Description\n15/01/2025,50.00,Store";
    const mapping = { date: "Date", amount: "Amount", merchant: "Description" };
    const txs = parseCsvContent(csv, mapping, { dateFormat: "DD/MM/YYYY" });
    expect(txs).toHaveLength(1);
    expect(txs[0].date).toBe("2025-01-15");
  });

  it("handles BOM", () => {
    const csv = "\uFEFFDate,Amount,Description\n2025-01-15,50.00,Store";
    const mapping = { date: "Date", amount: "Amount", merchant: "Description" };
    const txs = parseCsvContent(csv, mapping);
    expect(txs).toHaveLength(1);
  });

  it("sets sourcePlugin from options", () => {
    const csv = "Date,Amount,Description\n2025-01-15,50.00,Store";
    const mapping = { date: "Date", amount: "Amount", merchant: "Description" };
    const txs = parseCsvContent(csv, mapping, { sourcePlugin: "my_plugin" });
    expect(txs[0].sourcePlugin).toBe("my_plugin");
  });

  it("defaults sourcePlugin to csv_import", () => {
    const csv = "Date,Amount,Description\n2025-01-15,50.00,Store";
    const mapping = { date: "Date", amount: "Amount", merchant: "Description" };
    const txs = parseCsvContent(csv, mapping);
    expect(txs[0].sourcePlugin).toBe("csv_import");
  });

  it("captures category when mapped", () => {
    const csv = "Date,Amount,Description,Category\n2025-01-15,50.00,Store,Groceries";
    const mapping = { date: "Date", amount: "Amount", merchant: "Description", category: "Category" };
    const txs = parseCsvContent(csv, mapping);
    expect(txs[0].category).toBe("Groceries");
  });

  it("captures notes when mapped", () => {
    const csv = "Date,Amount,Description,Memo\n2025-01-15,50.00,Store,weekly shopping";
    const mapping = { date: "Date", amount: "Amount", merchant: "Description", notes: "Memo" };
    const txs = parseCsvContent(csv, mapping);
    expect(txs[0].notes).toBe("weekly shopping");
  });

  it("throws on unknown column name", () => {
    const csv = "Date,Amount,Description\n2025-01-15,50.00,Store";
    const mapping = { date: "Date", amount: "Total", merchant: "Description" };
    expect(() => parseCsvContent(csv, mapping)).toThrow('Column "Total" (amount) not found');
  });

  it("handles column mapping by numeric index", () => {
    const csv = "2025-01-15,50.00,Store";
    const mapping = { date: 0, amount: 1, merchant: 2 };
    const txs = parseCsvContent(csv, mapping, { hasHeader: false });
    expect(txs).toHaveLength(1);
    expect(txs[0].merchant).toBe("Store");
  });
});

// ── Real-world bank CSV formats ────────────────────────────────────────
// These test auto-detection + parsing against formats modeled after
// actual CSV exports from popular banks and financial institutions.

function autoDetectAndParse(csv: string, opts?: { amountSign?: "negative-debit" | "negative-credit" | "separate-columns" }) {
  const rows = parseCsvRows(csv, detectDelimiter(csv.split("\n")[0]));
  const header = rows[0];
  const mapping = detectColumnMapping(header);
  if (!mapping) throw new Error(`Auto-detection failed for headers: ${header.join(", ")}`);
  return parseCsvContent(csv, mapping, opts);
}

describe("real-world bank CSV formats", () => {
  it("Chase credit card", () => {
    const csv = [
      "Transaction Date,Post Date,Description,Category,Type,Amount,Memo",
      "01/15/2025,01/16/2025,AMAZON.COM,Shopping,Sale,-49.99,",
      "01/14/2025,01/15/2025,WHOLE FOODS MARKET,Groceries,Sale,-82.31,",
      "01/10/2025,01/12/2025,PAYMENT THANK YOU,Payment,Payment,500.00,",
    ].join("\n");

    // Chase uses "Transaction Date" and "Description" — both auto-detectable
    // Amounts: negative = debit (purchase), positive = credit (payment)
    const txs = autoDetectAndParse(csv);
    expect(txs).toHaveLength(3);
    expect(txs[0].date).toBe("2025-01-15");
    expect(txs[0].merchant).toBe("AMAZON.COM");
    expect(txs[0].amount).toBe(49.99);
    expect(txs[0].txType).toBe(TransactionType.DEBIT);
    expect(txs[2].txType).toBe(TransactionType.CREDIT);
    expect(txs[2].amount).toBe(500);
  });

  it("Chase checking/savings", () => {
    const csv = [
      "Details,Posting Date,Description,Amount,Type,Balance,Check or Slip #",
      "DEBIT,01/15/2025,VENMO PAYMENT,-25.00,ACH_DEBIT,1234.56,",
      "CREDIT,01/14/2025,DIRECT DEPOSIT,2500.00,ACH_CREDIT,1259.56,",
    ].join("\n");

    // "Posting Date" + "Description" + "Amount" — all auto-detectable
    const txs = autoDetectAndParse(csv);
    expect(txs).toHaveLength(2);
    expect(txs[0].date).toBe("2025-01-15");
    expect(txs[0].amount).toBe(25);
    expect(txs[0].txType).toBe(TransactionType.DEBIT);
    expect(txs[1].txType).toBe(TransactionType.CREDIT);
  });

  it("Bank of America", () => {
    const csv = [
      "Posted Date,Reference Number,Payee,Address,Amount",
      "01/15/2025,1234567890,STARBUCKS STORE 12345,SEATTLE WA,-5.75",
      "01/14/2025,1234567891,UBER EATS,SAN FRANCISCO CA,-32.18",
      "01/10/2025,1234567892,Online Banking payment,,-1500.00",
    ].join("\n");

    // "Posted Date" + "Payee" + "Amount" — all auto-detectable
    const txs = autoDetectAndParse(csv);
    expect(txs).toHaveLength(3);
    expect(txs[0].date).toBe("2025-01-15");
    expect(txs[0].merchant).toBe("STARBUCKS STORE 12345");
    expect(txs[0].amount).toBe(5.75);
    expect(txs[0].txType).toBe(TransactionType.DEBIT);
  });

  it("Capital One", () => {
    const csv = [
      "Transaction Date,Posted Date,Card No.,Description,Category,Debit,Credit",
      "2025-01-15,2025-01-16,1234,NETFLIX.COM,Entertainment,15.99,",
      "2025-01-14,2025-01-15,1234,TARGET 00012345,Merchandise,47.23,",
      "2025-01-10,2025-01-12,1234,AUTOPAY PAYMENT,,,-500.00",
    ].join("\n");

    // Capital One uses separate Debit/Credit columns — auto-detectable
    const txs = autoDetectAndParse(csv, { amountSign: "separate-columns" });
    expect(txs).toHaveLength(3);
    expect(txs[0].date).toBe("2025-01-15");
    expect(txs[0].merchant).toBe("NETFLIX.COM");
    expect(txs[0].amount).toBe(15.99);
    expect(txs[0].txType).toBe(TransactionType.DEBIT);
    expect(txs[2].txType).toBe(TransactionType.CREDIT);
  });

  it("Discover card", () => {
    const csv = [
      "Trans. Date,Post Date,Description,Amount,Category",
      "01/15/2025,01/16/2025,COSTCO WHSE #1234,-125.43,Warehouse Clubs",
      "01/14/2025,01/15/2025,SHELL OIL 57442,-45.00,Gas Stations",
      "01/10/2025,01/11/2025,INTERNET PAYMENT - THANK YOU,300.00,Payments and Credits",
    ].join("\n");

    // "Trans. Date" won't auto-detect, but explicit mapping works
    const txs = parseCsvContent(csv, {
      date: "Trans. Date", amount: "Amount", merchant: "Description", category: "Category",
    });
    expect(txs).toHaveLength(3);
    expect(txs[0].date).toBe("2025-01-15");
    expect(txs[0].amount).toBe(125.43);
    expect(txs[0].category).toBe("Warehouse Clubs");
  });

  it("Wells Fargo checking", () => {
    const csv = [
      '"01/15/2025","-75.00","*","","DEBIT CARD PURCHASE WALGREENS #12345"',
      '"01/14/2025","2500.00","*","","DIRECT DEP EMPLOYER INC"',
      '"01/13/2025","-1200.00","*","","BILL PAY ELECTRIC COMPANY"',
    ].join("\n");

    // Wells Fargo has NO header row — need numeric indices
    const txs = parseCsvContent(csv, { date: 0, amount: 1, merchant: 4 }, { hasHeader: false });
    expect(txs).toHaveLength(3);
    expect(txs[0].date).toBe("2025-01-15");
    expect(txs[0].amount).toBe(75);
    expect(txs[0].merchant).toBe("DEBIT CARD PURCHASE WALGREENS #12345");
    expect(txs[0].txType).toBe(TransactionType.DEBIT);
    expect(txs[1].txType).toBe(TransactionType.CREDIT);
  });

  it("Citi credit card", () => {
    const csv = [
      "Status,Date,Description,Debit,Credit",
      "Cleared,01/15/2025,AMAZON PRIME*1A2B3C,14.99,",
      "Cleared,01/14/2025,TRADER JOE'S #123,38.47,",
      "Cleared,01/10/2025,ONLINE PAYMENT,,750.00",
    ].join("\n");

    // "Date" + "Description" + "Debit"/"Credit" — all auto-detectable
    const txs = autoDetectAndParse(csv, { amountSign: "separate-columns" });
    expect(txs).toHaveLength(3);
    expect(txs[0].merchant).toBe("AMAZON PRIME*1A2B3C");
    expect(txs[0].txType).toBe(TransactionType.DEBIT);
    expect(txs[2].txType).toBe(TransactionType.CREDIT);
    expect(txs[2].amount).toBe(750);
  });

  it("Kraken crypto exchange", () => {
    const csv = [
      '"txid","refid","time","type","subtype","aclass","asset","amount","fee","balance"',
      '"TXID01","REFID01","2025-01-15 14:30:00","trade","","currency","USD","-250.00","0.26",""',
      '"TXID02","REFID02","2025-01-14 09:15:00","trade","","currency","USD","-100.00","0.10",""',
    ].join("\n");

    // Kraken uses non-standard column names — needs explicit mapping
    const txs = parseCsvContent(csv, { date: "time", amount: "amount", merchant: "asset" });
    expect(txs).toHaveLength(2);
    expect(txs[0].date).toBe("2025-01-15");
    expect(txs[0].amount).toBe(250);
  });

  it("RBC (Canadian bank)", () => {
    const csv = [
      "Account Type,Account Number,Transaction Date,Cheque Number,Description 1,Description 2,CAD$,USD$",
      "Chequing,12345,1/15/2025,,INTERAC PURCHASE,GROCERY STORE,-45.23,",
      "Chequing,12345,1/14/2025,,DEPOSIT,PAYROLL,2500.00,",
    ].join("\n");

    // "Transaction Date" + "Description 1" are close but "Description 1" won't match "description"
    // "CAD$" won't match "amount" — needs explicit mapping
    const txs = parseCsvContent(csv, {
      date: "Transaction Date", amount: "CAD$", merchant: "Description 2",
    });
    expect(txs).toHaveLength(2);
    expect(txs[0].date).toBe("2025-01-15");
    expect(txs[0].merchant).toBe("GROCERY STORE");
    expect(txs[0].amount).toBe(45.23);
    expect(txs[0].txType).toBe(TransactionType.DEBIT);
  });

  it("European bank (semicolon delimiter, comma decimals)", () => {
    const csv = [
      "Date;Description;Amount",
      "15/01/2025;Carrefour Market;-42,50",
      "14/01/2025;SNCF Voyage;-156,00",
      "10/01/2025;Virement Salaire;2.500,00",
    ].join("\n");

    const txs = parseCsvContent(csv,
      { date: "Date", amount: "Amount", merchant: "Description" },
      { delimiter: ";", dateFormat: "DD/MM/YYYY" },
    );
    expect(txs).toHaveLength(3);
    expect(txs[0].date).toBe("2025-01-15");
    expect(txs[0].merchant).toBe("Carrefour Market");
    expect(txs[0].amount).toBe(42.50);
    expect(txs[2].amount).toBe(2500);
    expect(txs[2].txType).toBe(TransactionType.CREDIT);
  });

  it("Mint export format", () => {
    const csv = [
      '"Date","Description","Original Description","Amount","Transaction Type","Category","Account Name","Labels","Notes"',
      '"1/15/2025","Whole Foods","WHOLE FOODS MKT #10234","82.31","debit","Groceries","Chase Freedom","",""',
      '"1/14/2025","Target","TARGET 00012345","47.23","debit","Shopping","Chase Freedom","",""',
      '"1/10/2025","Paycheck","DIRECT DEPOSIT","2500.00","credit","Income","Chase Checking","",""',
    ].join("\n");

    // Mint uses "Date" + "Description" + "Amount" — auto-detectable
    const txs = autoDetectAndParse(csv);
    expect(txs).toHaveLength(3);
    expect(txs[0].date).toBe("2025-01-15");
    expect(txs[0].merchant).toBe("Whole Foods");
    // Mint amounts are always positive, "Transaction Type" column determines debit/credit
    // With default negative-debit, all positive = credit, which is wrong for Mint
    // This is a known limitation — Mint users need to use the Category or manual adjustment
  });

  it("Amex credit card", () => {
    const csv = [
      "Date,Description,Amount",
      "01/15/2025,UBER EATS,-32.18",
      "01/14/2025,SAKS FIFTH AVE,-245.00",
      "01/10/2025,PAYMENT RECEIVED,500.00",
    ].join("\n");

    // Simple format — fully auto-detectable
    const txs = autoDetectAndParse(csv);
    expect(txs).toHaveLength(3);
    expect(txs[0].date).toBe("2025-01-15");
    expect(txs[0].merchant).toBe("UBER EATS");
    expect(txs[0].amount).toBe(32.18);
    expect(txs[0].txType).toBe(TransactionType.DEBIT);
  });

  it("bank with preamble rows before header", () => {
    const csv = [
      "Account Statement",
      "Account: **** 1234",
      "Period: Jan 1 - Jan 31 2025",
      "",
      "Date,Description,Amount",
      "01/15/2025,GROCERY STORE,-50.00",
      "01/14/2025,GAS STATION,-35.00",
    ].join("\n");

    const txs = parseCsvContent(csv,
      { date: "Date", amount: "Amount", merchant: "Description" },
      { skipRows: 4 },
    );
    expect(txs).toHaveLength(2);
    expect(txs[0].merchant).toBe("GROCERY STORE");
  });
});
