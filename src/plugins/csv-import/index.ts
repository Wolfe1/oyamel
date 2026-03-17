/** Generic CSV import plugin — imports transactions from any CSV file. */

import { resolve } from "path";
import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import type { Command } from "commander";
import type { Transaction } from "../../schema.js";
import type { SourcePlugin, PluginMetadata, CliHelpers } from "../base.js";
import {
  parseCsvFile,
  detectColumnMapping,
  parseCsvRows,
  detectDelimiter,
  type CsvColumnMapping,
  type CsvParseOptions,
} from "../../ingestion/csv.js";

// ── Helpers ────────────────────────────────────────────────────────────

export function resolveCsvPaths(inputPath: string): string[] {
  const resolved = resolve(inputPath);
  if (!existsSync(resolved)) {
    throw new Error(`Path not found: ${resolved}`);
  }
  if (statSync(resolved).isDirectory()) {
    const csvs = readdirSync(resolved)
      .filter((f) => f.toLowerCase().endsWith(".csv"))
      .sort()
      .map((f) => resolve(resolved, f));
    if (!csvs.length) {
      throw new Error(`No CSV files found in ${resolved}`);
    }
    return csvs;
  }
  return [resolved];
}

interface MappingFile {
  date?: string;
  amount?: string;
  merchant?: string;
  debitAmount?: string;
  creditAmount?: string;
  category?: string;
  notes?: string;
  dateFormat?: string;
  delimiter?: string;
  skipRows?: number;
  amountSign?: "negative-debit" | "negative-credit" | "separate-columns";
}

interface CliOpts {
  dateCol?: string;
  amountCol?: string;
  merchantCol?: string;
  debitCol?: string;
  creditCol?: string;
  dateFormat?: string;
  delimiter?: string;
  skipRows?: string;
  amountSign?: string;
  mappingFile?: string;
  limit?: string;
  account?: string;
  dryRun?: boolean;
  debug?: boolean;
}

function loadMappingFile(path: string): MappingFile {
  const resolved = resolve(path);
  if (!existsSync(resolved)) throw new Error(`Mapping file not found: ${resolved}`);
  return JSON.parse(readFileSync(resolved, "utf-8"));
}

function buildMappingAndOptions(
  opts: CliOpts,
  header?: string[],
): { mapping: CsvColumnMapping; options: CsvParseOptions } {
  let base: MappingFile = {};

  // Load mapping file as base
  if (opts.mappingFile) {
    base = loadMappingFile(opts.mappingFile);
  }

  // CLI options override mapping file
  const dateCol = opts.dateCol ?? base.date;
  const amountCol = opts.amountCol ?? base.amount;
  const merchantCol = opts.merchantCol ?? base.merchant;
  const debitCol = opts.debitCol ?? base.debitAmount;
  const creditCol = opts.creditCol ?? base.creditAmount;

  let mapping: CsvColumnMapping | null = null;

  if (dateCol && merchantCol && (amountCol || (debitCol && creditCol))) {
    mapping = { date: dateCol, merchant: merchantCol };
    if (amountCol) mapping.amount = amountCol;
    if (debitCol) mapping.debitAmount = debitCol;
    if (creditCol) mapping.creditAmount = creditCol;
    if (base.category) mapping.category = base.category;
    if (base.notes) mapping.notes = base.notes;
  }

  // Fall back to auto-detection
  if (!mapping && header) {
    mapping = detectColumnMapping(header);
    if (mapping) {
      console.log(`Auto-detected columns: date="${mapping.date}", merchant="${mapping.merchant}", amount="${mapping.amount ?? `debit=${mapping.debitAmount}, credit=${mapping.creditAmount}`}"`);
    }
  }

  if (!mapping) {
    const colList = header ? `Available columns: ${header.join(", ")}` : "";
    throw new Error(
      `Could not determine column mapping. Specify --date-col, --amount-col, and --merchant-col.\n${colList}`,
    );
  }

  const amountSign = (opts.amountSign ?? base.amountSign ?? "negative-debit") as CsvParseOptions["amountSign"];

  const options: CsvParseOptions = {
    delimiter: opts.delimiter ?? base.delimiter,
    dateFormat: opts.dateFormat ?? base.dateFormat,
    skipRows: parseInt(opts.skipRows ?? String(base.skipRows ?? 0), 10),
    amountSign,
    sourcePlugin: "csv_import",
  };

  return { mapping, options };
}

function readHeader(filePath: string, skipRows: number, delimiter?: string): string[] {
  const content = readFileSync(filePath, "utf-8");
  const lines = content.split(/\r?\n/);
  const headerLine = lines[skipRows] ?? "";
  const delim = delimiter ?? detectDelimiter(headerLine);
  const rows = parseCsvRows(headerLine, delim);
  return rows[0] ?? [];
}

// ── Plugin ─────────────────────────────────────────────────────────────

export class CsvImportPlugin implements SourcePlugin {
  metadata(): PluginMetadata {
    return {
      id: "csv-import",
      name: "Generic CSV Import",
      description: "Import transactions from any CSV file into Monarch",
    };
  }

  registerCommands(parent: Command, helpers: CliHelpers): void {
    const addCsvOptions = (cmd: Command): Command =>
      cmd
        .option("--date-col <name>", "Column name for transaction date")
        .option("--amount-col <name>", "Column name for amount")
        .option("--merchant-col <name>", "Column name for merchant/description")
        .option("--debit-col <name>", "Column name for debit amount")
        .option("--credit-col <name>", "Column name for credit amount")
        .option("--date-format <format>", "Date format (e.g., MM/DD/YYYY, YYYY-MM-DD)")
        .option("--delimiter <char>", "Field delimiter (auto-detected if omitted)")
        .option("--skip-rows <n>", "Rows to skip before header", "0")
        .option("--amount-sign <convention>", "negative-debit (default) or negative-credit")
        .option("--mapping-file <path>", "JSON file with column mapping config");

    addCsvOptions(
      parent
        .command("preview")
        .description("Preview parsed transactions without syncing")
        .argument("<path>", "Path to a CSV file or directory of CSVs")
        .option("--limit <n>", "Max transactions to preview (0 = all)", "0"),
    ).action(async (inputPath: string, opts: CliOpts) => {
      const csvPaths = resolveCsvPaths(inputPath);

      for (const csvPath of csvPaths) {
        if (csvPaths.length > 1) console.log(`\n── ${csvPath} ──`);

        const skipRows = parseInt(opts.skipRows ?? "0", 10);
        const header = readHeader(csvPath, skipRows, opts.delimiter);
        const { mapping, options } = buildMappingAndOptions(opts, header);

        const transactions = parseCsvFile(csvPath, mapping, options);
        if (!transactions.length) {
          console.log("No transactions found.");
          continue;
        }

        const limit = parseInt(opts.limit ?? "0", 10);
        const shown = limit ? transactions.slice(0, limit) : transactions;
        console.log(`Found ${transactions.length} transactions (showing ${shown.length}):\n`);
        helpers.printTransactions(shown);
      }
    });

    addCsvOptions(
      parent
        .command("sync")
        .description("Sync CSV file(s) to a Monarch account")
        .argument("<path>", "Path to a CSV file or directory of CSVs")
        .option("--account <name>", "Monarch account display name")
        .option("--dry-run", "Parse and dedupe but don't push")
        .option("--debug", "Show detailed per-transaction logging"),
    ).action(
      async (inputPath: string, opts: CliOpts) => {
        const csvPaths = resolveCsvPaths(inputPath);

        let transactions: Transaction[] = [];
        for (const csvPath of csvPaths) {
          const skipRows = parseInt(opts.skipRows ?? "0", 10);
          const header = readHeader(csvPath, skipRows, opts.delimiter);
          const { mapping, options } = buildMappingAndOptions(opts, header);

          const txs = parseCsvFile(csvPath, mapping, options);
          if (csvPaths.length > 1 && txs.length > 0) {
            console.log(`  ${csvPath}: ${txs.length} transactions`);
          }
          transactions.push(...txs);
        }

        if (!transactions.length) {
          console.log("No transactions found in CSV file(s).");
          return;
        }

        console.log(
          `\nParsed ${transactions.length} transactions from ${csvPaths.length} file(s).\n`,
        );
        helpers.printTransactions(transactions);

        const client = await helpers.authenticateMonarch();
        const { accountId, accountName } = await helpers.resolveAccount(
          client,
          this.metadata().id,
          opts.account,
        );

        await helpers.pushAndReport(client, transactions, accountId, accountName, opts);
      },
    );
  }

  async acquire(config: Record<string, unknown>): Promise<Record<string, unknown>[]> {
    const filePath = config.file_path as string;
    if (!filePath) throw new Error("file_path is required");

    const mapping = config.mapping as CsvColumnMapping | undefined;
    const options = config.options as CsvParseOptions | undefined;

    if (!mapping) {
      // Auto-detect from header
      const header = readHeader(filePath, options?.skipRows ?? 0, options?.delimiter);
      const detected = detectColumnMapping(header);
      if (!detected) throw new Error("Could not auto-detect CSV column mapping");
      const transactions = parseCsvFile(filePath, detected, options);
      return transactions.map((tx) => ({ ...tx }) as unknown as Record<string, unknown>);
    }

    const transactions = parseCsvFile(filePath, mapping, options);
    return transactions.map((tx) => ({ ...tx }) as unknown as Record<string, unknown>);
  }

  transform(rawRecords: Record<string, unknown>[]): Transaction[] {
    // Records from acquire() are already Transaction objects
    return rawRecords as unknown as Transaction[];
  }

  async sync(config: Record<string, unknown>): Promise<Transaction[]> {
    const records = await this.acquire(config);
    return this.transform(records);
  }
}
