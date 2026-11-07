export type BalanceUnlockState =
  | "unlocked" | "blocks" | "timestamp" | "mixed" | "pending" | "unknown";

export type BalanceAvailabilitySource = {
  balanceAtomic?: string;
  unlockedBalanceAtomic?: string;
  lockedBalanceAtomic?: string;
  unlockBlocksRemaining?: number;
  unlockTimeRemainingSeconds?: number;
  unlockState?: string;
};

export type BalanceAvailability = {
  availableAtomic?: string;
  lockedAtomic?: string;
  state: BalanceUnlockState;
  /** Full-release counts, never a history-derived or partial estimate. */
  blocksRemaining?: number;
  secondsRemaining?: number;
};

const MAX_ATOMIC = (1n << 64n) - 1n;

function atomic(value: string | undefined): bigint | undefined {
  if (typeof value !== "string" || value.length > 20 || !/^[0-9]+$/.test(value)) return undefined;
  const parsed = BigInt(value);
  return parsed <= MAX_ATOMIC ? parsed : undefined;
}

function count(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value : undefined;
}

/**
 * Financial amounts come from the complete native wallet balance, using exact
 * atomic subtraction. Unlock timing is accepted only from native Core's full
 * wallet contract; transaction history and the usual confirmation interval are
 * deliberately not inputs. Missing/contradictory timing remains unknown.
 */
export function presentBalanceAvailability(
  source: BalanceAvailabilitySource | null | undefined,
): BalanceAvailability {
  const total = atomic(source?.balanceAtomic);
  const available = atomic(source?.unlockedBalanceAtomic);
  if (total === undefined || available === undefined || available > total) {
    return {state: "unknown"};
  }
  const locked = total - available;
  const result: BalanceAvailability = {
    availableAtomic: available.toString(), lockedAtomic: locked.toString(), state: "unknown",
  };
  if (source?.lockedBalanceAtomic !== undefined && atomic(source.lockedBalanceAtomic) !== locked) {
    return result;
  }
  // Pending arrivals/change have no complete release height until mined.
  // A count for the confirmed portion cannot describe the whole balance.
  if (source?.unlockState === "pending") return {...result, state: "pending"};
  if (locked === 0n) {
    return source?.unlockState === undefined || source.unlockState === "unlocked"
      ? {...result, state: "unlocked"} : result;
  }
  const blocks = count(source?.unlockBlocksRemaining);
  const seconds = count(source?.unlockTimeRemainingSeconds);
  if (source?.unlockState === "blocks" && blocks !== undefined && blocks > 0 &&
      (seconds === undefined || seconds === 0)) {
    return {...result, state: "blocks", blocksRemaining: blocks};
  }
  if (source?.unlockState === "timestamp" && seconds !== undefined && seconds > 0 &&
      (blocks === undefined || blocks === 0)) {
    return {...result, state: "timestamp", secondsRemaining: seconds};
  }
  if (source?.unlockState === "mixed" && blocks !== undefined && blocks > 0 &&
      seconds !== undefined && seconds > 0) {
    return {...result, state: "mixed", blocksRemaining: blocks, secondsRemaining: seconds};
  }
  return result;
}
