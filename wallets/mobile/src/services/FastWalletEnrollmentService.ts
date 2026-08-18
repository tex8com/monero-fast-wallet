import type {
  FastWalletAssignment,
  MoneroNetwork,
  NativeMoneroWalletModule,
} from './NativeMoneroWallet';
import { logWalletEvent } from './WalletLogger';

const ASSIGNMENT_LIFETIME_SECONDS = 30 * 24 * 60 * 60;
const WATCH_ENVELOPE_LIFETIME_SECONDS = 10 * 60;
const MAX_SAFE_INTEGER = Number.MAX_SAFE_INTEGER;
const CANONICAL_HEX = /^[0-9a-f]+$/;

export interface EnrollFastWalletWatchInput {
  identityId: string;
  path: string;
  credentialKey: string;
  network: MoneroNetwork;
  restoreHeight: number;
  /** Omit for the signed build's official Worker; pass only after private pairing. */
  workerDescriptorHex?: string;
  now?: number;
}

export interface EnrollLedgerFastWalletWatchInput {
  walletId: string;
  identityId: string;
  accountIndex: number;
  network: MoneroNetwork;
  restoreHeight: number;
  /** Omit for the signed build's official Worker; pass only after private pairing. */
  workerDescriptorHex?: string;
  now?: number;
}

export interface EnrolledFastWalletWatch {
  assignment: FastWalletAssignment;
  messageId: string;
  workerDescriptorHashInput: string;
}

/**
 * Executes the crash-safe V1 enrollment sequence. The native layer owns the
 * installation authorization, assignment state, Worker trust decision, wallet
 * credential and private view key. JavaScript sees only public routing state
 * plus the fixed-size HPKE ciphertext.
 */
export async function enrollFastWalletWatch(
  nativeWallet: NativeMoneroWalletModule,
  input: EnrollFastWalletWatchInput,
): Promise<EnrolledFastWalletWatch> {
  const startedAt = Date.now();
  logWalletEvent('FastWalletEnrollment', 'enrollment.start', {
    network: input.network,
  });
  try {
    const now = checkedUnsignedInteger(
      input.now ?? Math.floor(Date.now() / 1_000),
      'now',
    );
    const descriptor = checkedCanonicalHex(
      input.workerDescriptorHex?.trim()
        ? input.workerDescriptorHex
        : await nativeWallet.loadOfficialFastWalletWorkerDescriptor(
            input.network,
            now,
          ),
    );
    logWalletEvent('FastWalletEnrollment', 'descriptor.success', {
      elapsedMs: Date.now() - startedAt,
      trusted: true,
    });
    const restoreHeight = checkedUnsignedInteger(
      input.restoreHeight,
      'restoreHeight',
    );
    const assignmentExpiresAt = now + ASSIGNMENT_LIFETIME_SECONDS;
    if (assignmentExpiresAt > MAX_SAFE_INTEGER) {
      throw new Error('Fast Wallet assignment expiry is invalid');
    }

    const assignment = await nativeWallet.sponsorFastWalletAssignment({
      identityId: checkedRequired(input.identityId, 'identityId'),
      workerDescriptorHex: descriptor,
      network: input.network,
      assignmentExpiresAt,
      now,
    });
    logWalletEvent('FastWalletEnrollment', 'assignment.success', {
      elapsedMs: Date.now() - startedAt,
      success: true,
    });
    const envelopeExpiresAt = now + WATCH_ENVELOPE_LIFETIME_SECONDS;
    const envelopeHex = await nativeWallet.sealFastReceiveWatchWithStoredSecret(
      {
        identityId: checkedRequired(input.identityId, 'identityId'),
        path: checkedRequired(input.path, 'path'),
        secretKey: checkedRequired(input.credentialKey, 'credentialKey'),
        network: input.network,
        restoreHeight,
        workerDescriptorHex: descriptor,
        assignmentHandleHex: assignment.assignmentHandle,
        assignmentEpoch: assignment.assignmentEpoch,
        issuedAt: now,
        expiresAt: envelopeExpiresAt,
        now,
      },
    );
    logWalletEvent('FastWalletEnrollment', 'watchEncryption.success', {
      elapsedMs: Date.now() - startedAt,
      success: true,
    });
    const messageId = await nativeWallet.submitFastWalletWatch({
      workerDescriptorHex: descriptor,
      network: input.network,
      now,
      envelopeHex: checkedExactHex(envelopeHex, 484, 'watchEnvelope'),
    });
    logWalletEvent('FastWalletEnrollment', 'watchUpload.success', {
      elapsedMs: Date.now() - startedAt,
      success: true,
    });

    const result = {
      assignment,
      messageId: checkedExactHex(messageId, 32, 'messageId'),
      // The caller hashes this public canonical descriptor before persisting
      // metadata. Keeping the protocol helper independent avoids importing a
      // JavaScript crypto implementation into the secret-adjacent path.
      workerDescriptorHashInput: descriptor,
    };
    logWalletEvent('FastWalletEnrollment', 'enrollment.success', {
      elapsedMs: Date.now() - startedAt,
      success: true,
    });
    return result;
  } catch (error) {
    logWalletEvent('FastWalletEnrollment', 'enrollment.error', {
      elapsedMs: Date.now() - startedAt,
      error,
    });
    throw error;
  }
}

/**
 * Enrolls account 1 of an already-open Ledger container. The native layer
 * obtains the account address and private view key, seals the fixed-size HPKE
 * envelope, and clears its temporary buffers. JavaScript never receives the
 * private view key.
 */
export async function enrollLedgerFastWalletWatch(
  nativeWallet: NativeMoneroWalletModule,
  input: EnrollLedgerFastWalletWatchInput,
): Promise<EnrolledFastWalletWatch> {
  const startedAt = Date.now();
  logWalletEvent('FastWalletEnrollment', 'ledgerEnrollment.start', {
    accountIndex: input.accountIndex,
    network: input.network,
  });
  try {
    const now = checkedUnsignedInteger(
      input.now ?? Math.floor(Date.now() / 1_000),
      'now',
    );
    const descriptor = checkedCanonicalHex(
      input.workerDescriptorHex?.trim()
        ? input.workerDescriptorHex
        : await nativeWallet.loadOfficialFastWalletWorkerDescriptor(
            input.network,
            now,
          ),
    );
    logWalletEvent('FastWalletEnrollment', 'ledgerDescriptor.success', {
      elapsedMs: Date.now() - startedAt,
      trusted: true,
    });
    const identityId = checkedRequired(input.identityId, 'identityId');
    const restoreHeight = checkedUnsignedInteger(
      input.restoreHeight,
      'restoreHeight',
    );
    const accountIndex = checkedUnsignedInteger(
      input.accountIndex,
      'accountIndex',
    );
    if (accountIndex === 0) {
      throw new Error('Ledger Fast Wallet account index is invalid');
    }
    const assignmentExpiresAt = now + ASSIGNMENT_LIFETIME_SECONDS;
    if (assignmentExpiresAt > MAX_SAFE_INTEGER) {
      throw new Error('Fast Wallet assignment expiry is invalid');
    }
    const assignment = await nativeWallet.sponsorFastWalletAssignment({
      identityId,
      workerDescriptorHex: descriptor,
      network: input.network,
      assignmentExpiresAt,
      now,
    });
    logWalletEvent('FastWalletEnrollment', 'ledgerAssignment.success', {
      elapsedMs: Date.now() - startedAt,
      success: true,
    });
    const envelopeExpiresAt = now + WATCH_ENVELOPE_LIFETIME_SECONDS;
    const envelopeHex = await nativeWallet.sealLedgerFastWalletWatch({
      walletId: checkedRequired(input.walletId, 'walletId'),
      identityId,
      accountIndex,
      network: input.network,
      restoreHeight,
      workerDescriptorHex: descriptor,
      assignmentHandleHex: assignment.assignmentHandle,
      assignmentEpoch: assignment.assignmentEpoch,
      issuedAt: now,
      expiresAt: envelopeExpiresAt,
      now,
    });
    logWalletEvent('FastWalletEnrollment', 'ledgerWatchEncryption.success', {
      elapsedMs: Date.now() - startedAt,
      success: true,
    });
    const messageId = await nativeWallet.submitFastWalletWatch({
      workerDescriptorHex: descriptor,
      network: input.network,
      now,
      envelopeHex: checkedExactHex(envelopeHex, 484, 'watchEnvelope'),
    });
    logWalletEvent('FastWalletEnrollment', 'ledgerWatchUpload.success', {
      elapsedMs: Date.now() - startedAt,
      success: true,
    });
    const result = {
      assignment,
      messageId: checkedExactHex(messageId, 32, 'messageId'),
      workerDescriptorHashInput: descriptor,
    };
    logWalletEvent('FastWalletEnrollment', 'ledgerEnrollment.success', {
      elapsedMs: Date.now() - startedAt,
      success: true,
    });
    return result;
  } catch (error) {
    logWalletEvent('FastWalletEnrollment', 'ledgerEnrollment.error', {
      elapsedMs: Date.now() - startedAt,
      error,
    });
    throw error;
  }
}

function checkedRequired(value: string, name: string): string {
  const checked = value.trim();
  if (!checked) {
    throw new Error(`${name} is required`);
  }
  return checked;
}

function checkedCanonicalHex(value: string): string {
  const checked = value.trim();
  if (
    checked.length < 2 ||
    checked.length > 1_024 ||
    checked.length % 2 !== 0 ||
    !CANONICAL_HEX.test(checked)
  ) {
    throw new Error('Worker descriptor is invalid');
  }
  return checked;
}

function checkedExactHex(value: string, bytes: number, name: string): string {
  const checked = value.trim();
  if (checked.length !== bytes * 2 || !CANONICAL_HEX.test(checked)) {
    throw new Error(`${name} is invalid`);
  }
  return checked;
}

function checkedUnsignedInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_SAFE_INTEGER) {
    throw new Error(`${name} is invalid`);
  }
  return value;
}
