/** CLI entry point for Oyamel. */

import { resolve, join } from "path";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { homedir } from "os";
import { Command } from "commander";
import { config as loadEnv } from "dotenv";
import { MonarchClient, type PushEvent } from "./ingestion/client.js";
import { signedAmount, type Transaction } from "./schema.js";
import { plugins } from "./plugins/registry.js";
import type { CliHelpers } from "./plugins/base.js";

// Load credentials from ~/.oyamel/credentials first, then fall back to .env
const CREDS_DIR = join(homedir(), ".oyamel");
const CREDS_PATH = join(CREDS_DIR, "credentials");
if (existsSync(CREDS_PATH)) {
  loadEnv({ path: CREDS_PATH, quiet: true });
}
// Also load .env for backward compatibility (won't override already-set vars)
const envPath = resolve(import.meta.dirname, "..", ".env");
loadEnv({ path: envPath, quiet: true });

import * as readline from "readline";

function prompt(question: string, opts?: { mask?: boolean }): Promise<string> {
  if (opts?.mask && process.stdin.isTTY) {
    return new Promise((resolve) => {
      process.stdout.write(question);
      const stdin = process.stdin;
      stdin.setRawMode(true);
      stdin.resume();
      stdin.setEncoding("utf-8");
      let input = "";
      const onData = (ch: string) => {
        const c = ch.toString();
        if (c === "\n" || c === "\r" || c === "\u0004") {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.removeListener("data", onData);
          process.stdout.write("\n");
          resolve(input.trim());
        } else if (c === "\u0003") {
          process.exit(130);
        } else if (c === "\u007f" || c === "\b") {
          if (input.length > 0) {
            input = input.slice(0, -1);
            process.stdout.write("\b \b");
          }
        } else {
          input += c;
          process.stdout.write("*");
        }
      };
      stdin.on("data", onData);
    });
  }
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function confirm(question: string, defaultYes = true): Promise<boolean> {
  const suffix = defaultYes ? "[Y/n]" : "[y/N]";
  const answer = await prompt(`${question} ${suffix} `);
  if (!answer) return defaultYes;
  return answer.toLowerCase().startsWith("y");
}

function getCredential(envVar: string): string | null {
  const value = process.env[envVar]?.trim();
  return value || null;
}

function saveCredentials(
  email: string,
  password: string,
  mfaSecret: string | null,
): void {
  if (!existsSync(CREDS_DIR)) mkdirSync(CREDS_DIR, { recursive: true, mode: 0o700 });
  const lines = [
    "# Monarch Money credentials",
    `MONARCH_EMAIL="${email}"`,
    `MONARCH_PASSWORD="${password}"`,
    "# MFA TOTP secret (base32). Set to 'none' to skip the prompt.",
  ];
  if (mfaSecret) {
    lines.push(`MONARCH_MFA_SECRET="${mfaSecret}"`);
  } else {
    lines.push("MONARCH_MFA_SECRET=none");
  }
  writeFileSync(CREDS_PATH, lines.join("\n") + "\n", { mode: 0o600 });
  console.log(`Saved to ${CREDS_PATH}`);
}

function printTransactions(transactions: Transaction[]): void {
  for (const tx of transactions) {
    const sign = tx.txType === "debit" ? "-" : "+";
    const amt = tx.amount.toFixed(2).padStart(10);
    console.log(`  ${tx.date}  ${sign}$${amt}  ${tx.merchant}`);
  }
  const total = transactions.reduce((sum, tx) => sum + tx.amount, 0);
  console.log(`\n  Total: $${total.toFixed(2)}`);
}

async function authenticateMonarch(): Promise<MonarchClient> {
  console.log("\n--- Monarch Authentication ---");
  let email = getCredential("MONARCH_EMAIL");
  if (!email) email = await prompt("Monarch email: ");

  let password = getCredential("MONARCH_PASSWORD");
  if (!password) password = await prompt("Monarch password: ", { mask: true });

  const mfaEnv = process.env.MONARCH_MFA_SECRET?.trim() ?? "";
  let mfaSecret: string | null = null;
  if (mfaEnv && mfaEnv.toLowerCase() !== "none") {
    mfaSecret = mfaEnv;
  } else if (!mfaEnv) {
    if (await confirm("Do you have an MFA TOTP secret?", false)) {
      mfaSecret = await prompt("MFA secret (base32): ", { mask: true });
    }
  }

  if (!process.env.MONARCH_EMAIL) {
    if (await confirm("\nSave credentials to ~/.oyamel/credentials for future runs?")) {
      saveCredentials(email, password, mfaSecret);
    }
  }

  const client = new MonarchClient();
  console.log("\nLogging in to Monarch...");

  try {
    await client.login(email, password, { mfaSecret: mfaSecret ?? undefined });
  } catch (err: any) {
    if (
      err?.message?.includes("MFA") ||
      err?.message?.includes("multi-factor") ||
      err?.code === "MFA_REQUIRED"
    ) {
      console.log(
        "Monarch requires verification. Check your email for a one-time code " +
          "(or use your authenticator app if MFA is enabled).",
      );
      const mfaCode = await prompt("Verification code: ");
      await client.login(email, password, { mfaCode });
    } else {
      throw err;
    }
  }
  console.log("Logged in successfully.");
  return client;
}

async function resolveAccount(
  client: MonarchClient,
  pluginId: string,
  accountOpt?: string,
): Promise<{ accountId: string; accountName: string }> {
  const accounts = await client.listAccounts();
  let accountName = accountOpt;
  let accountId: string | null = null;

  if (!accountName) {
    const saved = client.getSavedAccount(pluginId);
    if (saved) {
      const match = accounts.find((a) => a.id === saved.id);
      if (match) {
        accountName = match.name;
        accountId = match.id;
        console.log(`\nUsing saved account: ${accountName}`);
      }
    }
  }

  if (!accountName) {
    console.log("\nAvailable Monarch accounts:");
    accounts.forEach((a, i) => {
      console.log(
        `  ${i + 1}. ${a.name} (${a.type}) — $${a.balance.toFixed(2)}`,
      );
    });

    const choice = parseInt(await prompt("\nSelect account number: "), 10);
    if (choice < 1 || choice > accounts.length) {
      console.log("Invalid selection.");
      process.exit(1);
    }
    accountName = accounts[choice - 1].name;
    accountId = accounts[choice - 1].id;

    client.saveAccount(pluginId, accountId, accountName);
    console.log(`Saved '${accountName}' as default for ${pluginId}.`);
  }

  if (!accountId) {
    accountId = await client.getAccountIdByName(accountName);
  }
  if (!accountId) {
    console.log(`\nAccount '${accountName}' not found. Available accounts:`);
    for (const a of accounts) {
      console.log(`  - ${a.name} (${a.type})`);
    }
    process.exit(1);
  }

  return { accountId, accountName };
}

async function pushAndReport(
  client: MonarchClient,
  transactions: Transaction[],
  accountId: string,
  accountName: string,
  opts: { dryRun?: boolean; debug?: boolean },
): Promise<void> {
  console.log(`\nTarget account: ${accountName}`);

  if (opts.dryRun) {
    console.log(
      `[DRY RUN] Would push ${transactions.length} transactions to '${accountName}'.`,
    );
    return;
  }

  if (
    !(await confirm(
      `Push ${transactions.length} transactions to '${accountName}'?`,
    ))
  ) {
    console.log("Cancelled.");
    return;
  }

  console.log();
  const result = await client.pushTransactions(
    transactions,
    accountId,
    true,
    (event, counts) => {
      const tx = event.transaction;
      const sign = tx.txType === "debit" ? "-" : "+";
      const amt = `${sign}$${tx.amount.toFixed(2)}`;
      if (opts.debug) {
        if (event.type === "skip") {
          console.log(`  SKIP  ${tx.date}  ${amt.padStart(12)}  ${tx.merchant}`);
        } else {
          const cat = event.categoryName ?? "Uncategorized";
          console.log(`  ADD   ${tx.date}  ${amt.padStart(12)}  ${tx.merchant}  [${cat}]`);
        }
      } else {
        process.stdout.write(
          `\r  Pushing: ${counts.created}/${counts.total} created` +
            (counts.skipped ? `, ${counts.skipped} duplicates skipped` : ""),
        );
      }
    },
  );
  const catMsg = result.categorized
    ? `, ${result.categorized} auto-categorized`
    : "";
  console.log(
    `${opts.debug ? "" : "\n"}\nDone. Created ${result.created} transactions, skipped ${result.skipped} duplicates${catMsg}.`,
  );
}

// ── CLI Setup ──────────────────────────────────────────────────────────

const helpers: CliHelpers = {
  authenticateMonarch,
  resolveAccount,
  printTransactions,
  confirm,
  pushAndReport,
};

const program = new Command();

program
  .name("oyamel")
  .description("Oyamel — sync unsyncable financial data to Monarch Money");

// Register each plugin as a subcommand group
for (const plugin of plugins) {
  const meta = plugin.metadata();
  const sub = program.command(meta.id).description(meta.description);
  plugin.registerCommands(sub, helpers);
}

// Top-level commands
program
  .command("recategorize")
  .description(
    "Re-categorize uncategorized transactions using merchant history",
  )
  .option("--account <name>", "Monarch account display name")
  .option("--plugin <id>", "Plugin ID for account lookup", "coinbase-one")
  .action(async (opts: { account?: string; plugin: string }) => {
    const client = await authenticateMonarch();
    const { accountId, accountName } = await resolveAccount(
      client,
      opts.plugin,
      opts.account,
    );

    console.log(`\nTarget account: ${accountName}`);
    console.log("Scanning for uncategorized transactions...\n");

    const result = await client.recategorize(
      accountId,
      (updated, total) => {
        process.stdout.write(
          `\r  Re-categorizing: ${updated} updated out of ${total} uncategorized`,
        );
      },
    );

    if (result.total === 0) {
      console.log("No uncategorized transactions found.");
    } else {
      console.log(
        `\n\nDone. Updated ${result.updated} of ${result.total} uncategorized transactions.` +
          (result.total - result.updated > 0
            ? ` ${result.total - result.updated} had no matching merchant history.`
            : ""),
      );
    }
  });

program
  .command("plugins")
  .description("List available plugins")
  .action(() => {
    console.log("\nAvailable plugins:\n");
    for (const plugin of plugins) {
      const meta = plugin.metadata();
      console.log(`  ${meta.id.padEnd(20)} ${meta.name}`);
      console.log(`  ${"".padEnd(20)} ${meta.description}\n`);
    }
  });

program.parse();
