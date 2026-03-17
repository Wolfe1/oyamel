/** Deduplication logic for preventing duplicate transactions in Monarch. */

import { type Transaction, dedupKey } from "../schema.js";

/**
 * Filter out transactions that already exist, using count-based matching.
 *
 * If 3 incoming transactions share the same key and 1 already exists,
 * 1 is skipped and 2 are created. This correctly handles legitimate
 * duplicate transactions (e.g., multiple $100 charges at the same merchant
 * on the same day).
 */
export function deduplicate(
  incoming: Transaction[],
  existingCounts?: Map<string, number>,
): Transaction[] {
  // Track remaining existing counts (mutable copy)
  const remaining = new Map<string, number>(existingCounts ?? []);
  const unique: Transaction[] = [];

  for (const tx of incoming) {
    const key = tx.sourceId ?? dedupKey(tx);
    const count = remaining.get(key) ?? 0;
    if (count > 0) {
      remaining.set(key, count - 1);
    } else {
      unique.push(tx);
    }
  }

  return unique;
}
