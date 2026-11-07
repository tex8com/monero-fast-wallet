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

/** Preserve the actionable failure category without storing native/server text. */
export function fastWalletHostingFailure(error: unknown): {
  status: 'blocked' | 'unknown' | 'unsupported'; errorCode: string;
} {
  const record = error && typeof error === 'object' ? error as Record<string, unknown> : undefined;
  const nativeCode = typeof record?.errorCode === 'string' ? record.errorCode
    : typeof record?.code === 'string' ? record.code : '';
  const message = error instanceof Error ? error.message
    : typeof error === 'string' ? error
    : typeof record?.message === 'string' ? record.message : '';
  const context = `${nativeCode} ${message}`.toLowerCase();

  // A native permission code is more precise than its explanatory message.
  if (/^(?:apns-authorization-denied|notification_permission_required|permission_required)$/i.test(nativeCode)) {
    return { status: 'blocked', errorCode: 'notification_permission_required' };
  }

  // Task Scheduler errors may mention an administrator password or access
  // permissions. Those describe helper startup, never wallet authorization.
  if (/notification[-_ ](?:agent|helper|task)[-_ ].*(?:failed|error|unavailable)|notification\s+(?:background\s+)?(?:helper\s+)?task|task scheduler/i.test(context)
    || /apns-authorization-error|apns-registration-(error|timeout|failed)|notification_service_error/.test(context)) {
    return { status: 'unknown', errorCode: 'notification_service_error' };
  }
  if (/notification.*(?:credential|secure storage)|gateway[_ -]credentials[_ -](?:missing|invalid)/.test(context)) {
    return { status: 'blocked', errorCode: 'gateway_credentials_missing' };
  }
  if (/apns-authorization-denied|notification_permission_required|permission_required|permission[-_ ]denied|allow notifications|not permitted/.test(context)) {
    return { status: 'blocked', errorCode: 'notification_permission_required' };
  }
  if (/backup_required|\bback up\b|\bbackup\b/.test(context)) {
    return { status: 'blocked', errorCode: 'backup_required' };
  }
  if (/authorization_required|authorization_cancelled|authentication_failed|credential_missing|app password|\b(?:app|wallet) is locked\b|\b(?:unlock|biometr|authentication|authorization|cancel)/.test(context)) {
    return { status: 'blocked', errorCode: 'authorization_required' };
  }
  if (/invalid[_ -]proof|proof_invalid|signature|\bproof\b/.test(context)) {
    return { status: 'unknown', errorCode: 'invalid_proof' };
  }
  if (/unsupported[_ -](?:worker|wallet)|legacy_wallet_unsupported|hosting_check_unsupported/.test(context)) {
    return { status: 'unsupported', errorCode: 'unsupported_worker' };
  }
  return { status: 'unknown', errorCode: 'hosting_check_failed' };
}

export function fastWalletHostingErrorTranslationKey(errorCode?: string) {
  switch (errorCode) {
    case 'assignment_state_missing': case 'assignment_owner_mismatch': case 'assignment_epoch_mismatch':
      return 'wallets.hostingAssignmentMissing';
    case 'no_assignment': case 'assignment_expired': case 'assignment_revoked':
      return 'wallets.hostingMissing';
    case 'notification_permission_required': case 'permission_required':
      return 'wallets.hostingPermissionRequired';
    case 'notification_service_error': case 'gateway_credentials_missing': case 'gateway_credentials_invalid':
      return 'wallets.hostingNotificationServiceError';
    case 'backup_required': return 'wallets.hostingBackupRequired';
    case 'authorization_required': case 'authentication_failed': case 'authorization_cancelled': case 'credential_missing':
      return 'wallets.hostingAuthorizationRequired';
    case 'invalid_proof': case 'proof_invalid': return 'wallets.hostingInvalidProof';
    case 'unsupported_worker': case 'unsupported_wallet': case 'legacy_wallet_unsupported': case 'hosting_check_unsupported':
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
