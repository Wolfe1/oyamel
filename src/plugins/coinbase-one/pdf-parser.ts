/**
 * Coinbase One credit card PDF statement parser.
 *
 * Parses monthly PDF statements from the Coinbase One credit card
 * (issued by Cardless/First Electronic Bank on the Amex network).
 *
 * Statement format:
 * - "Payments and credits" section: Date | Description | Amount (credits)
 * - "Transactions" section: Date | Description | Amount (debits)
 * - Dates: "Sep 25, 2025" format
 * - Amounts: "$49.99" (always positive, sign determined by section)
 * - Descriptions: raw merchant descriptors with addresses and terminal codes
 */

import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { resolve } from "path";
import type { Command } from "commander";
import type { SourcePlugin, PluginMetadata, CliHelpers } from "../base.js";
import { type Transaction, TransactionType } from "../../schema.js";

// Pattern for date at start of a transaction line: "Sep 25, 2025"
const DATE_PATTERN =
  /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2},\s+\d{4}/;

// Pattern to extract trailing dollar amount: "$49.99" or "$1,234.56"
const AMOUNT_PATTERN = /\$[\d,]+\.\d{2}$/;

function parseStatementDate(raw: string): string {
  const d = new Date(raw.trim());
  if (isNaN(d.getTime())) {
    throw new Error(`Cannot parse date: ${raw}`);
  }
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function parseAmount(raw: string): number {
  const cleaned = raw.replace(/[$,]/g, "");
  const val = parseFloat(cleaned);
  if (isNaN(val)) throw new Error(`Cannot parse amount: ${raw}`);
  return val;
}

function cleanMerchantName(rawDescription: string): string {
  let desc = rawDescription.trim();

  // Remove page footer text that sometimes gets merged with descriptions
  desc = desc.replace(/\s*Coinbase One Card is offered through.*$/i, "");
  desc = desc.replace(/\s*Page \d+ of \d+.*$/i, "");
  // Remove cardholder name that sometimes gets merged from page footer.
  // Matches a trailing capitalized first name followed by any last name text.
  desc = desc.replace(/\s+[A-Z][a-z]+\s+[A-Z][a-z]+.*$/, "");
  desc = desc.replace(/\s*Coinbase One Card\s*$/i, "");

  // Clean up common POS/payment prefixes
  desc = desc.replace(/^TST\*\s*/, "");
  desc = desc.replace(/^WWP\*/, "");
  desc = desc.replace(/^SQ\s*\*\s*/, "");
  desc = desc.replace(/^PP\*/, "");
  desc = desc.replace(/^CKE\*/, "");

  // Remove trailing terminal/MCC codes (3-digit groups at end)
  desc = desc.replace(/(\s+\d{3})+\s*$/, "");

  // Remove 5-digit zip codes
  desc = desc.replace(/\s+\d{5}\b/g, "");

  // Clean up BESTBUYCOM-style merged names
  desc = desc.replace(/COM\d+.*$/i, ".com");

  // Strip address: street number + words + street type suffix
  const streetTypes =
    /(?:ST|STREET|AVE|AVENUE|BLVD|BOULEVARD|RD|ROAD|DR|DRIVE|LN|LANE|WAY|CT|COURT|PL|PLACE|TRAIL|TRL|CIR|PKWY|PARKWAY|HWY|HIGHWAY)\b/i;
  const addressPattern = new RegExp(
    `\\s+\\d+\\s+(?:[NSEW]\\s+)?[\\w\\s.'-]+?${streetTypes.source}`,
    "i",
  );
  const addressMatch = addressPattern.exec(desc);
  if (addressMatch?.index !== undefined) {
    desc = desc.slice(0, addressMatch.index);
  }

  // Catch remaining city/state fragments
  desc = desc.replace(
    /\s+(?:COLONEL|WEST|EAST|NORTH|SOUTH)\s+[\w\s]+$/i,
    "",
  );

  // Remove trailing numeric IDs
  desc = desc.replace(/\s+\d{4,}(\s+\d+)*$/, "");

  // Remove trailing corporate suffixes
  desc = desc.replace(/\s+(INC|LLC|CO|CORP|LTD)\.?\s*$/i, "");

  // Title case and clean whitespace
  desc = desc.replace(/\s+/g, " ").trim();
  if (desc === desc.toUpperCase() || desc === desc.toLowerCase()) {
    desc = desc
      .split(" ")
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
      .join(" ");
  }

  return desc || rawDescription.trim();
}

interface RawRecord {
  dateStr: string;
  description: string;
  amountStr: string;
  section: string;
  txType?: string;
}

// Lines to skip — these appear on every page
const SKIP_PATTERNS = [
  /^Coinbase One Card is offered through/i,
  /^Page \d+ of \d+/i,
  /^See Important Disclosures/,
  /Coinbase One Card\s*$/,
  /^\w+@\w+\.\w+/,
];

function extractTextLines(pdfText: string): string[] {
  const lines: string[] = [];
  for (const line of pdfText.split("\n")) {
    const stripped = line.trim();
    if (!stripped) continue;
    if (SKIP_PATTERNS.some((p) => p.test(stripped))) continue;
    if (/^[A-Z][a-z]+ [A-Z][a-z]+ [A-Z][a-z]+$/.test(stripped)) continue;
    if (
      /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d+\s*[–-]/.test(
        stripped,
      )
    )
      continue;
    lines.push(stripped);
  }
  return lines;
}

/** Extract text from a PDF buffer using pdfjs-dist, reconstructing lines from Y coordinates. */
async function extractPdfText(buffer: Buffer): Promise<string> {
  // Dynamic import for pdfjs-dist (ESM/CJS compat)
  const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const data = new Uint8Array(buffer);
  const doc = await pdfjsLib.getDocument({ data }).promise;

  const allLines: string[] = [];

  for (let pageNum = 1; pageNum <= doc.numPages; pageNum++) {
    const page = await doc.getPage(pageNum);
    const content = await page.getTextContent();

    let lastY: number | null = null;
    let line = "";

    for (const item of content.items) {
      const textItem = item as any;
      if (!textItem.str) continue;
      const y = Math.round(textItem.transform[5]);
      if (lastY !== null && Math.abs(y - lastY) > 3) {
        if (line.trim()) allLines.push(line.trim());
        line = "";
      }
      line += textItem.str;
      lastY = y;
    }
    if (line.trim()) allLines.push(line.trim());
  }

  return allLines.join("\n");
}

function parseTransactionsFromLines(
  lines: string[],
): { transactions: RawRecord[]; payments: RawRecord[] } {
  const transactions: RawRecord[] = [];
  const payments: RawRecord[] = [];

  let currentSection: string | null = null;
  let currentRecord: RawRecord | null = null;

  function flushRecord() {
    if (!currentRecord) return;
    const target =
      currentRecord.section === "payments" ? payments : transactions;
    target.push(currentRecord);
    currentRecord = null;
  }

  for (const line of lines) {
    // Detect section headers
    if (line.startsWith("Transactions")) {
      flushRecord();
      currentSection = "transactions";
      continue;
    } else if (line.startsWith("Payments and credits")) {
      flushRecord();
      currentSection = "payments";
      continue;
    } else if (
      line.startsWith("Fees") ||
      line.startsWith("Interest charge") ||
      line.startsWith("Important disclosures") ||
      line.startsWith("Late payment warning") ||
      line.startsWith("Minimum payment warning") ||
      line.startsWith("Account summary") ||
      line.startsWith("If you make no additional") ||
      line.startsWith("Only the minimum payment") ||
      line.startsWith("For information about credit counseling")
    ) {
      flushRecord();
      currentSection = null;
      continue;
    }

    if (currentSection === null) continue;

    // Skip header rows and total rows
    if (line === "Date Description Amount") continue;
    if (line.startsWith("Total ") || line.startsWith("- ")) {
      flushRecord();
      continue;
    }

    // Check if this line starts a new transaction
    const dateMatch = DATE_PATTERN.exec(line);
    if (dateMatch) {
      flushRecord();

      const amountMatch = AMOUNT_PATTERN.exec(line);
      let amountStr = "";
      let description: string;

      if (amountMatch) {
        amountStr = amountMatch[0];
        const afterDate = line.slice(dateMatch[0].length).trim();
        description = afterDate
          .slice(0, afterDate.lastIndexOf(amountStr))
          .trim();
      } else {
        description = line.slice(dateMatch[0].length).trim();
      }

      currentRecord = {
        dateStr: dateMatch[0],
        description,
        amountStr,
        section: currentSection,
      };
    } else if (currentRecord) {
      // Continuation line
      const amountMatch = AMOUNT_PATTERN.exec(line);
      if (amountMatch && !currentRecord.amountStr) {
        currentRecord.amountStr = amountMatch[0];
        const extraDesc = line.slice(0, amountMatch.index).trim();
        if (extraDesc) currentRecord.description += " " + extraDesc;
      } else if (amountMatch) {
        const extraDesc = line.slice(0, amountMatch.index).trim();
        if (extraDesc) currentRecord.description += " " + extraDesc;
        currentRecord.amountStr = amountMatch[0];
      } else {
        currentRecord.description += " " + line;
      }
    }
  }

  flushRecord();
  return { transactions, payments };
}

function resolvePdfPaths(inputPath: string): string[] {
  const resolved = resolve(inputPath);
  if (!existsSync(resolved)) {
    throw new Error(`Path not found: ${resolved}`);
  }
  if (statSync(resolved).isDirectory()) {
    const pdfs = readdirSync(resolved)
      .filter((f) => f.toLowerCase().endsWith(".pdf"))
      .sort()
      .map((f) => resolve(resolved, f));
    if (!pdfs.length) {
      throw new Error(`No PDF files found in ${resolved}`);
    }
    return pdfs;
  }
  return [resolved];
}

export class CoinbaseOnePdfPlugin implements SourcePlugin {
  metadata(): PluginMetadata {
    return {
      id: "coinbase-one",
      name: "Coinbase One Credit Card",
      description: "Sync Coinbase One credit card PDF statements to Monarch",
    };
  }

  registerCommands(parent: Command, helpers: CliHelpers): void {
    parent
      .command("preview")
      .description("Preview parsed transactions without syncing")
      .argument("<path>", "Path to a PDF statement or directory of PDFs")
      .option("--limit <n>", "Max transactions to preview per file (0 = all)", "0")
      .action(async (inputPath: string, opts: { limit: string }) => {
        const pdfPaths = resolvePdfPaths(inputPath);

        for (const pdfPath of pdfPaths) {
          if (pdfPaths.length > 1) {
            console.log(`\n── ${pdfPath} ──`);
          }

          const transactions = await this.sync({ file_path: pdfPath });
          if (!transactions.length) {
            console.log("No transactions found.");
            continue;
          }

          const limit = parseInt(opts.limit, 10);
          const shown = limit ? transactions.slice(0, limit) : transactions;
          console.log(
            `Found ${transactions.length} transactions (showing ${shown.length}):\n`,
          );
          helpers.printTransactions(shown);
        }
      });

    parent
      .command("demo")
      .description("Walk through a sample sync workflow with fake data (no PDF or account needed)")
      .action(async () => {
        const sampleTransactions: Transaction[] = [
          { date: "2025-09-03", amount: 4.50,   txType: TransactionType.DEBIT,  merchant: "Starbucks", notes: "STARBUCKS STORE 12345 SEATTLE WA", sourcePlugin: "coinbase_one" },
          { date: "2025-09-05", amount: 52.43,  txType: TransactionType.DEBIT,  merchant: "Whole Foods Market", notes: "WHOLE FOODS MKT 10234 SAN FRANCISCO CA", sourcePlugin: "coinbase_one" },
          { date: "2025-09-07", amount: 127.89, txType: TransactionType.DEBIT,  merchant: "Best Buy", notes: "BESTBUYCOM806432178", sourcePlugin: "coinbase_one" },
          { date: "2025-09-10", amount: 15.99,  txType: TransactionType.DEBIT,  merchant: "Netflix", notes: "NETFLIX.COM", sourcePlugin: "coinbase_one" },
          { date: "2025-09-12", amount: 38.72,  txType: TransactionType.DEBIT,  merchant: "Shell Oil", notes: "SHELL OIL 57442 AUSTIN TX", sourcePlugin: "coinbase_one" },
          { date: "2025-09-15", amount: 250.00, txType: TransactionType.CREDIT, merchant: "Payment - Thank You", sourcePlugin: "coinbase_one" },
          { date: "2025-09-18", amount: 9.99,   txType: TransactionType.DEBIT,  merchant: "Spotify", notes: "SPOTIFY USA", sourcePlugin: "coinbase_one" },
          { date: "2025-09-22", amount: 63.15,  txType: TransactionType.DEBIT,  merchant: "Target", notes: "TARGET T-2174 DALLAS TX", sourcePlugin: "coinbase_one" },
        ];

        const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

        console.log("╔══════════════════════════════════════════════════════════╗");
        console.log("║          Oyamel — Coinbase One Sync Demo                ║");
        console.log("║   This is a simulated walkthrough with sample data.     ║");
        console.log("╚══════════════════════════════════════════════════════════╝");

        // Step 1: Parse
        console.log("\n── Step 1: Parse PDF statement ──\n");
        console.log("$ oyamel coinbase-one sync ~/statements/september-2025.pdf\n");
        await sleep(400);
        console.log("Parsing PDF... found 8 transactions.\n");
        helpers.printTransactions(sampleTransactions);

        // Step 2: Auth
        console.log("\n── Step 2: Authenticate with Monarch ──\n");
        await sleep(300);
        console.log("--- Monarch Authentication ---");
        console.log("Monarch email: user@example.com");
        console.log("Monarch password: ********");
        await sleep(200);
        console.log("Logging in to Monarch...");
        await sleep(300);
        console.log("Logged in successfully.");

        // Step 3: Account
        console.log("\n── Step 3: Select target account ──\n");
        await sleep(200);
        console.log("Available Monarch accounts:");
        console.log("  1. Checking (depository) — $4,231.50");
        console.log("  2. Savings (depository) — $12,500.00");
        console.log("  3. Coinbase One Credit Card (credit) — $-312.53");
        console.log("  4. Brokerage (investment) — $45,800.00");
        console.log("\nSelect account number: 3");
        await sleep(200);
        console.log("Saved 'Coinbase One Credit Card' as default for coinbase-one.");

        // Step 4: Dedup + Push
        console.log("\n── Step 4: Deduplicate & push ──\n");
        console.log("Target account: Coinbase One Credit Card");
        console.log("Push 8 transactions to 'Coinbase One Credit Card'? [Y/n] Y\n");
        await sleep(200);

        const cats = ["Food & Drink", "Groceries", "Shopping", "Entertainment", "Auto & Transport", "Payment", "Entertainment", "Shopping"];
        let created = 0;
        let skipped = 0;
        for (let i = 0; i < sampleTransactions.length; i++) {
          await sleep(250);
          const tx = sampleTransactions[i];
          const sign = tx.txType === "debit" ? "-" : "+";
          const amt = `${sign}$${tx.amount.toFixed(2)}`;

          // Simulate 1 duplicate
          if (i === 3) {
            skipped++;
            console.log(`  SKIP  ${tx.date}  ${amt.padStart(12)}  ${tx.merchant}`);
          } else {
            created++;
            console.log(`  ADD   ${tx.date}  ${amt.padStart(12)}  ${tx.merchant}  [${cats[i]}]`);
          }
        }

        console.log(`\nDone. Created ${created} transactions, skipped ${skipped} duplicates, ${created} auto-categorized.`);

        console.log("\n────────────────────────────────────────────────────────────");
        console.log("That's it! To run a real sync, use:");
        console.log("  npx oyamel coinbase-one sync <path-to-pdf>");
        console.log("────────────────────────────────────────────────────────────\n");
      });

    parent
      .command("sync")
      .description("Sync statement(s) to a Monarch account")
      .argument("<path>", "Path to a PDF statement or directory of PDFs")
      .option("--account <name>", "Monarch account display name")
      .option("--dry-run", "Parse and dedupe but don't push")
      .option("--debug", "Show detailed per-transaction logging")
      .action(
        async (
          inputPath: string,
          opts: { account?: string; dryRun?: boolean; debug?: boolean },
        ) => {
          const pdfPaths = resolvePdfPaths(inputPath);

          let transactions: Transaction[] = [];
          for (const pdfPath of pdfPaths) {
            const txs = await this.sync({ file_path: pdfPath });
            if (pdfPaths.length > 1 && txs.length > 0) {
              console.log(`  ${pdfPath}: ${txs.length} transactions`);
            }
            transactions.push(...txs);
          }

          if (!transactions.length) {
            console.log("No transactions found in statement(s).");
            return;
          }

          console.log(
            `\nParsed ${transactions.length} transactions from ${pdfPaths.length} file(s).\n`,
          );
          helpers.printTransactions(transactions);

          const client = await helpers.authenticateMonarch();
          const { accountId, accountName } = await helpers.resolveAccount(
            client,
            this.metadata().id,
            opts.account,
          );

          await helpers.pushAndReport(
            client,
            transactions,
            accountId,
            accountName,
            opts,
          );
        },
      );
  }

  async acquire(
    config: Record<string, unknown>,
  ): Promise<Record<string, unknown>[]> {
    const filePath = config.file_path as string;
    if (!filePath) throw new Error("file_path is required");

    const resolved = resolve(filePath);
    const buffer = readFileSync(resolved);
    const pdfText = await extractPdfText(buffer as Buffer);

    const lines = extractTextLines(pdfText);
    const { transactions, payments } = parseTransactionsFromLines(lines);

    const records: Record<string, unknown>[] = [];
    for (const rec of transactions) {
      records.push({ ...rec, txType: "debit" });
    }
    for (const rec of payments) {
      records.push({ ...rec, txType: "credit" });
    }

    return records;
  }

  transform(rawRecords: Record<string, unknown>[]): Transaction[] {
    const transactions: Transaction[] = [];

    for (let i = 0; i < rawRecords.length; i++) {
      const rec = rawRecords[i] as unknown as RawRecord;
      if (!rec.amountStr || !rec.dateStr) continue;

      try {
        const txDate = parseStatementDate(rec.dateStr);
        const amount = parseAmount(rec.amountStr);
        const txType =
          rec.txType === "credit"
            ? TransactionType.CREDIT
            : TransactionType.DEBIT;

        const rawDesc = rec.description ?? "Unknown";
        const merchant = cleanMerchantName(rawDesc);

        if (amount === 0) continue;

        transactions.push({
          date: txDate,
          amount,
          txType,
          merchant,
          notes: rawDesc !== merchant ? rawDesc : undefined,
          sourcePlugin: "coinbase_one",
        });
      } catch (e) {
        throw new Error(
          `Error parsing record ${i + 1}: ${e instanceof Error ? e.message : e}`,
        );
      }
    }

    return transactions;
  }

  async sync(config: Record<string, unknown>): Promise<Transaction[]> {
    const raw = await this.acquire(config);
    return this.transform(raw);
  }
}

// Export helpers for testing
export {
  parseStatementDate,
  parseAmount,
  cleanMerchantName,
  extractTextLines,
  parseTransactionsFromLines,
  resolvePdfPaths,
};
