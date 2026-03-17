# Oyamel - Monarch Money Data Migration CLI

*Named after the [oyamel fir forests](https://en.wikipedia.org/wiki/Abies_religiosa) in central Mexico where millions of monarch butterflies complete their annual migration.*

A plugin-based CLI tool that migrates financial data from sources that can't natively connect to [Monarch Money](https://app.monarch.com).

## The Problem

Some financial products — like the Coinbase One credit card — don't support Plaid or MX connections, so there is currently no official way to auto-sync transactions into Monarch Money. The only option is manually downloading statements and entering transactions by hand.

Oyamel aims to automate this (or at least make the process easier). Point it at a statement or CSV export, and it parses, deduplicates, auto-categorizes, and pushes transactions directly into your Monarch account.

## Note to the Community

This was mainly made to bridge the gap for the Coinbase One Credit Card syncing issues. I saw the potential for other syncing services as plugins going forward so I am open to looking into any reported issues or requests the community wants added. Please feel free to drop in an issue and be sure to provide any information, example docs to sync, etc and I will see what can be done.

## Quick Start

1. Prerequisite: In order to sync the data over you need to create a manual account in Monarch:
<img width="749" height="531" alt="image" src="https://github.com/user-attachments/assets/6c403b8f-9989-4c3a-9172-95a4edc539bc" />

- Set the type, name, and default the balance to $0

2. Run the command for your sync:

```bash
# Sync a Coinbase One Credit Card PDF statement
npx github:Wolfe1/oyamel coinbase-one sync "path/to/statement.pdf"

# Or Sync a folder of Coinbase One Credit Card PDF statements all at once
npx github:Wolfe1/oyamel coinbase-one sync "path/to/statement/directory"


# Or import a CSV export from any bank
npx github:Wolfe1/oyamel csv-import sync "path/to/export.csv"

# Or import a folder of CSV exports from any bank all at once
npx github:Wolfe1/oyamel csv-import sync "path/to/export/directory"
```

No install required — `npx` downloads and runs it automatically. Oyamel walks you through Monarch authentication and account selection on first run.

<details>
<summary>Local install (for development or repeat use)</summary>

```bash
git clone https://github.com/Wolfe1/oyamel.git
cd oyamel
npm install
npx oyamel coinbase-one sync path/to/statement.pdf
```

</details>

## Features

- **PDF statement parsing** — Extracts transactions from credit card PDF statements
- **Generic CSV import** — Import from any bank/institution that offers CSV exports, with auto-detected or explicit column mapping
- **Smart deduplication** — Count-based dedup that correctly handles legitimate duplicate transactions (e.g., 3x $100 at the same merchant on the same day)
- **Auto-categorization** — Learns from your existing Monarch transaction history using three-tier matching (exact, substring, token overlap)
- **Plugin architecture** — Easy to add new data sources without touching core code
- **Dry-run mode** — Preview what would be synced without pushing anything
- **Recategorize command** — Retroactively categorize previously uncategorized transactions

## Supported Sources

| Source | Method | Status | Docs |
|--------|--------|--------|------|
| Coinbase One Credit Card | PDF statement parsing | Available | [Plugin README](src/plugins/coinbase-one/README.md) |
| Any CSV export | Generic CSV import | Available | [Plugin README](src/plugins/csv-import/README.md) |

## Prerequisites

- [Node.js](https://nodejs.org/) 18+ (22+ recommended)
- A [Monarch Money](https://app.monarch.com) account
- A manual account in Monarch for the financial product you want to sync

## Usage

### Coinbase One Credit Card

```bash
npx oyamel coinbase-one preview path/to/statement.pdf
npx oyamel coinbase-one sync path/to/statement.pdf
npx oyamel coinbase-one sync path/to/statements/   # whole folder
```

See the [Coinbase One plugin README](src/plugins/coinbase-one/README.md) for details on statement format, merchant name cleaning, and how to get your statements.

### CSV Import

Works with any bank, brokerage, crypto exchange, or financial product that lets you download a CSV export.

```bash
# Auto-detect columns from common header names
npx oyamel csv-import preview path/to/export.csv

# Specify columns explicitly
npx oyamel csv-import sync path/to/export.csv \
  --date-col "Transaction Date" \
  --amount-col "Amount" \
  --merchant-col "Description"

# Use a saved mapping file for repeat imports
npx oyamel csv-import sync path/to/export.csv --mapping-file my-bank.json
```

See the [CSV import plugin README](src/plugins/csv-import/README.md) for the full options reference, column auto-detection details, mapping file format, and bank-specific examples.

### Common options (all plugins)

```
--account <name>    Override target Monarch account name
--dry-run           Parse and dedup only — don't push to Monarch
--debug             Show per-transaction ADD/SKIP details
```

### Other commands

```bash
# Re-categorize previously uncategorized transactions
npx oyamel recategorize --account "Coinbase One Credit Card"

# List available plugins
npx oyamel plugins
```

## How It Works

1. **Parse** — The plugin reads raw data from the source (PDF statements, CSV exports, etc.) and extracts transaction records
2. **Transform** — Raw records are normalized into a common `Transaction` schema
3. **Deduplicate** — Incoming transactions are compared against existing Monarch transactions using count-based dedup keys (`date|amount|merchant`)
4. **Auto-categorize** — Each merchant is matched against your Monarch transaction history to find the most likely category
5. **Push** — New transactions are created in Monarch via the GraphQL API

### Authentication

On first run, Oyamel prompts for your Monarch email, password, and handles email OTP verification interactively. You'll be offered to save credentials to `~/.oyamel/credentials` for future runs. The session token is cached at `~/.oyamel/session_token` so subsequent runs skip authentication entirely.

### Account Mapping

The first time you sync a plugin, you'll be prompted to select a target Monarch account from a list. This mapping is saved at `~/.oyamel/plugin_accounts.json` so you don't have to pick again.

## Adding a New Plugin

1. Create `src/plugins/<plugin-id>/` directory
2. Implement the `SourcePlugin` interface from `src/plugins/base.ts`:
   - `metadata()` — return `{ id, name, description }`
   - `registerCommands(parent, helpers)` — add CLI subcommands
   - `acquire(config)` — fetch/read raw data
   - `transform(rawRecords)` — convert to `Transaction[]`
   - `sync(config)` — convenience: acquire + transform
3. Register your plugin in `src/plugins/registry.ts`

Plugins receive `CliHelpers` with shared operations for authentication, account resolution, transaction display, and push+report — so you only need to focus on data acquisition and transformation.

### Adding a CSV-based plugin

For sources that export CSV files, you can build a thin plugin on top of the shared CSV utility. The entire plugin is mostly just a column mapping config:

```typescript
// src/plugins/kraken/index.ts
import type { Command } from "commander";
import type { Transaction } from "../../schema.js";
import type { SourcePlugin, PluginMetadata, CliHelpers } from "../base.js";
import { parseCsvFile, type CsvColumnMapping, type CsvParseOptions } from "../../ingestion/csv.js";

const MAPPING: CsvColumnMapping = {
  date: "time",
  amount: "cost",
  merchant: "pair",    // e.g. "BTC/USD"
};

const OPTIONS: CsvParseOptions = {
  sourcePlugin: "kraken",
  // dateFormat, delimiter, amountSign, etc. as needed
};

export class KrakenPlugin implements SourcePlugin {
  metadata(): PluginMetadata {
    return { id: "kraken", name: "Kraken Exchange", description: "Sync Kraken trade history" };
  }

  registerCommands(parent: Command, helpers: CliHelpers): void {
    // Add preview and sync subcommands using helpers + parseCsvFile()
    // See csv-import/index.ts or coinbase-one/pdf-parser.ts for the full pattern
  }

  async acquire(config: Record<string, unknown>) { /* ... */ }
  transform(raw: Record<string, unknown>[]): Transaction[] { /* ... */ }

  async sync(config: Record<string, unknown>): Promise<Transaction[]> {
    return parseCsvFile(config.file_path as string, MAPPING, OPTIONS);
  }
}
```

Then add one line to `src/plugins/registry.ts` and you're done. The shared CSV utility handles delimiter detection, date/amount parsing, and all the edge cases.

## Project Structure

```
src/
  schema.ts                  — Common Transaction type and helpers
  cli.ts                     — CLI entry point and plugin registry
  ingestion/
    client.ts                — Monarch API client (auth, GraphQL, push, dedup)
    dedup.ts                 — Count-based deduplication logic
    csv.ts                   — Shared CSV parser (any CSV plugin can use this)
  plugins/
    base.ts                  — SourcePlugin interface
    registry.ts              — Plugin registry
    coinbase-one/
      pdf-parser.ts          — Coinbase One credit card PDF parser
    csv-import/
      index.ts               — Generic CSV importer with column auto-detection
tests/
  schema.test.ts             — Transaction schema tests
  dedup.test.ts              — Deduplication tests
  pdf-parser.test.ts         — PDF parser tests
  csv.test.ts                — CSV parser tests
  csv-import.test.ts         — CSV import plugin tests
```

## Development

```bash
# Run tests
npm test

# Type check
npm run typecheck

# Watch mode
npm run test:watch
```

## Disclaimer

This project is not affiliated with, endorsed by, or officially connected to Monarch Money, Coinbase, or any of their subsidiaries. It interacts with Monarch Money's API as an unofficial client. Use at your own risk — API changes could break functionality at any time.

## Acknowledgments

- **[monarchmoney](https://github.com/hammem/monarchmoney)** by hammem — The unofficial Python client for Monarch Money's API. Our GraphQL integration was informed by the community's reverse-engineering of the Monarch API.
- **[PDF.js](https://mozilla.github.io/pdf.js/)** — Mozilla's PDF rendering library, used for text extraction from PDF statements.
- **[Commander.js](https://github.com/tj/commander.js)** — CLI framework.
- **[dotenv](https://github.com/motdotla/dotenv)** — Environment variable loading.

## License

[MIT](LICENSE)
