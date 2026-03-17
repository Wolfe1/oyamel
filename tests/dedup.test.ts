import { describe, it, expect } from "vitest";
import { deduplicate } from "../src/ingestion/dedup.js";
import { TransactionType, dedupKey, type Transaction } from "../src/schema.js";

function makeTx(overrides: Partial<Transaction> = {}): Transaction {
  return {
    date: "2025-01-01",
    amount: 10,
    txType: TransactionType.DEBIT,
    merchant: "TestMerchant",
    sourcePlugin: "test",
    ...overrides,
  };
}

function countsFrom(txs: Transaction[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const tx of txs) {
    const key = tx.sourceId ?? dedupKey(tx);
    m.set(key, (m.get(key) ?? 0) + 1);
  }
  return m;
}

describe("deduplicate", () => {
  it("keeps all items when no existing transactions", () => {
    const txs = [
      makeTx({ date: "2025-01-01" }),
      makeTx({ date: "2025-01-02" }),
      makeTx({ date: "2025-01-03" }),
    ];
    expect(deduplicate(txs)).toHaveLength(3);
  });

  it("keeps identical transactions within batch (they are legitimate)", () => {
    // e.g., 3x $100 at the same restaurant on the same day
    const txs = [
      makeTx({ date: "2025-01-01" }),
      makeTx({ date: "2025-01-01" }),
    ];
    expect(deduplicate(txs)).toHaveLength(2);
  });

  it("removes duplicates against existing counts", () => {
    const tx = makeTx({ date: "2025-01-01" });
    const existing = countsFrom([tx]);
    expect(deduplicate([tx], existing)).toHaveLength(0);
  });

  it("keeps non-duplicates against existing counts", () => {
    const tx1 = makeTx({ date: "2025-01-01" });
    const tx2 = makeTx({ date: "2025-01-02" });
    const existing = countsFrom([tx1]);
    const result = deduplicate([tx1, tx2], existing);
    expect(result).toHaveLength(1);
    expect(result[0].date).toBe("2025-01-02");
  });

  it("allows multiple identical transactions when count exceeds existing", () => {
    // 3 identical incoming, 1 already exists → 2 should be created
    const tx = makeTx({ date: "2025-12-20", amount: 100, merchant: "Restaurant" });
    const incoming = [tx, { ...tx }, { ...tx }];
    const existing = countsFrom([tx]); // 1 exists
    const result = deduplicate(incoming, existing);
    expect(result).toHaveLength(2);
  });

  it("skips all when existing count matches incoming count", () => {
    const tx = makeTx({ date: "2025-12-20", amount: 100, merchant: "Restaurant" });
    const incoming = [tx, { ...tx }, { ...tx }];
    const existing = countsFrom([tx, { ...tx }, { ...tx }]); // 3 exist
    const result = deduplicate(incoming, existing);
    expect(result).toHaveLength(0);
  });

  it("uses sourceId when available for existing match", () => {
    const tx1 = makeTx({ date: "2025-01-01", sourceId: "abc123" });
    const tx2 = makeTx({ date: "2025-01-01", sourceId: "def456" });
    const existing = countsFrom([tx1]);
    const result = deduplicate([tx1, tx2], existing);
    expect(result).toHaveLength(1);
    expect(result[0].sourceId).toBe("def456");
  });
});
