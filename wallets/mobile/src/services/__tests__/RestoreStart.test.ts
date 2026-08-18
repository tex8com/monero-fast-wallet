import {
  parseRestoreStartDate,
  restoreHeightFromStartDate,
} from "../RestoreStart";

describe("restore start date", () => {
  it("keeps automatic scanning when no date is selected", () => {
    expect(restoreHeightFromStartDate("", "mainnet")).toBeUndefined();
  });

  it("converts a valid mainnet date to a safe earlier Monero height", () => {
    // The v2-fork formula yields 3,024,508 for this day; the app keeps a
    // two-day margin (1,440 blocks) before handing it to Monero core.
    expect(restoreHeightFromStartDate("2024-01-01", "mainnet")).toBe(
      3_023_068,
    );
  });

  it("uses the same safe January 2026 height that the desktop dashboard treats as zero progress", () => {
    expect(restoreHeightFromStartDate("2026-01-01", "mainnet")).toBe(
      3_549_388,
    );
  });

  it("rejects invalid calendar dates", () => {
    expect(() => parseRestoreStartDate("2024-02-30")).toThrow(
      "Enter a valid date.",
    );
  });
});
