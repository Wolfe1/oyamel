# Oyamel

## What This Project Is
A plugin-based CLI tool (named after the oyamel fir forests where monarch butterflies complete their migration) that syncs financial data from sources that can't natively connect to [Monarch Money](https://app.monarch.com) (a personal finance app).

## The Problem
Many financial products (e.g., Coinbase One credit card) don't support Plaid/MX connections, so users can't auto-sync transactions into Monarch. The only workaround is manually downloading PDFs/CSVs and uploading them through Monarch's web UI.

## Architecture
- **Plugins** — Each data source gets a plugin that handles data acquisition (PDF parsing, API calls, etc.), transforms raw data into a common transaction schema, and registers its own CLI subcommands.
- **Ingestion layer** — Common module that authenticates with Monarch via direct GraphQL calls, deduplicates transactions (count-based), auto-categorizes via merchant history, and pushes them into the user's Monarch account. Includes a shared CSV parser (`csv.ts`) that any CSV-based plugin can use.
- **CLI** — Plugin-aware CLI via `commander`. Each plugin registers as a subcommand group (e.g., `oyamel coinbase-one sync <path>`). Shared helpers (auth, account resolution, push+report) are passed to plugins via `CliHelpers`.
- **MCP server** — Planned. Will wrap the same `SourcePlugin.sync()` interface as MCP tools.

## Key Dependencies
- `pdfjs-dist` — Mozilla PDF.js for PDF text extraction
- `commander` — CLI framework
- `dotenv` — Environment variable loading
- `vitest` — Test runner
- Node.js 18+ (22+ recommended)

Note: All Monarch API calls go through direct `fetch()` against `https://api.monarch.com/graphql`. The `monarchmoney` npm SDK is not used due to compatibility issues with our auth and session management approach.

## Project Structure
```
src/
  schema.ts                       — Common Transaction type, dedupKey(), signedAmount()
  cli.ts                          — CLI entry point: plugin registry loop, shared CliHelpers,
                                    top-level commands (recategorize, plugins)
  ingestion/
    client.ts                     — MonarchClient: auth, GraphQL, push, dedup, auto-categorize,
                                    recategorize, plugin→account mapping
    dedup.ts                      — Count-based deduplication (handles duplicate legitimate txns)
    csv.ts                        — Shared CSV parser: delimiter detection, RFC 4180 parsing,
                                    date/amount normalization, column auto-detection
  plugins/
    base.ts                       — SourcePlugin interface, PluginMetadata, CliHelpers interface
    registry.ts                   — Plugin registry array (add new plugins here)
    coinbase-one/
      pdf-parser.ts               — Coinbase One CC: PDF parser, merchant cleaning,
                                    registerCommands() for preview/sync subcommands
    csv-import/
      index.ts                    — Generic CSV import: column mapping (explicit or auto-detected),
                                    mapping file support, preview/sync subcommands
tests/
  schema.test.ts                  — signedAmount, dedupKey tests
  dedup.test.ts                   — Count-based deduplication tests
  pdf-parser.test.ts              — PDF parser unit + integration tests
  csv.test.ts                     — CSV parser unit tests (delimiter, amounts, dates, columns)
  csv-import.test.ts              — CSV import plugin tests (path resolution, sync, auto-detect)
```

## CLI Commands
```
oyamel <plugin> <command>              Plugin-scoped commands

oyamel coinbase-one preview <path>     Preview parsed transactions from PDF
oyamel coinbase-one sync <path>        Sync PDF statement(s) to Monarch

oyamel csv-import preview <path>       Preview parsed transactions from CSV
oyamel csv-import sync <path>          Sync CSV file(s) to Monarch
  --date-col <name>                    Column name for date
  --amount-col <name>                  Column name for amount
  --merchant-col <name>               Column name for merchant/description
  --debit-col <name>                   Column for debit amount (alt to amount-col)
  --credit-col <name>                  Column for credit amount (alt to amount-col)
  --date-format <fmt>                  Date format (e.g., MM/DD/YYYY, DD/MM/YYYY)
  --delimiter <char>                   Field delimiter (auto-detected if omitted)
  --skip-rows <n>                      Rows to skip before header
  --amount-sign <convention>           negative-debit (default) or negative-credit
  --mapping-file <path>                JSON file with saved column mapping

Common sync options (all plugins):
  --account <name>                     Override target account
  --dry-run                            Parse + dedup only, don't push
  --debug                              Per-transaction ADD/SKIP logging

oyamel recategorize                    Re-categorize uncategorized txns
  --account <name>                     Target account
  --plugin <id>                        Plugin for account lookup (default: coinbase-one)

oyamel plugins                         List available plugins
```

Run with: `npx oyamel <command>`
Run tests: `npm test`
Type check: `npm run typecheck`

## Adding a New Plugin
1. Create `src/plugins/<plugin-id>/` directory
2. Implement `SourcePlugin` interface (see `base.ts`):
   - `metadata()` — return `{ id, name, description }`
   - `registerCommands(parent, helpers)` — add CLI subcommands to `parent` Command
   - `acquire(config)` — fetch/read raw data
   - `transform(rawRecords)` — convert to `Transaction[]`
   - `sync(config)` — convenience: acquire + transform
3. Add one line to `src/plugins/registry.ts`

### CSV-based plugins
For plugins that parse CSV files, use the shared utility at `src/ingestion/csv.ts`:
- Define a `CsvColumnMapping` with your source's column names
- Call `parseCsvFile(path, mapping, options)` to get `Transaction[]`
- Set `sourcePlugin` in options to your plugin's ID
- This avoids duplicating CSV parsing logic across plugins

Plugins receive `CliHelpers` with shared operations:
- `authenticateMonarch()` — handles credentials, MFA, session reuse
- `resolveAccount(client, pluginId, accountOpt?)` — saved mapping → interactive pick
- `printTransactions(transactions)` — formatted transaction table
- `confirm(question, defaultYes?)` — Y/n prompt
- `pushAndReport(client, transactions, accountId, accountName, opts)` — push with progress/debug, dedup, auto-categorize, summary

## Key Technical Details

### Monarch API
- Direct GraphQL at `https://api.monarch.com/graphql` (NOT the SDK)
- Auth: email + password + email OTP via `/auth/login/` endpoint
- `createTransaction` mutation requires `CreateTransactionMutationInput!` with **required** `categoryId` (ID!)
- `shouldUpdateBalance: true` to update account balance on each transaction
- Credentials saved to `~/.oyamel/credentials` (falls back to `.env` for backward compat)
- Session token persisted at `~/.oyamel/session_token`
- Plugin→account mapping at `~/.oyamel/plugin_accounts.json`

### Deduplication
- Count-based (not set-based) — correctly handles multiple identical legitimate transactions (e.g., 3x $100 at same merchant same day)
- Dedup key: `date|signed_amount|merchant_lower`
- Only deduplicates against existing Monarch transactions, NOT within incoming batch

### Auto-Categorization
- Builds merchant→category map from ALL user transactions across accounts
- Three-tier matching: exact → substring → token overlap (2+ shared meaningful words)
- Falls back to "Uncategorized" for unknown merchants
- `recategorize` command updates existing uncategorized transactions retroactively

### CSV Parser (`src/ingestion/csv.ts`)
- RFC 4180 compliant: handles quoted fields, embedded commas/newlines, escaped quotes
- Auto-detects delimiter (comma, tab, semicolon, pipe)
- Auto-detects column mapping from common header names (Date, Amount, Description, etc.)
- Amount parsing: `$1,234.56`, `($123.45)` parenthetical negatives, European `1.234,56`
- Date parsing: ISO, MM/DD/YYYY, DD/MM/YYYY, M/D/YY, month names
- Supports separate debit/credit columns
- Handles BOM, trailing commas, preamble rows

### Coinbase One Plugin
- Parses monthly PDF statements from Coinbase One credit card (Cardless/First Electronic Bank, Amex network)
- PDF sections: "Transactions" (debits) + "Payments and credits" (credits)
- Filters out non-transaction content (payment warnings, account summary, minimum payment tables)
- Merchant name cleaning: strips POS prefixes, addresses, zip codes, terminal codes, corporate suffixes
- Accepts single PDF file or directory of PDFs

## Coding Conventions
- TypeScript with strict mode
- Vitest for testing
- Keep plugins self-contained in their own directories
- No classes where plain functions suffice (schema uses interfaces + functions)
- CSV-based plugins should use the shared `src/ingestion/csv.ts` utility
- CLAUDE.md and memory files MUST be updated when code structure, commands, or architecture changes
