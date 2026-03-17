import { describe, it, expect } from "vitest";
import {
  TransactionType,
  signedAmount,
  dedupKey,
  type Transaction,
} from "../src/schema.js";

function makeTx(overrides: Partial<Transaction> = {}): Transaction {
  return {
    date: "2025-01-15",
    amount: 58.12,
    txType: TransactionType.DEBIT,
    merchant: "Amazon",
    sourcePlugin: "test",
    ...overrides,
  };
}

describe("signedAmount", () => {
  it("returns negative for debits", () => {
    expect(signedAmount(makeTx())).toBe(-58.12);
  });

  it("returns positive for credits", () => {
    expect(
      signedAmount(makeTx({ txType: TransactionType.CREDIT, amount: 100 })),
    ).toBe(100);
  });
});

describe("dedupKey", () => {
  it("builds correct key", () => {
    const tx = makeTx({ merchant: "  Amazon  " });
    expect(dedupKey(tx)).toBe("2025-01-15|-58.12|amazon");
  });

  it("produces same key for equivalent transactions", () => {
    const tx1 = makeTx({
      date: "2025-03-01",
      amount: 25,
      merchant: "Starbucks",
      sourcePlugin: "plugin_a",
    });
    const tx2 = makeTx({
      date: "2025-03-01",
      amount: 25,
      merchant: "Starbucks",
      sourcePlugin: "plugin_b",
    });
    expect(dedupKey(tx1)).toBe(dedupKey(tx2));
  });
});
