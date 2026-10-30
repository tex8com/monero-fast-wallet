export type PushTestReceipt = {
  accepted: true;
  eventId: string;
  scheduledAt: number;
  deliverAfter: number;
};
export type PushTestStatus = {
  available: boolean;
  reason: string;
  phase: 'idle' | 'scheduled' | 'received' | 'not-received';
  receipt?: PushTestReceipt | null;
  receivedAt?: number | null;
  permissionSettingsAvailable?: boolean;
  platform?: 'macos' | 'windows' | 'linux' | 'unknown';
};

export function validPushTestReceipt(value: unknown): value is PushTestReceipt {
  if (!value || typeof value !== 'object') return false;
  const receipt = value as Record<string, unknown>;
  return Object.keys(receipt).length === 4 && receipt.accepted === true
    && typeof receipt.eventId === 'string' && /^evt_[0-9a-f]{64}$/.test(receipt.eventId)
    && Number.isSafeInteger(receipt.scheduledAt) && Number(receipt.scheduledAt) > 0
    && Number.isSafeInteger(receipt.deliverAfter)
    && Number(receipt.deliverAfter) === Number(receipt.scheduledAt) + 10;
}

/** Provider acceptance and other notifications are never a receipt. */
export function receivedPushTest(status: PushTestStatus): boolean {
  return status.phase === 'received' && validPushTestReceipt(status.receipt)
    && Number.isSafeInteger(status.receivedAt) && Number(status.receivedAt) > 0;
}

export function pushTestCanStart(status: PushTestStatus | null, requesting: boolean): boolean {
  if (requesting || !status || status.phase === 'scheduled' || status.permissionSettingsAvailable === true) return false;
  // The native request can resume an existing provider installation before
  // scheduling. Missing owner permissions, wallet or alerts remain blocked.
  return (status.available === true && status.reason === 'ready')
    || status.reason === 'provider-required' || status.reason === 'gateway-required';
}
