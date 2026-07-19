/**
 * Safe restore-height estimation shared by the React Native and Tauri apps.
 * These constants mirror Monero core's wallet2 approximate-height logic.
 */
export type RestoreNetwork = 'mainnet' | 'testnet' | 'stagenet';

type NetworkTiming = {
  forkTimeSeconds: number;
  forkHeight: number;
  rolledBackBlocks: number;
};

const networkTiming: Record<RestoreNetwork, NetworkTiming> = {
  mainnet: { forkTimeSeconds: 1458748658, forkHeight: 1009827, rolledBackBlocks: 30000 },
  testnet: { forkTimeSeconds: 1448285909, forkHeight: 624634, rolledBackBlocks: 342100 },
  stagenet: { forkTimeSeconds: 1520937818, forkHeight: 32000, rolledBackBlocks: 60000 },
};

const blockSeconds = 120;
// Start two days early. This deliberately favours a small additional scan
// over ever missing a payment made on the selected day.
const safeEarlyBlocks = (2 * 24 * 60 * 60) / blockSeconds;

export function dateInputValue(value: Date): string {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function todayRestoreDate(): string {
  return dateInputValue(new Date());
}

export function parseRestoreStartDate(value: string): Date | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
  if (!match) throw new Error('Enter a valid date.');

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(year, month - 1, day, 12);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) throw new Error('Enter a valid date.');
  if (dateInputValue(date) > todayRestoreDate()) throw new Error('The start date cannot be in the future.');
  return date;
}

export function isRestoreStartDateValid(value: string): boolean {
  try {
    parseRestoreStartDate(value);
    return true;
  } catch {
    return false;
  }
}

export function restoreHeightFromStartDate(value: string, network: RestoreNetwork): number | undefined {
  const date = parseRestoreStartDate(value);
  if (!date) return undefined;
  const timing = networkTiming[network];
  const timestampSeconds = Math.floor(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate(), 12) / 1000);
  if (timestampSeconds <= timing.forkTimeSeconds) return 0;
  const estimatedHeight = timing.forkHeight + Math.floor((timestampSeconds - timing.forkTimeSeconds) / blockSeconds) - timing.rolledBackBlocks;
  return Math.max(0, estimatedHeight - safeEarlyBlocks);
}
