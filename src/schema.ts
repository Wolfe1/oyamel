/** Common transaction schema shared across all plugins. */

export enum TransactionType {
  DEBIT = "debit",
  CREDIT = "credit",
}

export interface Transaction {
  date: string; // ISO date string "YYYY-MM-DD"
  amount: number; // Positive value. Sign is determined by txType.
  txType: TransactionType;
  merchant: string;
  category?: string;
  notes?: string;
  sourcePlugin: string;
  sourceId?: string;
}

/** Return negative for debits, positive for credits. */
export function signedAmount(tx: Transaction): number {
  return tx.txType === TransactionType.DEBIT ? -Math.abs(tx.amount) : Math.abs(tx.amount);
}

/** Key used for deduplication when sourceId is not available. */
export function dedupKey(tx: Transaction): string {
  return `${tx.date}|${signedAmount(tx)}|${tx.merchant.toLowerCase().trim()}`;
}
