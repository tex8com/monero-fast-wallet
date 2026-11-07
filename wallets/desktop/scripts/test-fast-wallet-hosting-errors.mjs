import assert from 'node:assert/strict';
import test from 'node:test';
import {
  fastWalletHostingErrorTranslationKey,
  fastWalletHostingFailure,
  fastWalletHostingNeedsRepair,
  parseFastWalletHostingView,
} from '../../../packages/wallet-shared/src/fastWalletHosting.ts';

test('helper registration errors are distinct from wallet password and notification permission errors', () => {
  for (const message of [
    'The Windows notification helper task could not be registered. No administrator password is required.',
    'Task Scheduler denied permission to register the TEX8 background helper.',
    'notification-agent-registration-failed: Windows error 87',
  ]) {
    const failure = fastWalletHostingFailure(new Error(message));
    assert.deepEqual(failure, { status: 'unknown', errorCode: 'notification_service_error' });
    assert.equal(fastWalletHostingErrorTranslationKey(failure.errorCode), 'wallets.hostingNotificationServiceError');
  }
});

test('missing or incorrect app authorization remains actionable instead of becoming a connection error', () => {
  for (const error of [
    new Error('The app password is incorrect. Retry in 1 seconds.'),
    'Unlock Monero Fast Wallet before opening wallets.',
    { code: 'authentication_failed', message: 'Device sign-in was cancelled.' },
  ]) {
    const failure = fastWalletHostingFailure(error);
    assert.deepEqual(failure, { status: 'blocked', errorCode: 'authorization_required' });
    assert.equal(fastWalletHostingErrorTranslationKey(failure.errorCode), 'wallets.hostingAuthorizationRequired');
  }
  // The current native hosting response uses this code for a missing app password.
  assert.equal(fastWalletHostingErrorTranslationKey('credential_missing'), 'wallets.hostingAuthorizationRequired');
});

test('a device credential-store failure requests notification setup instead of an app password', () => {
  const failure = fastWalletHostingFailure('The notification installation credential could not be read from secure storage.');
  assert.deepEqual(failure, { status: 'blocked', errorCode: 'gateway_credentials_missing' });
  assert.equal(fastWalletHostingErrorTranslationKey(failure.errorCode), 'wallets.hostingNotificationServiceError');
});

test('APNs permission and service failures retain the shared mobile meanings', () => {
  const denied = fastWalletHostingFailure({ code: 'apns-authorization-denied', message: 'Remote registration failed.' });
  assert.deepEqual(denied, { status: 'blocked', errorCode: 'notification_permission_required' });
  assert.equal(fastWalletHostingErrorTranslationKey(denied.errorCode), 'wallets.hostingPermissionRequired');
  assert.deepEqual(fastWalletHostingFailure(new Error('apns-registration-timeout')), {
    status: 'unknown', errorCode: 'notification_service_error',
  });
});

test('unknown errors retain no arbitrary message and never authorize hosting repair', () => {
  const error = { code: 'SERVER_FREEFORM_SECRET', message: 'https://fixture.invalid/raw-private-value', privateViewKey: 'never-copy' };
  const failure = fastWalletHostingFailure(error);
  assert.deepEqual(failure, { status: 'unknown', errorCode: 'hosting_check_failed' });
  const view = parseFastWalletHostingView({ ...failure, attemptedAt: 1000, verified: false, repairAttempted: false }, 1000);
  assert.equal(view?.verified, false);
  assert.equal(fastWalletHostingNeedsRepair(view), false);
  assert.equal(JSON.stringify(view).includes('raw-private-value'), false);
  assert.equal(JSON.stringify(view).includes('never-copy'), false);
});

test('proof and unsupported-worker failures do not become permission or connection errors', () => {
  assert.equal(fastWalletHostingErrorTranslationKey(fastWalletHostingFailure('invalid_proof').errorCode), 'wallets.hostingInvalidProof');
  assert.equal(fastWalletHostingErrorTranslationKey(fastWalletHostingFailure({ code: 'unsupported_worker' }).errorCode), 'wallets.hostingUnsupported');
});
