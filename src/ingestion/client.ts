/**
 * Monarch Money API client wrapper.
 *
 * Handles authentication and GraphQL calls directly against the Monarch API.
 * We bypass the monarchmoney-ts SDK for auth and API calls because:
 * 1. The SDK hardcodes the old domain (app.monarchmoney.com) in Origin headers
 * 2. The SDK's session storage doesn't accept externally-obtained tokens
 * 3. The SDK retries auth requests, triggering multiple email OTPs
 */

import { randomUUID } from "crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { deduplicate } from "./dedup.js";
import { type Transaction, signedAmount } from "../schema.js";

const MONARCH_API = "https://api.monarch.com";
const MONARCH_ORIGIN = "https://app.monarch.com";
const DATA_DIR = join(homedir(), ".oyamel");

const PLUGIN_ACCOUNTS_PATH = join(DATA_DIR, "plugin_accounts.json");

function ensureDataDir(): void {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
}

function loadPluginAccounts(): Record<string, { id: string; name: string }> {
  if (!existsSync(PLUGIN_ACCOUNTS_PATH)) return {};
  try {
    return JSON.parse(readFileSync(PLUGIN_ACCOUNTS_PATH, "utf-8"));
  } catch {
    return {};
  }
}

function savePluginAccount(
  pluginName: string,
  accountId: string,
  accountName: string,
): void {
  ensureDataDir();
  const mapping = loadPluginAccounts();
  mapping[pluginName] = { id: accountId, name: accountName };
  writeFileSync(PLUGIN_ACCOUNTS_PATH, JSON.stringify(mapping, null, 2), { mode: 0o600 });
}

function getDeviceUuid(): string {
  ensureDataDir();
  const uuidPath = join(DATA_DIR, "device_uuid");
  if (existsSync(uuidPath)) return readFileSync(uuidPath, "utf-8").trim();
  const uuid = randomUUID();
  writeFileSync(uuidPath, uuid, { mode: 0o600 });
  return uuid;
}

function getSessionToken(): string | null {
  const tokenPath = join(DATA_DIR, "session_token");
  if (existsSync(tokenPath)) return readFileSync(tokenPath, "utf-8").trim();
  return null;
}

function saveSessionToken(token: string): void {
  ensureDataDir();
  writeFileSync(join(DATA_DIR, "session_token"), token, { mode: 0o600 });
}

function baseHeaders(): Record<string, string> {
  return {
    Accept: "application/json",
    "Content-Type": "application/json",
    "Client-Platform": "web",
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "device-uuid": getDeviceUuid(),
    Origin: MONARCH_ORIGIN,
  };
}

// ── Auth ──────────────────────────────────────────────────────────────

interface LoginResult {
  token?: string;
  mfaRequired?: boolean;
  errorCode?: string;
  detail?: string;
}

async function monarchLogin(
  email: string,
  password: string,
  opts?: { emailOtp?: string; totp?: string },
): Promise<LoginResult> {
  const body: Record<string, unknown> = {
    username: email,
    password,
    supports_mfa: true,
    supports_email_otp: true,
    trusted_device: true,
  };
  if (opts?.emailOtp) body.email_otp = opts.emailOtp;
  if (opts?.totp) body.totp = opts.totp;

  const resp = await fetch(`${MONARCH_API}/auth/login/`, {
    method: "POST",
    headers: baseHeaders(),
    body: JSON.stringify(body),
  });

  if (resp.status === 403) {
    const text = await resp.text();
    try {
      const data = JSON.parse(text);
      return {
        mfaRequired: true,
        errorCode: data.error_code,
        detail: data.detail,
      };
    } catch {
      return { mfaRequired: true, detail: text.slice(0, 200) };
    }
  }

  if (resp.status === 429) {
    const text = await resp.text();
    let msg = "Rate limited by Monarch (429). Wait a few minutes.";
    try {
      const data = JSON.parse(text);
      msg = `Rate limited (${data.error_code || "429"}). Wait a few minutes and try again.`;
    } catch {}
    throw new Error(msg);
  }

  if (!resp.ok) {
    throw new Error(`Login failed (HTTP ${resp.status}). Check your credentials and try again.`);
  }

  const data = await resp.json();
  if (data.token) return { token: data.token };
  throw new Error("Login succeeded but no token in response");
}

async function validateToken(token: string): Promise<boolean> {
  try {
    const resp = await fetch(`${MONARCH_API}/graphql`, {
      method: "POST",
      headers: {
        ...baseHeaders(),
        Authorization: `Token ${token}`,
      },
      body: JSON.stringify({ query: "query { me { id } }" }),
    });
    return resp.ok;
  } catch {
    return false;
  }
}

// ── GraphQL ───────────────────────────────────────────────────────────

async function gql<T = any>(
  token: string,
  query: string,
  variables?: Record<string, unknown>,
): Promise<T> {
  const resp = await fetch(`${MONARCH_API}/graphql`, {
    method: "POST",
    headers: {
      ...baseHeaders(),
      Authorization: `Token ${token}`,
    },
    body: JSON.stringify({
      query,
      variables: variables ?? {},
    }),
  });

  const json = await resp.json();

  if (!resp.ok || json.errors?.length) {
    const errMsg = json.errors?.[0]?.message ?? `HTTP ${resp.status}`;
    throw new Error(`Monarch API error: ${errMsg}`);
  }
  return json.data;
}

// ── Queries ───────────────────────────────────────────────────────────

const GET_ACCOUNTS = `
  query GetAccounts {
    accounts {
      id
      displayName
      type { display }
      currentBalance
    }
  }
`;

const GET_TRANSACTIONS = `
  query GetTransactions($offset: Int, $limit: Int, $filters: TransactionFilterInput) {
    allTransactions(filters: $filters) {
      results(offset: $offset, limit: $limit) {
        id
        date
        amount
        merchant { name }
        category { id name }
      }
    }
  }
`;

const GET_CATEGORIES = `
  query GetCategories {
    categories {
      id
      name
    }
  }
`;

const CREATE_TRANSACTION = `
  mutation Common_CreateTransactionMutation($input: CreateTransactionMutationInput!) {
    createTransaction(input: $input) {
      transaction { id }
      errors {
        ...PayloadErrorFields
        __typename
      }
      __typename
    }
  }

  fragment PayloadErrorFields on PayloadError {
    fieldErrors {
      field
      messages
      __typename
    }
    message
    code
    __typename
  }
`;

const UPDATE_TRANSACTION = `
  mutation Common_UpdateTransactionMutation($input: UpdateTransactionMutationInput!) {
    updateTransaction(input: $input) {
      transaction { id }
      errors {
        ...PayloadErrorFields
        __typename
      }
      __typename
    }
  }

  fragment PayloadErrorFields on PayloadError {
    fieldErrors {
      field
      messages
      __typename
    }
    message
    code
    __typename
  }
`;

/**
 * Look up a category for a merchant name, trying:
 * 1. Exact match
 * 2. One name contains the other (e.g. "WHOLE FOODS" matches "WHOLE FOODS MARKET #10234")
 * 3. Shared word tokens (at least 2 non-trivial words in common)
 */
function findCategoryForMerchant(
  merchant: string,
  merchantCategoryMap: Map<string, string>,
): string | null {
  const key = merchant.toLowerCase().trim();

  // 1. Exact match
  if (merchantCategoryMap.has(key)) return merchantCategoryMap.get(key)!;

  // 2. Substring match — one contains the other
  for (const [known, catId] of merchantCategoryMap) {
    if (key.includes(known) || known.includes(key)) return catId;
  }

  // 3. Token overlap — at least 2 meaningful words in common
  const STOP_WORDS = new Set([
    "the", "and", "of", "in", "at", "to", "for", "a", "an", "pos", "sq",
    "inc", "llc", "ltd", "co", "corp", "usa", "us",
  ]);
  const keyTokens = key.split(/\s+/).filter((w) => w.length > 2 && !STOP_WORDS.has(w));
  if (keyTokens.length < 2) return null;

  let bestMatch: string | null = null;
  let bestOverlap = 0;
  for (const [known, catId] of merchantCategoryMap) {
    const knownTokens = new Set(
      known.split(/\s+/).filter((w) => w.length > 2 && !STOP_WORDS.has(w)),
    );
    const overlap = keyTokens.filter((t) => knownTokens.has(t)).length;
    if (overlap >= 2 && overlap > bestOverlap) {
      bestOverlap = overlap;
      bestMatch = catId;
    }
  }
  return bestMatch;
}

// ── Client ────────────────────────────────────────────────────────────

export interface PushEvent {
  type: "skip" | "create";
  transaction: Transaction;
  categoryName?: string;
}

export class MonarchClient {
  private token = "";
  private authenticated = false;
  private uncategorizedId: string | null = null;
  private categoryNames = new Map<string, string>();

  async login(
    email: string,
    password: string,
    options?: { mfaSecret?: string; mfaCode?: string },
  ): Promise<void> {
    // Try existing session first
    const existingToken = getSessionToken();
    if (existingToken) {
      const valid = await validateToken(existingToken);
      if (valid) {
        this.token = existingToken;
        this.authenticated = true;
        return;
      }
    }

    let result: LoginResult;

    if (options?.mfaCode) {
      result = await monarchLogin(email, password, {
        emailOtp: options.mfaCode,
      });
      if (result.mfaRequired) {
        throw new Error(
          `Verification code rejected (${result.errorCode || "unknown"}). ` +
            `${result.detail || "Check the code and try again."}`,
        );
      }
    } else if (options?.mfaSecret) {
      result = await monarchLogin(email, password, {
        totp: options.mfaSecret,
      });
      if (result.mfaRequired) {
        throw new Error(
          `TOTP rejected (${result.errorCode || "unknown"}). Check your MFA secret.`,
        );
      }
    } else {
      result = await monarchLogin(email, password);
      if (result.mfaRequired) {
        const err = new Error("MFA_REQUIRED");
        (err as any).code = "MFA_REQUIRED";
        throw err;
      }
    }

    if (!result.token) throw new Error("Login failed — no token received");

    saveSessionToken(result.token);
    this.token = result.token;
    this.authenticated = true;
  }

  private requireAuth(): void {
    if (!this.authenticated) {
      throw new Error("Not authenticated. Call login() first.");
    }
  }

  private async getUncategorizedCategoryId(): Promise<string> {
    if (this.uncategorizedId) return this.uncategorizedId;
    const data = await gql<{ categories: { id: string; name: string }[] }>(
      this.token,
      GET_CATEGORIES,
    );
    for (const c of data.categories) {
      this.categoryNames.set(c.id, c.name);
    }
    const uncat = data.categories.find(
      (c) => c.name.toLowerCase() === "uncategorized",
    );
    if (!uncat) {
      throw new Error(
        "Could not find 'Uncategorized' category. Available: " +
          data.categories.map((c) => c.name).join(", "),
      );
    }
    this.uncategorizedId = uncat.id;
    return uncat.id;
  }

  async getAccountIdByName(accountName: string): Promise<string | null> {
    this.requireAuth();
    const data = await gql<{ accounts: any[] }>(this.token, GET_ACCOUNTS);
    for (const a of data.accounts) {
      if (
        (a.displayName ?? "").toLowerCase() === accountName.toLowerCase()
      ) {
        return a.id;
      }
    }
    return null;
  }

  async getExistingTransactions(
    accountId: string,
    startDate?: string,
    endDate?: string,
  ): Promise<{
    dedupCounts: Map<string, number>;
    merchantCategoryMap: Map<string, string>;
  }> {
    this.requireAuth();

    const filters: Record<string, unknown> = {
      accounts: [accountId],
    };
    if (startDate) filters.startDate = startDate;
    if (endDate) filters.endDate = endDate;

    const data = await gql(this.token, GET_TRANSACTIONS, {
      filters,
      offset: 0,
      limit: 10000,
    });
    const txs = data?.allTransactions?.results ?? [];

    const dedupCounts = new Map<string, number>();
    const merchantCategoryMap = new Map<string, string>();
    for (const tx of txs) {
      const date = tx.date ?? "";
      const amount = tx.amount ?? 0;
      const merchant = (tx.merchant?.name ?? "").toLowerCase().trim();
      const key = `${date}|${amount}|${merchant}`;
      dedupCounts.set(key, (dedupCounts.get(key) ?? 0) + 1);

      const catId = tx.category?.id;
      const catName = (tx.category?.name ?? "").toLowerCase();
      if (catId && merchant && catName !== "uncategorized") {
        merchantCategoryMap.set(merchant, catId);
      }
    }
    return { dedupCounts, merchantCategoryMap };
  }

  /** Build a global merchant→category map from ALL user transactions. */
  private async getMerchantCategoryMap(): Promise<Map<string, string>> {
    const data = await gql(this.token, GET_TRANSACTIONS, {
      filters: {},
      offset: 0,
      limit: 10000,
    });
    const txs = data?.allTransactions?.results ?? [];

    const map = new Map<string, string>();
    for (const tx of txs) {
      const merchant = (tx.merchant?.name ?? "").toLowerCase().trim();
      const catId = tx.category?.id;
      const catName = (tx.category?.name ?? "").toLowerCase();
      if (catId && merchant && catName !== "uncategorized") {
        map.set(merchant, catId);
      }
    }
    return map;
  }

  async pushTransactions(
    transactions: Transaction[],
    accountId: string,
    skipDuplicates = true,
    onEvent?: (event: PushEvent, counts: { created: number; skipped: number; total: number }) => void,
  ): Promise<{ created: number; skipped: number; categorized: number }> {
    this.requireAuth();

    // Build merchant→category map from all user transactions
    const merchantCategories = await this.getMerchantCategoryMap();
    const fallbackCategoryId = await this.getUncategorizedCategoryId();

    let toCreate = transactions;
    let skipped = 0;
    const skippedTxs: Transaction[] = [];

    if (skipDuplicates && transactions.length > 0) {
      const dates = transactions.map((tx) => tx.date);
      const { dedupCounts } = await this.getExistingTransactions(
        accountId,
        dates.reduce((a, b) => (a < b ? a : b)),
        dates.reduce((a, b) => (a > b ? a : b)),
      );
      const toCreateSet = new Set(deduplicate(transactions, dedupCounts));
      for (const tx of transactions) {
        if (!toCreateSet.has(tx)) {
          skippedTxs.push(tx);
          skipped++;
          onEvent?.(
            { type: "skip", transaction: tx },
            { created: 0, skipped, total: transactions.length },
          );
        }
      }
      toCreate = [...toCreateSet];
    }

    let created = 0;
    let categorized = 0;
    for (const tx of toCreate) {
      const categoryId =
        findCategoryForMerchant(tx.merchant, merchantCategories) ?? fallbackCategoryId;
      const categoryName = this.categoryNames.get(categoryId) ?? "Uncategorized";
      if (categoryId !== fallbackCategoryId) categorized++;

      await gql(this.token, CREATE_TRANSACTION, {
        input: {
          accountId,
          date: tx.date,
          amount: signedAmount(tx),
          merchantName: tx.merchant,
          categoryId,
          notes: tx.notes ?? "",
          shouldUpdateBalance: true,
        },
      });
      created++;
      onEvent?.(
        { type: "create", transaction: tx, categoryName },
        { created, skipped, total: toCreate.length },
      );
    }
    return { created, skipped, categorized };
  }

  async listAccounts(): Promise<
    Array<{ id: string; name: string; type: string; balance: number }>
  > {
    this.requireAuth();
    const data = await gql<{ accounts: any[] }>(this.token, GET_ACCOUNTS);
    return data.accounts.map((a: any) => ({
      id: a.id,
      name: a.displayName ?? "Unknown",
      type: a.type?.display ?? "Unknown",
      balance: a.currentBalance ?? 0,
    }));
  }

  async recategorize(
    accountId: string,
    onProgress?: (updated: number, total: number) => void,
  ): Promise<{ updated: number; total: number }> {
    this.requireAuth();

    // Fetch uncategorized transactions in the target account
    const uncatId = await this.getUncategorizedCategoryId();
    const data = await gql(this.token, GET_TRANSACTIONS, {
      filters: { accounts: [accountId], categories: [uncatId] },
      offset: 0,
      limit: 10000,
    });
    const uncatTxs = data?.allTransactions?.results ?? [];
    if (!uncatTxs.length) return { updated: 0, total: 0 };

    // Build merchant→category map from ALL user transactions
    const merchantCategories = await this.getMerchantCategoryMap();

    let updated = 0;
    for (const tx of uncatTxs) {
      const merchant = tx.merchant?.name ?? "";
      const categoryId = findCategoryForMerchant(merchant, merchantCategories);
      if (!categoryId) continue;

      await gql(this.token, UPDATE_TRANSACTION, {
        input: { id: tx.id, category: categoryId },
      });
      updated++;
      onProgress?.(updated, uncatTxs.length);
    }

    return { updated, total: uncatTxs.length };
  }

  getSavedAccount(pluginName: string): { id: string; name: string } | null {
    return loadPluginAccounts()[pluginName] ?? null;
  }

  saveAccount(pluginName: string, accountId: string, accountName: string): void {
    savePluginAccount(pluginName, accountId, accountName);
  }
}
