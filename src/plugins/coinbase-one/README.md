# Coinbase One Credit Card Plugin

Parses monthly PDF statements from the Coinbase One credit card (issued by Cardless/First Electronic Bank on the Amex network) and syncs transactions to Monarch Money.

## Why this plugin exists

The Coinbase One credit card doesn't support Plaid or MX connections, so there's no way to auto-sync it with Monarch. Coinbase also doesn't offer CSV exports for credit card transactions — the only record you get is a monthly PDF statement.

## How it works

1. Extracts text from the PDF using [PDF.js](https://mozilla.github.io/pdf.js/), reconstructing lines from Y-coordinates
2. Identifies "Transactions" (debits) and "Payments and credits" (credits) sections
3. Parses each transaction line: date, merchant descriptor, and amount
4. Cleans merchant names — strips POS prefixes, addresses, zip codes, terminal codes, and corporate suffixes
5. Outputs standardized `Transaction` objects ready for dedup and push

### Merchant name cleaning

Raw PDF descriptors are messy. The parser cleans them automatically:

| Raw descriptor | Cleaned name |
|---------------|-------------|
| `TST* SWEETGREEN 1234 MAIN ST 10001` | `Sweetgreen` |
| `SQ *BLUE BOTTLE COFFEE` | `Blue Bottle Coffee` |
| `BESTBUYCOM806123456` | `Bestbuy.com` |
| `WHOLEFDS MKT 10234 5678 OAK AVE` | `Wholefds Mkt` |

## Usage

```bash
# Preview what would be imported (no Monarch login required)
npx oyamel coinbase-one preview path/to/statement.pdf

# Sync a single statement
npx oyamel coinbase-one sync path/to/statement.pdf

# Sync a whole folder of statements at once
npx oyamel coinbase-one sync path/to/statements/

# Sync with options
npx oyamel coinbase-one sync path/to/statement.pdf --account "Coinbase One Credit Card" --dry-run
```

## Commands

### `preview <path>`

Parses the PDF and displays transactions in a table without connecting to Monarch.

| Option | Description |
|--------|-------------|
| `--limit <n>` | Max transactions to show (0 = all, default: 0) |

### `sync <path>`

Parses, deduplicates, auto-categorizes, and pushes transactions to Monarch.

| Option | Description |
|--------|-------------|
| `--account <name>` | Override target Monarch account name |
| `--dry-run` | Parse and dedup only — don't push to Monarch |
| `--debug` | Show per-transaction ADD/SKIP details |

`<path>` can be a single `.pdf` file or a directory containing multiple PDFs.

## Statement format

The parser expects Coinbase One monthly statements with this structure:

- **"Transactions"** section — debits (purchases)
- **"Payments and credits"** section — credits (payments, refunds)
- Date format: `Sep 25, 2025`
- Amounts: `$49.99` (always positive; sign is determined by section)

Sections like "Fees", "Interest charges", "Account summary", and payment warning tables are automatically skipped.

## Getting statements

1. Log into [card.coinbase.com](https://card.coinbase.com)
2. Go to **Statements**
3. Download the monthly PDF(s) you want to import
