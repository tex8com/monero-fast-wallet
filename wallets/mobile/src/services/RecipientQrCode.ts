/**
 * Extracts an address from either a raw Monero address or a `monero:` URI.
 * The native wallet remains the final authority when a transaction is prepared;
 * this only keeps unrelated QR codes from filling the recipient field.
 */
export function extractMoneroAddressFromQr(value: string): string | undefined {
  const raw = value.trim();
  if (!raw) {
    return undefined;
  }

  const withoutScheme = raw.replace(/^monero:/i, '');
  const address = withoutScheme.split(/[?#]/, 1)[0]?.trim();
  if (!address || !/^[1-9A-HJ-NP-Za-km-z]{90,120}$/.test(address)) {
    return undefined;
  }

  return address;
}
