/** Public status only. The native adapter verifies the Worker's fresh proof. */
export type FastWalletHostingStatus =
  | 'hosted'
  | 'rehosted'
  | 'missing'
  | 'unknown'
  | 'blocked'
  | 'unsupported';

export interface FastWalletHostingView {
  status: FastWalletHostingStatus;
  /** Unix seconds from a verified Worker proof, never a local admission receipt. */
  checkedAt?: number;
  attemptedAt: number;
  verified: boolean;
  repairAttempted: boolean;
  /** Stable, nonsecret code; no free-form server response is persisted. */
  errorCode?: string;
  /** Public routing identity checked by native code; mandatory for verified results. */
  assignmentHandle?: string;
  assignmentEpoch?: number;
  workerRootId?: string;
}

const statuses = new Set<FastWalletHostingStatus>([
  'hosted', 'rehosted', 'missing', 'unknown', 'blocked', 'unsupported',
]);

export function parseFastWalletHostingView(value: unknown, now = Math.floor(Date.now() / 1000)): FastWalletHostingView | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const input = value as Record<string, unknown>;
  if (!statuses.has(input.status as FastWalletHostingStatus)
    || !positiveInteger(input.attemptedAt)) return undefined;
  const verified = input.verified === true && positiveInteger(input.checkedAt)
    && input.checkedAt >= (input.attemptedAt as number) - 5 && input.checkedAt <= now + 5
    && canonicalId(input.assignmentHandle) && positiveInteger(input.assignmentEpoch) && canonicalId(input.workerRootId);
  const positive = input.status === 'hosted' || input.status === 'rehosted';
  const nativeAbsence = input.errorCode === 'no_assignment' || input.errorCode === 'assignment_expired'
    || input.errorCode === 'assignment_revoked';
  if ((positive && (!verified || (input.status === 'rehosted' && input.repairAttempted !== true)))
    || (input.status === 'missing' && !verified && !nativeAbsence)) {
    return {
      status: 'unknown', attemptedAt: input.attemptedAt as number,
      verified: false, repairAttempted: input.repairAttempted === true,
      errorCode: 'invalid_proof',
    };
  }
  return {
    status: input.status as FastWalletHostingStatus,
    attemptedAt: input.attemptedAt as number,
    checkedAt: verified ? input.checkedAt as number : undefined,
    verified,
    repairAttempted: input.repairAttempted === true,
    errorCode: typeof input.errorCode === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(input.errorCode)
      ? input.errorCode : undefined,
    assignmentHandle: verified ? input.assignmentHandle as string : undefined,
    assignmentEpoch: verified ? input.assignmentEpoch as number : undefined,
    workerRootId: verified ? input.workerRootId as string : undefined,
  };
}

/** Native live responses are short-lived; old persisted results stay visibly dated. */
export function freshFastWalletHostingView(value: unknown, now: number): FastWalletHostingView {
  const parsed = parseFastWalletHostingView(value, now);
  if (!parsed || (parsed.verified && (
    parsed.checkedAt! > now + 5 || now - parsed.checkedAt! > 60
  ))) {
    return {
      status: 'unknown', attemptedAt: now, verified: false,
      repairAttempted: false, errorCode: 'invalid_proof',
    };
  }
  return parsed;
}

export function fastWalletHostingNeedsRepair(view: FastWalletHostingView): boolean {
  return view.status === 'missing' && (
    view.verified || view.errorCode === 'no_assignment'
      || view.errorCode === 'assignment_expired' || view.errorCode === 'assignment_revoked'
  );
}

export function fastWalletHostingErrorTranslationKey(errorCode?: string) {
  switch (errorCode) {
    case 'no_assignment': case 'assignment_expired': case 'assignment_revoked':
      return 'wallets.hostingMissing';
    case 'notification_permission_required': case 'permission_required':
      return 'wallets.hostingPermissionRequired';
    case 'notification_service_error':
      return 'wallets.hostingNotificationServiceError';
    case 'backup_required': return 'wallets.hostingBackupRequired';
    case 'authorization_required': case 'authentication_failed':
      return 'wallets.hostingAuthorizationRequired';
    case 'invalid_proof': return 'wallets.hostingInvalidProof';
    case 'unsupported_worker': case 'unsupported_wallet':
      return 'wallets.hostingUnsupported';
    case 'missing_after_repair': return 'wallets.hostingMissingAfterRepair';
    case 'repair_failed': return 'wallets.hostingRepairFailed';
    default: return 'wallets.hostingUnavailable';
  }
}

function positiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function canonicalId(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}
