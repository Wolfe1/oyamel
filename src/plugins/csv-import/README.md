# Generic CSV Import Plugin

Import transactions from any CSV file into Monarch Money. Works with exports from banks, brokerages, crypto exchanges, or any financial product that lets you download transaction history as CSV.

## How it works

1. Auto-detects the delimiter (comma, tab, semicolon, or pipe)
2. Maps CSV columns to transaction fields — automatically from common header names, or explicitly via CLI flags / mapping file
3. Parses dates and amounts in a variety of formats
4. Outputs standardized `Transaction` objects ready for dedup and push

## Usage

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

# Sync a whole directory of CSV files
npx oyamel csv-import sync path/to/exports/
```

## Commands

### `preview <path>`

Parses the CSV and displays transactions in a table without connecting to Monarch.

### `sync <path>`

Parses, deduplicates, auto-categorizes, and pushes transactions to Monarch.

`<path>` can be a single `.csv` file or a directory containing multiple CSVs.

## Options

| Option | Description |
|--------|-------------|
| `--date-col <name>` | Column name for transaction date |
| `--amount-col <name>` | Column name for amount (single column) |
| `--merchant-col <name>` | Column name for merchant/description |
| `--debit-col <name>` | Column name for debit amount (use instead of `--amount-col`) |
| `--credit-col <name>` | Column name for credit amount (use with `--debit-col`) |
| `--date-format <fmt>` | Date format: `MM/DD/YYYY`, `DD/MM/YYYY`, `YYYY-MM-DD`, etc. |
| `--delimiter <char>` | Field delimiter — auto-detected if omitted |
| `--skip-rows <n>` | Number of preamble rows to skip before the header |
| `--amount-sign <mode>` | `negative-debit` (default) or `negative-credit` |
| `--mapping-file <path>` | Path to a JSON mapping config (see below) |
| `--account <name>` | Override target Monarch account name (sync only) |
| `--dry-run` | Parse and dedup only — don't push to Monarch (sync only) |
| `--debug` | Show per-transaction ADD/SKIP details (sync only) |

## Column auto-detection

If no column options are provided, the importer looks for common header names:

| Field | Recognized headers |
|-------|-------------------|
| Date | `Date`, `Transaction Date`, `Trans Date`, `Posting Date`, `Post Date`, `Posted Date`, `Trade Date` |
| Amount | `Amount`, `Transaction Amount`, `Trans Amount` |
| Debit | `Debit`, `Debit Amount`, `Withdrawal` |
| Credit | `Credit`, `Credit Amount`, `Deposit` |
| Merchant | `Description`, `Merchant`, `Merchant Name`, `Payee`, `Name`, `Memo`, `Narrative` |
| Category | `Category`, `Type` |

Auto-detection works with most major US banks (Chase, Bank of America, Capital One, Citi, Amex, Mint exports). Some sources with non-standard headers (Discover, Wells Fargo, Kraken, RBC) require explicit column flags or a mapping file.

## Mapping files

For repeat imports from the same source, save a JSON mapping file instead of passing flags every time.

### Single amount column

```json
{
  "date": "Transaction Date",
  "amount": "Amount",
  "merchant": "Description",
  "dateFormat": "MM/DD/YYYY",
  "category": "Category",
  "notes": "Memo"
}
```

### Separate debit/credit columns

```json
{
  "date": "Date",
  "debitAmount": "Withdrawal",
  "creditAmount": "Deposit",
  "merchant": "Payee",
  "amountSign": "separate-columns"
}
```

### Usage

```bash
npx oyamel csv-import sync export.csv --mapping-file my-bank.json
```

All mapping file fields can be overridden by CLI flags. The mapping file can also include `dateFormat`, `delimiter`, `skipRows`, and `amountSign`.

## Supported formats

The CSV parser handles:

- **Delimiters**: comma, tab, semicolon, pipe (auto-detected)
- **Quoting**: RFC 4180 — quoted fields, embedded commas/newlines, escaped quotes (`""`)
- **Amounts**: `$1,234.56`, `($123.45)` (parenthetical negatives), European `1.234,56`
- **Dates**: `YYYY-MM-DD`, `MM/DD/YYYY`, `DD/MM/YYYY`, `M/D/YY`, `Jan 15, 2025`
- **Encoding**: UTF-8 with BOM handling
- **Preamble rows**: skippable via `--skip-rows`

## Examples by bank

<details>
<summary>Chase (credit card or checking)</summary>

Auto-detected — no flags needed:
```bash
npx oyamel csv-import sync chase-transactions.csv
```
</details>

<details>
<summary>Bank of America</summary>

Auto-detected — no flags needed:
```bash
npx oyamel csv-import sync bofa-export.csv
```
</details>

<details>
<summary>Discover</summary>

Requires explicit columns:
```bash
npx oyamel csv-import sync discover.csv \
  --date-col "Trans. Date" \
  --amount-col "Amount" \
  --merchant-col "Description"
```
</details>

<details>
<summary>Wells Fargo</summary>

No header row — use column indices:
```bash
npx oyamel csv-import sync wellsfargo.csv \
  --date-col 0 \
  --amount-col 1 \
  --merchant-col 4
```

Or create a mapping file for repeat use.
</details>
