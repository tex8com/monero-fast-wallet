import {
  atomicXmrToNumber,
  formatAtomicXmr,
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
});
