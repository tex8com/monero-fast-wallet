// Source-only regression cases. Run later with the normal strip-types gate.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import {classifySendPreparationError} from '../../../packages/wallet-shared/src/sendErrors.ts';

test('only canonical Ledger fee/output denials become intentional preparation cancellation', () => {
  for (const reason of [
    'Fee denied on device.',
    'unexpected error: Fee denied on device.',
    new Error('prepareSendPlan: unexpected error: Fee denied on device.'),
    {message: 'prepareTransaction: unexpected error: Transaction denied on device.'},
  ]) {
    assert.deepEqual(classifySendPreparationError(reason), {
      kind: 'ledger-cancelled', messageKey: 'send.preparationCancelledLedger', cancelled: true,
    });
  }
  for (const reason of [
    'Amount denied on device.', // Not a canonical message in the pinned Core.
    'Fee denied on device. Connection timed out.',
    'Transport failed: Fee denied on device.',
    'Key export rejected on device.',
    'Ledger disconnected', 'The node denied the transaction',
  ]) assert.equal(classifySendPreparationError(reason).cancelled, false);
});

test('output distribution RPC failure is distinct from a Ledger rejection', () => {
  for (const reason of [
    'RPC error: get_output_distribution',
    new Error('unexpected error: /get_output_distribution.bin failed'),
    'Could not obtain output distribution.',
    'RPC error: /private/build/src/wallet/wallet2.cpp:10888:N5tools5error23get_output_distributionE: failed to get output distribution, request = Could not obtain output distribution.',
    'RPC error: get_output_distribution: Could not obtain output distribution. stage=anchor-read',
  ]) {
    assert.equal(classifySendPreparationError(reason).kind, 'node-output-distribution');
    assert.equal(classifySendPreparationError(reason).cancelled, false);
  }
});

test('ownership verification failures retain a separate Ledger explanation', () => {
  for (const reason of [
    'Ledger scan-state source has an unverified owned output at index 25',
    'primeHardwareWalletFromViewOnly.prepareHardwareWalletScan: Ledger output binding failed at index 25',
    'Ledger could not verify owned output 25',
    'Ledger Key Image does not match the companion at index 25',
    'Ledger-derived ephemeral public key does not match owned output 25',
  ]) {
    assert.equal(classifySendPreparationError(reason).kind, 'ledger-output-verification');
    assert.equal(classifySendPreparationError(reason).cancelled, false);
  }
});

test('unknown native details are replaced with a fixed safe preparation message', () => {
  for (const reason of [
    'Native request failed at /private/wallet/path with endpoint daemon.example',
    {message: 'Unknown failure', address: 'private-address', token: 'private-token'},
    {address: 'private-address', token: 'private-token'},
    null, undefined, 'x'.repeat(4097),
  ]) {
    assert.deepEqual(classifySendPreparationError(reason), {
      kind: 'unknown', messageKey: 'send.preparationUnknownFailed', cancelled: false,
    });
  }
});

test('both UIs use this classifier only before submission, never for commit receipts', () => {
  const desktop = fs.readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
  const mobile = fs.readFileSync(new URL('../../mobile/src/screens/SendScreen.tsx', import.meta.url), 'utf8');
  assert.match(desktop.slice(desktop.indexOf('const prepare = async'), desktop.indexOf('const updatePlanStatus =')), /classifySendPreparationError\(reason\)/);
  assert.doesNotMatch(desktop.slice(desktop.indexOf('const commit = async'), desktop.indexOf('const finishSuccess =')), /classifySendPreparationError/);
  assert.match(mobile.slice(mobile.indexOf('const prepareForReview = async'), mobile.indexOf('const prepareMfwApprovalAgain =')), /classifySendPreparationError\(error\)/);
  assert.doesNotMatch(mobile.slice(mobile.indexOf('const handleSend = async'), mobile.indexOf('const updatePlanReceiptStatus =')), /classifySendPreparationError/);
});
