// Both clients measure the same observed bytes, never a cached batch duration.
export {
  updateNetworkSyncRateWindow as updateMobileNetworkSyncRateWindow,
  type NetworkSyncRateWindow as MobileNetworkSyncRateWindow,
} from '../../../../packages/wallet-shared/src/networkSync';

/** Never round a small positive, genuinely measured rate to a fake 0.00. */
export function formatMobileNetworkSyncRate(
  value: number,
  locale?: string,
): string {
  const safeValue = Number.isFinite(value) && value >= 0 ? value : 0;
  const fractionDigits =
    safeValue > 0 && safeValue < 0.001
      ? 4
      : safeValue > 0 && safeValue < 0.01
      ? 3
      : 2;
  return new Intl.NumberFormat(locale, {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  }).format(safeValue);
}
