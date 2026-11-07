import {
  ledgerFlowCancellationAllowed,
  ledgerNativeCancellationSupported,
} from '../LedgerCancellation';

it('permits cooperative iOS discovery cancellation without claiming native interruption support', () => {
  expect(ledgerNativeCancellationSupported('ios')).toBe(false);
  expect(ledgerFlowCancellationAllowed('ios', 'searching')).toBe(true);
  expect(ledgerFlowCancellationAllowed('ios', 'connecting')).toBe(true);
});

it.each([
  'synchronizing-wallet',
  'verifying-wallet',
  'connected',
  'preparing-request',
  'preparing-transaction',
  'awaiting-confirmation',
] as const)('keeps iOS %s active until the native operation returns', phase => {
  expect(ledgerFlowCancellationAllowed('ios', phase)).toBe(false);
  expect(ledgerFlowCancellationAllowed('android', phase)).toBe(true);
});

it('does not invent cancellation support on another platform or an idle flow', () => {
  expect(ledgerNativeCancellationSupported('macos')).toBe(false);
  expect(ledgerFlowCancellationAllowed('macos', 'preparing-request')).toBe(
    false,
  );
  expect(ledgerFlowCancellationAllowed('ios', undefined)).toBe(false);
  expect(ledgerFlowCancellationAllowed('android', undefined)).toBe(false);
});
