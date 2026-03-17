/** Shared CSV parsing utility for plugins that import CSV files. */

import { readFileSync } from "fs";
import { type Transaction, TransactionType } from "../schema.js";

// ── Interfaces ─────────────────────────────────────────────────────────

/** Maps Transaction fields to CSV column names or 0-based indices. */
export interface CsvColumnMapping {
  date: string | number;
  amount?: string | number;
  merchant: string | number;
  debitAmount?: string | number;
  creditAmount?: string | number;
  category?: string | number;
  notes?: string | number;
}

export interface CsvParseOptions {
  delimiter?: string;
  dateFormat?: string;
  hasHeader?: boolean;
  skipRows?: number;
  amountSign?: "negative-debit" | "negative-credit" | "separate-columns";
  sourcePlugin?: string;
}

// ── Delimiter detection ────────────────────────────────────────────────

const DELIMITERS = [",", "\t", ";", "|"] as const;

export function detectDelimiter(line: string): string {
  let inQuotes = false;
  const counts = new Map<string, number>();
  for (const d of DELIMITERS) counts.set(d, 0);

  for (const ch of line) {
    if (ch === '"') {
      inQuotes = !inQuotes;
    } else if (!inQuotes && counts.has(ch)) {
      counts.set(ch, counts.get(ch)! + 1);
    }
  }

  let best = ",";
  let bestCount = 0;
  for (const [d, c] of counts) {
    if (c > bestCount) {
      best = d;
      bestCount = c;
    }
  }
  return best;
}

// ── CSV row parser (RFC 4180) ──────────────────────────────────────────

export function parseCsvRows(content: string, delimiter: string): string[][] {
  // Strip BOM
  if (content.charCodeAt(0) === 0xfeff) content = content.slice(1);

  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = 0;

  while (i < content.length) {
    const ch = content[i];

    if (inQuotes) {
      if (ch === '"') {
        if (i + 1 < content.length && content[i + 1] === '"') {
          field += '"';
          i += 2;
        } else {
          inQuotes = false;
          i++;
        }
      } else {
        field += ch;
        i++;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
        i++;
      } else if (ch === delimiter) {
        row.push(field.trim());
        field = "";
        i++;
      } else if (ch === "\r") {
        row.push(field.trim());
        field = "";
        if (row.some((f) => f !== "")) rows.push(row);
        row = [];
        i++;
        if (i < content.length && content[i] === "\n") i++;
      } else if (ch === "\n") {
        row.push(field.trim());
        field = "";
        if (row.some((f) => f !== "")) rows.push(row);
        row = [];
        i++;
      } else {
        field += ch;
        i++;
      }
    }
  }

  // Final field/row
  row.push(field.trim());
  if (row.some((f) => f !== "")) rows.push(row);

  return rows;
}

// ── Amount parsing ─────────────────────────────────────────────────────

export function parseAmount(raw: string): number {
  let s = raw.trim();
  if (!s) throw new Error("Empty amount");

  // Detect parenthetical negatives: ($123.45) or (123.45)
  const parenMatch = s.match(/^\((.+)\)$/);
  const isNegative = parenMatch != null || s.startsWith("-");
  if (parenMatch) s = parenMatch[1];

  // Strip currency symbols and whitespace
  s = s.replace(/^[-+]?\s*/, "");
  s = s.replace(/[^0-9.,\-]/g, "");

  // Handle thousands separators: 1,234.56 → 1234.56
  // If both , and . appear, the last one is the decimal separator
  const lastComma = s.lastIndexOf(",");
  const lastDot = s.lastIndexOf(".");
  if (lastComma > -1 && lastDot > -1) {
    if (lastComma > lastDot) {
      // European: 1.234,56 → 1234.56
      s = s.replace(/\./g, "").replace(",", ".");
    } else {
      // US: 1,234.56 → 1234.56
      s = s.replace(/,/g, "");
    }
  } else if (lastComma > -1) {
    // Could be thousands or decimal. If exactly 3 digits after comma, treat as thousands.
    const afterComma = s.slice(lastComma + 1);
    if (afterComma.length === 3 && s.indexOf(",") === lastComma) {
      s = s.replace(",", "");
    } else {
      s = s.replace(",", ".");
    }
  }

  const val = parseFloat(s);
  if (isNaN(val)) throw new Error(`Cannot parse amount: ${raw}`);
  return isNegative ? -Math.abs(val) : val;
}

// ── Date parsing ───────────────────────────────────────────────────────

export function parseDate(raw: string, format?: string): string {
  const s = raw.trim();
  if (!s) throw new Error("Empty date");

  if (format) {
    return parseDateWithFormat(s, format);
  }

  // Auto-detect: try common formats
  // ISO: YYYY-MM-DD
  const isoMatch = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (isoMatch) {
    return formatIso(parseInt(isoMatch[1]), parseInt(isoMatch[2]), parseInt(isoMatch[3]));
  }

  // US: MM/DD/YYYY or M/D/YYYY or MM-DD-YYYY
  const usMatch = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  if (usMatch) {
    return formatIso(parseInt(usMatch[3]), parseInt(usMatch[1]), parseInt(usMatch[2]));
  }

  // US short year: MM/DD/YY
  const usShortMatch = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2})$/);
  if (usShortMatch) {
    const year = parseInt(usShortMatch[3]) + 2000;
    return formatIso(year, parseInt(usShortMatch[1]), parseInt(usShortMatch[2]));
  }

  // Month name: "Jan 15, 2025" or "January 15, 2025"
  const monthNameMatch = s.match(
    /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\w*\s+(\d{1,2}),?\s+(\d{4})$/i,
  );
  if (monthNameMatch) {
    const month = monthNameToNum(monthNameMatch[1]);
    return formatIso(parseInt(monthNameMatch[3]), month, parseInt(monthNameMatch[2]));
  }

  throw new Error(`Cannot parse date: ${raw}`);
}

function parseDateWithFormat(s: string, format: string): string {
  const fmt = format.toUpperCase();
  const parts = s.split(/[/-]/);
  const fmtParts = fmt.split(/[/-]/);

  if (parts.length !== fmtParts.length) {
    throw new Error(`Date "${s}" does not match format "${format}"`);
  }

  let year = 0, month = 0, day = 0;
  for (let i = 0; i < fmtParts.length; i++) {
    const fp = fmtParts[i];
    const val = parseInt(parts[i]);
    if (fp.startsWith("Y")) year = val < 100 ? val + 2000 : val;
    else if (fp.startsWith("M")) month = val;
    else if (fp.startsWith("D")) day = val;
  }

  return formatIso(year, month, day);
}

const MONTH_NAMES: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

function monthNameToNum(name: string): number {
  const m = MONTH_NAMES[name.slice(0, 3).toLowerCase()];
  if (!m) throw new Error(`Unknown month: ${name}`);
  return m;
}

function formatIso(year: number, month: number, day: number): string {
  if (month < 1 || month > 12 || day < 1 || day > 31 || year < 1900) {
    throw new Error(`Invalid date components: ${year}-${month}-${day}`);
  }
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

// ── Column auto-detection ──────────────────────────────────────────────

const DATE_NAMES = ["date", "transaction date", "trans date", "posting date", "post date", "posted date", "trade date"];
const AMOUNT_NAMES = ["amount", "transaction amount", "trans amount"];
const DEBIT_NAMES = ["debit", "debit amount", "withdrawal"];
const CREDIT_NAMES = ["credit", "credit amount", "deposit"];
const MERCHANT_NAMES = ["description", "merchant", "merchant name", "payee", "name", "memo", "narrative"];
const CATEGORY_NAMES = ["category", "type"];

function findColumn(header: string[], candidates: string[]): string | undefined {
  const normalized = header.map((h) => h.toLowerCase().trim());
  for (const candidate of candidates) {
    const idx = normalized.indexOf(candidate);
    if (idx !== -1) return header[idx];
  }
  return undefined;
}

export function detectColumnMapping(header: string[]): CsvColumnMapping | null {
  const date = findColumn(header, DATE_NAMES);
  const amount = findColumn(header, AMOUNT_NAMES);
  const merchant = findColumn(header, MERCHANT_NAMES);
  const debitAmount = findColumn(header, DEBIT_NAMES);
  const creditAmount = findColumn(header, CREDIT_NAMES);
  const category = findColumn(header, CATEGORY_NAMES);

  if (!date || !merchant) return null;
  if (!amount && !(debitAmount && creditAmount)) return null;

  const mapping: CsvColumnMapping = { date, merchant };
  if (amount) mapping.amount = amount;
  if (debitAmount) mapping.debitAmount = debitAmount;
  if (creditAmount) mapping.creditAmount = creditAmount;
  if (category) mapping.category = category;

  return mapping;
}

// ── Column index resolution ────────────────────────────────────────────

function resolveIndex(header: string[], col: string | number, label: string): number {
  if (typeof col === "number") {
    if (col < 0 || col >= header.length) {
      throw new Error(`Column index ${col} (${label}) out of range. Header has ${header.length} columns.`);
    }
    return col;
  }
  const normalized = header.map((h) => h.toLowerCase().trim());
  const idx = normalized.indexOf(col.toLowerCase().trim());
  if (idx === -1) {
    throw new Error(
      `Column "${col}" (${label}) not found. Available columns: ${header.join(", ")}`,
    );
  }
  return idx;
}

// ── Main entry point ───────────────────────────────────────────────────

export function parseCsvFile(
  filePath: string,
  mapping: CsvColumnMapping,
  options: CsvParseOptions = {},
): Transaction[] {
  const content = readFileSync(filePath, "utf-8");
  return parseCsvContent(content, mapping, options);
}

export function parseCsvContent(
  content: string,
  mapping: CsvColumnMapping,
  options: CsvParseOptions = {},
): Transaction[] {
  const {
    delimiter: delimOpt,
    hasHeader = true,
    skipRows = 0,
    amountSign = "negative-debit",
    sourcePlugin = "csv_import",
    dateFormat,
  } = options;

  // Skip preamble rows
  let lines = content;
  if (skipRows > 0) {
    const allLines = content.split(/\r?\n/);
    lines = allLines.slice(skipRows).join("\n");
  }

  const delimiter = delimOpt ?? detectDelimiter(lines.split(/\r?\n/)[0] ?? "");
  const rows = parseCsvRows(lines, delimiter);

  if (rows.length === 0) return [];

  let header: string[];
  let dataRows: string[][];

  if (hasHeader) {
    header = rows[0];
    dataRows = rows.slice(1);
  } else {
    header = rows[0].map((_, i) => String(i));
    dataRows = rows;
  }

  // Resolve column indices
  const dateIdx = resolveIndex(header, mapping.date, "date");
  const merchantIdx = resolveIndex(header, mapping.merchant, "merchant");

  let amountIdx: number | undefined;
  let debitIdx: number | undefined;
  let creditIdx: number | undefined;

  if (amountSign === "separate-columns" || (!mapping.amount && mapping.debitAmount && mapping.creditAmount)) {
    if (!mapping.debitAmount || !mapping.creditAmount) {
      throw new Error("separate-columns mode requires both debitAmount and creditAmount mappings");
    }
    debitIdx = resolveIndex(header, mapping.debitAmount, "debitAmount");
    creditIdx = resolveIndex(header, mapping.creditAmount, "creditAmount");
  } else if (mapping.amount != null) {
    amountIdx = resolveIndex(header, mapping.amount, "amount");
  } else {
    throw new Error("Column mapping must include 'amount' or both 'debitAmount' and 'creditAmount'");
  }

  const categoryIdx = mapping.category != null
    ? resolveIndex(header, mapping.category, "category")
    : undefined;
  const notesIdx = mapping.notes != null
    ? resolveIndex(header, mapping.notes, "notes")
    : undefined;

  // Parse rows into transactions
  const transactions: Transaction[] = [];

  for (const row of dataRows) {
    const rawDate = row[dateIdx] ?? "";
    const rawMerchant = (row[merchantIdx] ?? "").trim();

    if (!rawDate || !rawMerchant) continue;

    let date: string;
    try {
      date = parseDate(rawDate, dateFormat);
    } catch {
      continue; // Skip unparseable dates
    }

    let amount: number;
    let txType: TransactionType;

    if (amountIdx != null) {
      const rawAmt = row[amountIdx] ?? "";
      if (!rawAmt) continue;
      try {
        amount = parseAmount(rawAmt);
      } catch {
        continue;
      }

      if (amountSign === "negative-credit") {
        txType = amount < 0 ? TransactionType.CREDIT : TransactionType.DEBIT;
      } else {
        txType = amount < 0 ? TransactionType.DEBIT : TransactionType.CREDIT;
      }
      amount = Math.abs(amount);
    } else {
      // Separate columns
      const rawDebit = (row[debitIdx!] ?? "").trim();
      const rawCredit = (row[creditIdx!] ?? "").trim();

      if (!rawDebit && !rawCredit) continue;

      if (rawDebit) {
        try { amount = Math.abs(parseAmount(rawDebit)); } catch { continue; }
        txType = TransactionType.DEBIT;
      } else {
        try { amount = Math.abs(parseAmount(rawCredit)); } catch { continue; }
        txType = TransactionType.CREDIT;
      }
    }

    if (amount === 0) continue;

    const tx: Transaction = {
      date,
      amount,
      txType,
      merchant: rawMerchant,
      sourcePlugin,
    };

    if (categoryIdx != null) {
      const cat = (row[categoryIdx] ?? "").trim();
      if (cat) tx.category = cat;
    }
    if (notesIdx != null) {
      const note = (row[notesIdx] ?? "").trim();
      if (note) tx.notes = note;
    }

    transactions.push(tx);
  }

  return transactions;
}
