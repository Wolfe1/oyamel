/** Base plugin interface that all source plugins must implement. */

import type { Command } from "commander";
import type { Transaction } from "../schema.js";
import type { MonarchClient, PushEvent } from "../ingestion/client.js";

export interface PluginMetadata {
  /** Unique identifier, used as CLI subcommand name and config key. e.g. "coinbase-one" */
  id: string;
  /** Human-readable name. e.g. "Coinbase One Credit Card" */
  name: string;
  description: string;
}

/**
 * Shared helpers passed to plugins for CLI operations.
 * Keeps auth, account resolution, and display logic centralized.
 */
export interface CliHelpers {
  authenticateMonarch(): Promise<MonarchClient>;
  resolveAccount(
    client: MonarchClient,
    pluginId: string,
    accountOpt?: string,
  ): Promise<{ accountId: string; accountName: string }>;
  printTransactions(transactions: Transaction[]): void;
  confirm(question: string, defaultYes?: boolean): Promise<boolean>;
  pushAndReport(
    client: MonarchClient,
    transactions: Transaction[],
    accountId: string,
    accountName: string,
    opts: { dryRun?: boolean; debug?: boolean },
  ): Promise<void>;
}

export interface SourcePlugin {
  metadata(): PluginMetadata;

  /**
   * Register CLI subcommands under the given parent command.
   * The plugin defines its own arguments, options, and action handlers.
   */
  registerCommands(parent: Command, helpers: CliHelpers): void;

  /** Fetch or read raw data from the source. */
  acquire(config: Record<string, unknown>): Promise<Record<string, unknown>[]>;

  /** Convert raw source records into normalized Transactions. */
  transform(rawRecords: Record<string, unknown>[]): Transaction[];

  /** Convenience: acquire + transform in one call. */
  sync(config: Record<string, unknown>): Promise<Transaction[]>;
}
