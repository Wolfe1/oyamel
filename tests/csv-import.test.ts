import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { CsvImportPlugin, resolveCsvPaths, loadMappingFile } from "../src/plugins/csv-import/index.js";

const TEST_DIR = join(tmpdir(), "oyamel-csv-import-test-" + Date.now());

beforeAll(() => {
  mkdirSync(TEST_DIR, { recursive: true });
});

afterAll(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

// ── resolveCsvPaths ────────────────────────────────────────────────────

describe("resolveCsvPaths", () => {
  it("throws on non-existent path", () => {
    expect(() => resolveCsvPaths("/no/such/path.csv")).toThrow("Path not found");
  });

  it("returns single file for a file path", () => {
    const f = join(TEST_DIR, "single.csv");
    writeFileSync(f, "Date,Amount,Description\n");
    const paths = resolveCsvPaths(f);
    expect(paths).toHaveLength(1);
    expect(paths[0]).toContain("single.csv");
  });

  it("returns sorted CSVs from a directory", () => {
    const dir = join(TEST_DIR, "multi");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "b.csv"), "x");
    writeFileSync(join(dir, "a.csv"), "x");
    writeFileSync(join(dir, "c.txt"), "x"); // not a csv
    const paths = resolveCsvPaths(dir);
    expect(paths).toHaveLength(2);
    expect(paths[0]).toContain("a.csv");
    expect(paths[1]).toContain("b.csv");
  });

  it("throws if directory has no CSVs", () => {
    const dir = join(TEST_DIR, "empty-dir");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "readme.txt"), "x");
    expect(() => resolveCsvPaths(dir)).toThrow("No CSV files found");
  });

  it("handles uppercase .CSV extension", () => {
    const dir = join(TEST_DIR, "upper");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "data.CSV"), "x");
    const paths = resolveCsvPaths(dir);
    expect(paths).toHaveLength(1);
  });
});

// ── loadMappingFile validation ────────────────────────────────────────

describe("loadMappingFile", () => {
  it("loads a valid mapping file", () => {
    const f = join(TEST_DIR, "valid-mapping.json");
    writeFileSync(f, JSON.stringify({ date: "Date", amount: "Amount", merchant: "Desc" }));
    const result = loadMappingFile(f);
    expect(result.date).toBe("Date");
    expect(result.amount).toBe("Amount");
    expect(result.merchant).toBe("Desc");
  });

  it("throws on non-existent file", () => {
    expect(() => loadMappingFile("/no/such/file.json")).toThrow("Mapping file not found");
  });

  it("throws on invalid JSON", () => {
    const f = join(TEST_DIR, "bad-json.json");
    writeFileSync(f, "not json{{{");
    expect(() => loadMappingFile(f)).toThrow("not valid JSON");
  });

  it("throws if file contains an array", () => {
    const f = join(TEST_DIR, "array.json");
    writeFileSync(f, "[]");
    expect(() => loadMappingFile(f)).toThrow("must be a JSON object");
  });

  it("throws if file contains a scalar", () => {
    const f = join(TEST_DIR, "scalar.json");
    writeFileSync(f, '"hello"');
    expect(() => loadMappingFile(f)).toThrow("must be a JSON object");
  });

  it("throws if string field has wrong type", () => {
    const f = join(TEST_DIR, "bad-field.json");
    writeFileSync(f, JSON.stringify({ date: 123 }));
    expect(() => loadMappingFile(f)).toThrow('"date" must be a string');
  });

  it("throws if skipRows is not a number", () => {
    const f = join(TEST_DIR, "bad-skip.json");
    writeFileSync(f, JSON.stringify({ skipRows: "five" }));
    expect(() => loadMappingFile(f)).toThrow('"skipRows" must be a number');
  });

  it("throws if amountSign is invalid", () => {
    const f = join(TEST_DIR, "bad-sign.json");
    writeFileSync(f, JSON.stringify({ amountSign: "backwards" }));
    expect(() => loadMappingFile(f)).toThrow('"amountSign" must be');
  });

  it("accepts valid amountSign values", () => {
    for (const sign of ["negative-debit", "negative-credit", "separate-columns"]) {
      const f = join(TEST_DIR, `sign-${sign}.json`);
      writeFileSync(f, JSON.stringify({ amountSign: sign }));
      expect(loadMappingFile(f).amountSign).toBe(sign);
    }
  });
});

// ── CsvImportPlugin.metadata ──────────────────────────────────────────

describe("CsvImportPlugin.metadata", () => {
  const plugin = new CsvImportPlugin();

  it("returns csv-import id", () => {
    expect(plugin.metadata().id).toBe("csv-import");
  });

  it("has a name and description", () => {
    expect(plugin.metadata().name).toBeTruthy();
    expect(plugin.metadata().description).toBeTruthy();
  });
});

// ── CsvImportPlugin.sync ──────────────────────────────────────────────

describe("CsvImportPlugin.sync", () => {
  const plugin = new CsvImportPlugin();

  it("parses a well-formed CSV with explicit mapping", async () => {
    const f = join(TEST_DIR, "sync-test.csv");
    writeFileSync(f, "Date,Amount,Description\n2025-01-15,-50.00,Grocery Store\n2025-01-16,100.00,Paycheck\n");

    const txs = await plugin.sync({
      file_path: f,
      mapping: { date: "Date", amount: "Amount", merchant: "Description" },
    });

    expect(txs).toHaveLength(2);
    expect(txs[0].date).toBe("2025-01-15");
    expect(txs[0].amount).toBe(50);
    expect(txs[0].merchant).toBe("Grocery Store");
    expect(txs[0].sourcePlugin).toBe("csv_import");
  });

  it("auto-detects columns from standard headers", async () => {
    const f = join(TEST_DIR, "auto-detect.csv");
    writeFileSync(f, "Date,Amount,Description\n2025-03-01,-25.00,Coffee Shop\n");

    const txs = await plugin.sync({ file_path: f });

    expect(txs).toHaveLength(1);
    expect(txs[0].merchant).toBe("Coffee Shop");
  });

  it("throws when file_path is missing", async () => {
    await expect(plugin.sync({})).rejects.toThrow("file_path is required");
  });

  it("throws when columns cannot be detected", async () => {
    const f = join(TEST_DIR, "bad-headers.csv");
    writeFileSync(f, "Foo,Bar,Baz\n1,2,3\n");

    await expect(plugin.sync({ file_path: f })).rejects.toThrow("Could not auto-detect");
  });

  it("passes options through to parser", async () => {
    const f = join(TEST_DIR, "options-test.csv");
    writeFileSync(f, "Report Header\nDate;Amount;Description\n15/01/2025;50.00;Store\n");

    const txs = await plugin.sync({
      file_path: f,
      mapping: { date: "Date", amount: "Amount", merchant: "Description" },
      options: { skipRows: 1, delimiter: ";", dateFormat: "DD/MM/YYYY" },
    });

    expect(txs).toHaveLength(1);
    expect(txs[0].date).toBe("2025-01-15");
  });
});
