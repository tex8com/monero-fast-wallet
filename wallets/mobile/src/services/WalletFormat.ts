export const ATOMIC_UNITS_PER_XMR = 1_000_000_000_000n;

export interface FormatXmrOptions {
  maxFractionDigits?: number;
  minFractionDigits?: number;
  trimTrailingZeros?: boolean;
}

interface TransactionAmountSource {
  amountAtomic: string;
  direction: string;
  transfers: ReadonlyArray<{ amountAtomic: string }>;
}

export function normalizedTransactionAmountAtomic(
  transaction: TransactionAmountSource,
): string {
  if (transaction.direction !== "out" || transaction.transfers.length === 0) {
    return transaction.amountAtomic;
  }

  try {
    const reported = BigInt(transaction.amountAtomic);
    const transferTotal = transaction.transfers.reduce(
      (total, transfer) => total + BigInt(transfer.amountAtomic),
      0n,
    );
    return reported > transferTotal
      ? transferTotal.toString()
      : transaction.amountAtomic;
  } catch {
    return transaction.amountAtomic;
  }
}

export function formatAtomicXmr(
  atomicValue: bigint | number | string | undefined,
  options: FormatXmrOptions = {},
): string {
  const {
    maxFractionDigits = 4,
    minFractionDigits = 0,
    trimTrailingZeros = true,
  } = options;
  const atomic = toAtomicBigInt(atomicValue);
  const negative = atomic < 0n;
  const absolute = negative ? -atomic : atomic;
  const whole = absolute / ATOMIC_UNITS_PER_XMR;
  const fraction = absolute % ATOMIC_UNITS_PER_XMR;
  const digits = clampFractionDigits(maxFractionDigits);
  const minDigits = Math.min(clampFractionDigits(minFractionDigits), digits);

  let fractionText = fraction.toString().padStart(12, "0").slice(0, digits);
  if (trimTrailingZeros) {
    fractionText = fractionText.replace(/0+$/, "");
  }

  while (fractionText.length < minDigits) {
    fractionText += "0";
  }

  const sign = negative ? "-" : "";
  return fractionText.length > 0
    ? `${sign}${whole.toString()}.${fractionText}`
    : `${sign}${whole.toString()}`;
}

export function atomicXmrToNumber(
  atomicValue: bigint | number | string | undefined,
): number {
  const atomic = toAtomicBigInt(atomicValue);
  const negative = atomic < 0n;
  const absolute = negative ? -atomic : atomic;
  const whole = absolute / ATOMIC_UNITS_PER_XMR;
  const fraction = absolute % ATOMIC_UNITS_PER_XMR;
  const value = Number(whole) + Number(fraction) / Number(ATOMIC_UNITS_PER_XMR);
  return negative ? -value : value;
}

export function parseXmrToAtomic(value: string): bigint | undefined {
  const normalized = value.trim().replace(",", ".");
  if (!/^\d+(\.\d{0,12})?$/.test(normalized)) {
    return undefined;
  }

  const [wholeText, fractionText = ""] = normalized.split(".");
  const whole = BigInt(wholeText || "0") * ATOMIC_UNITS_PER_XMR;
  const fraction = BigInt(fractionText.padEnd(12, "0") || "0");
  return whole + fraction;
}

export function subtractAtomic(
  left: bigint | number | string | undefined,
  right: bigint | number | string | undefined,
): bigint {
  return toAtomicBigInt(left) - toAtomicBigInt(right);
}

export function toAtomicBigInt(
  value: bigint | number | string | undefined,
): bigint {
  if (typeof value === "bigint") {
    return value;
  }

  if (typeof value === "number") {
    return BigInt(Math.trunc(value));
  }

  if (typeof value === "string" && value.trim().length > 0) {
    return BigInt(value);
  }

  return 0n;
}

function clampFractionDigits(value: number): number {
  if (!Number.isFinite(value)) {
    return 4;
  }

  return Math.max(0, Math.min(12, Math.trunc(value)));
}
