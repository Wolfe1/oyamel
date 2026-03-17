# Contributing to Oyamel

Thanks for your interest in contributing! Whether you're reporting a bug, requesting a data source, or submitting code, this guide will help you get started.

## Reporting Issues

Open an issue at [github.com/Wolfe1/oyamel/issues](https://github.com/Wolfe1/oyamel/issues). Please include:

- **Bug reports**: Steps to reproduce, expected vs actual behavior, Node.js version, and OS. If the issue involves a specific file format (PDF layout, CSV structure), include a sanitized sample or describe the format — **never include real financial data**.
- **Data source requests**: Name of the financial product, how you currently export data (PDF, CSV, API, etc.), and a sample of the file format with fake data if possible.
- **Feature requests**: What you'd like to see and why. Context on your use case helps prioritize.

## Pull Requests

1. Fork the repo and create a branch from `main`
2. Make your changes (see development setup below)
3. Add or update tests to cover your changes
4. Run `npm test` and `npm run typecheck` — both must pass
5. Open a PR against `main` with a clear description of what changed and why

### PR guidelines

- Keep PRs focused — one feature or fix per PR
- Follow existing code style (TypeScript strict mode, plain functions over classes where possible)
- Update documentation if your change affects CLI commands, plugin interfaces, or architecture
- Do not commit `.env` files, credentials, real financial data, or PDF statements

## Development Setup

```bash
git clone https://github.com/Wolfe1/oyamel.git
cd oyamel
npm install
```

### Running the CLI locally

```bash
npx tsx src/cli.ts <command>
# e.g.
npx tsx src/cli.ts coinbase-one preview path/to/statement.pdf
npx tsx src/cli.ts plugins
```

### Running tests

```bash
npm test              # Run all tests once
npm run test:watch    # Watch mode
npm run typecheck     # Type checking only
```

### Test coverage expectations

- All new functionality must have corresponding tests
- Unit tests go in `tests/` and should mirror the source structure (e.g., `src/plugins/foo/parser.ts` -> `tests/foo-parser.test.ts`)
- Tests must use synthetic/fake data — never commit real financial data, account numbers, or PII
- Run the full suite before submitting: `npm test && npm run typecheck`

## Adding a New Plugin

This is the most common type of contribution. Each plugin lives in its own directory under `src/plugins/`.

### Step 1: Create the plugin directory

```
src/plugins/<plugin-id>/
```

Use a kebab-case ID that matches how users will invoke it on the CLI (e.g., `kraken`, `chase-csv`, `amex-pdf`).

### Step 2: Implement the `SourcePlugin` interface

Create your main plugin file (e.g., `index.ts` or `parser.ts`) implementing the interface from `src/plugins/base.ts`:

```typescript
import type { Command } from "commander";
import type { Transaction } from "../../schema.js";
import type { SourcePlugin, PluginMetadata, CliHelpers } from "../base.js";

export class MyPlugin implements SourcePlugin {
  metadata(): PluginMetadata {
    return {
      id: "my-plugin",
      name: "My Data Source",
      description: "Sync transactions from My Data Source",
    };
  }

  registerCommands(parent: Command, helpers: CliHelpers): void {
    // Add `preview` and `sync` subcommands — see existing plugins for the pattern
  }

  async acquire(config: Record<string, unknown>): Promise<Record<string, unknown>[]> {
    // Read/fetch raw data from the source
  }

  transform(rawRecords: Record<string, unknown>[]): Transaction[] {
    // Convert raw records into the common Transaction schema
  }

  async sync(config: Record<string, unknown>): Promise<Transaction[]> {
    // Convenience: acquire + transform
    const raw = await this.acquire(config);
    return this.transform(raw);
  }
}
```

#### For CSV-based plugins

If your source exports CSV files, you can build on the shared CSV parser at `src/ingestion/csv.ts` instead of writing your own:

```typescript
import { parseCsvFile, type CsvColumnMapping, type CsvParseOptions } from "../../ingestion/csv.js";

const MAPPING: CsvColumnMapping = {
  date: "Transaction Date",
  amount: "Amount",
  merchant: "Description",
};

const OPTIONS: CsvParseOptions = {
  sourcePlugin: "my-plugin",
};

// In your sync() method:
const transactions = await parseCsvFile(filePath, MAPPING, OPTIONS);
```

The shared parser handles delimiter detection, date/amount normalization, RFC 4180 edge cases, and more.

### Step 3: Register the plugin

Add one line to `src/plugins/registry.ts`:

```typescript
import { MyPlugin } from "./my-plugin/index.js";

export const plugins: SourcePlugin[] = [
  new CoinbaseOnePdfPlugin(),
  new CsvImportPlugin(),
  new MyPlugin(),  // <-- add here
];
```

### Step 4: Add tests

Create `tests/my-plugin.test.ts` with:

- Unit tests for your parsing/transform logic
- Edge cases (empty input, malformed data, missing fields)
- Use synthetic test data only

### Step 5: Add a plugin README (optional but appreciated)

Create `src/plugins/<plugin-id>/README.md` describing:

- What financial product/service the plugin supports
- How users get their data (where to download statements/exports)
- Any plugin-specific CLI options
- Example usage

### Plugin conventions

- Plugins receive `CliHelpers` with shared operations — use them instead of reimplementing auth, account selection, or push logic
- Follow the `preview` / `sync` subcommand pattern from existing plugins
- Set `sourcePlugin` on all transactions to your plugin's ID
- Keep all plugin code within its own directory under `src/plugins/`

## Questions?

Open an issue or start a discussion. Happy to help with plugin development, file format questions, or anything else.
