import { Platform } from 'react-native';
import { requireNativeMoneroWallet } from './NativeMoneroWallet';

const DEFAULT_TIMEOUT_MS = 45_000;
const MAX_TIMEOUT_MS = 45_000;

type ActiveInterruption = {
  expiresAtMs: number;
  reason: string;
};

let nextInterruptionId = 1;
const activeInterruptions = new Map<number, ActiveInterruption>();
let lastSuccessfulCompletionAtMs: number | undefined;

function discardExpired(nowMs: number): void {
  for (const [id, interruption] of activeInterruptions) {
    if (interruption.expiresAtMs <= nowMs) {
      activeInterruptions.delete(id);
    }
  }
}

/**
 * Marks a short, app-initiated operating-system UI transition such as a
 * permission sheet. AppSecurity may defer its normal background lock only
 * while one of these bounded interactions is active.
 */
export function beginSystemUiInterruption(
  reason: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): () => void {
  const nowMs = Date.now();
  const boundedTimeoutMs = Math.min(
    MAX_TIMEOUT_MS,
    Math.max(1, timeoutMs),
  );
  discardExpired(nowMs);
  const id = nextInterruptionId++;
  activeInterruptions.set(id, {
    expiresAtMs: nowMs + boundedTimeoutMs,
    reason,
  });

  let ended = false;
  return () => {
    if (ended) {
      return;
    }
    ended = true;
    const interruption = activeInterruptions.get(id);
    const endedAtMs = Date.now();
    if (interruption && interruption.expiresAtMs > endedAtMs) {
      lastSuccessfulCompletionAtMs = endedAtMs;
    }
    activeInterruptions.delete(id);
  };
}

export async function withSystemUiInterruption<T>(
  reason: string,
  operation: () => Promise<T>,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<T> {
  const boundedTimeoutMs = Math.min(
    MAX_TIMEOUT_MS,
    Math.max(1, timeoutMs),
  );
  const end = beginSystemUiInterruption(reason, boundedTimeoutMs);
  let nativeToken: string | undefined;
  try {
    // The iOS native interruption map is not consulted by the native lock
    // lifecycle. Awaiting its TurboModule promise can therefore leave a
    // recovery-seed request waiting forever before its dialog is presented.
    // The JavaScript guard above already covers the iOS app lifecycle; keep
    // Android's native guard unchanged for its permission/activity flow.
    if (Platform.OS === 'ios') {
      return await operation();
    }
    nativeToken = await requireNativeMoneroWallet().beginSystemUiInterruption(
      reason,
      boundedTimeoutMs,
    );
    return await operation();
  } finally {
    end();
    if (nativeToken) {
      await requireNativeMoneroWallet().endSystemUiInterruption(nativeToken);
    }
  }
}

export function activeSystemUiInterruptionDeadlineMs(
  nowMs = Date.now(),
): number | undefined {
  discardExpired(nowMs);
  let latestDeadlineMs: number | undefined;
  for (const interruption of activeInterruptions.values()) {
    latestDeadlineMs = Math.max(
      latestDeadlineMs ?? interruption.expiresAtMs,
      interruption.expiresAtMs,
    );
  }
  return latestDeadlineMs;
}

/**
 * Covers the narrow Android/iOS ordering window where a permission promise
 * settles immediately before the activity emits its active/resumed event.
 * Expired guards never count as a trusted completion.
 */
export function recentlyCompletedSystemUiInterruption(
  nowMs = Date.now(),
  graceMs = 1_500,
): boolean {
  return (
    lastSuccessfulCompletionAtMs !== undefined &&
    nowMs - lastSuccessfulCompletionAtMs >= 0 &&
    nowMs - lastSuccessfulCompletionAtMs <= graceMs
  );
}

export function resetSystemUiInterruptionsForTests(): void {
  activeInterruptions.clear();
  nextInterruptionId = 1;
  lastSuccessfulCompletionAtMs = undefined;
}
