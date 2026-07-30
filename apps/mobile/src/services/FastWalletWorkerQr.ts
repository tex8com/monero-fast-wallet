const PRIVATE_WORKER_QR_PREFIX = 'tex8-fast-wallet-worker:v1:';
const CANONICAL_HEX = /^[0-9a-f]+$/;

/**
 * Public QR transport only. Cryptographic verification and trust pinning are
 * always performed again inside the native module.
 */
export function parsePrivateFastWalletWorkerQr(
  value: string,
): string | undefined {
  const checked = value.trim();
  if (!checked.startsWith(PRIVATE_WORKER_QR_PREFIX)) {
    return undefined;
  }
  const descriptor = checked.slice(PRIVATE_WORKER_QR_PREFIX.length);
  if (
    descriptor.length < 2 ||
    descriptor.length > 1_024 ||
    descriptor.length % 2 !== 0 ||
    !CANONICAL_HEX.test(descriptor)
  ) {
    return undefined;
  }
  return descriptor;
}

export function privateFastWalletWorkerQrPayload(
  descriptorHex: string,
): string {
  const descriptor = descriptorHex.trim();
  if (
    descriptor.length < 2 ||
    descriptor.length > 1_024 ||
    descriptor.length % 2 !== 0 ||
    !CANONICAL_HEX.test(descriptor)
  ) {
    throw new Error('Worker descriptor is invalid');
  }
  return `${PRIVATE_WORKER_QR_PREFIX}${descriptor}`;
}
