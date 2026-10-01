import {
  atomicXmrToNumber,
  formatAtomicXmr,
  normalizedTransactionAmountAtomic,
  parseXmrToAtomic,
  subtractAtomic,
} from "../WalletFormat";

describe("WalletFormat", () => {
  it("formats atomic values as XMR without losing integer precision", () => {
    expect(formatAtomicXmr("4852100000000")).toBe("4.8521");
    expect(formatAtomicXmr("1000000000000")).toBe("1");
    expect(formatAtomicXmr("1", { maxFractionDigits: 12 })).toBe(
      "0.000000000001",
    );
  });

  it("supports minimum fraction digits for balance display", () => {
    expect(
      formatAtomicXmr("0", {
        maxFractionDigits: 4,
        minFractionDigits: 2,
      }),
    ).toBe("0.00");
  });

  it("parses XMR decimal strings into atomic units", () => {
    expect(parseXmrToAtomic("1")).toBe(1_000_000_000_000n);
    expect(parseXmrToAtomic("0.000000000001")).toBe(1n);
    expect(parseXmrToAtomic("1.2345678901234")).toBeUndefined();
  });

  it("subtracts atomic values", () => {
    expect(subtractAtomic("1200", "199")).toBe(1001n);
  });

  it("converts atomic values to numbers for fiat estimates", () => {
    expect(atomicXmrToNumber("1500000000000")).toBe(1.5);
  });

  it("repairs an unsigned Ledger history underflow from its recipient total", () => {
    expect(
      normalizedTransactionAmountAtomic({
        amountAtomic: "18446743927874251388",
        direction: "out",
        transfers: [{ amountAtomic: "1" }],
      }),
    ).toBe("1");
  });

  it("keeps normal and fee-only transaction amounts unchanged", () => {
    expect(
      normalizedTransactionAmountAtomic({
        amountAtomic: "3000000000",
        direction: "out",
        transfers: [{ amountAtomic: "3000000000" }],
      }),
    ).toBe("3000000000");
    expect(
      normalizedTransactionAmountAtomic({
        amountAtomic: "0",
        direction: "out",
        transfers: [{ amountAtomic: "2000000000" }],
      }),
    ).toBe("0");
  });
});
