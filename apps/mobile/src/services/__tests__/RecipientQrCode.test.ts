import {extractMoneroAddressFromQr} from '../RecipientQrCode';

const ADDRESS =
  '44AFFq5kSiGBoZ...';

// A full-length Base58-looking value is enough to test QR parsing; native
// libwallet remains responsible for final cryptographic address validation.
const FULL_ADDRESS = `${'4'.repeat(95)}`;

describe('extractMoneroAddressFromQr', () => {
  it('accepts a raw Monero address', () => {
    expect(extractMoneroAddressFromQr(FULL_ADDRESS)).toBe(FULL_ADDRESS);
  });

  it('extracts an address from a Monero payment URI', () => {
    expect(
      extractMoneroAddressFromQr(
        `monero:${FULL_ADDRESS}?tx_amount=1.25&recipient_name=Donation`,
      ),
    ).toBe(FULL_ADDRESS);
  });

  it('rejects empty, unrelated, and malformed codes', () => {
    expect(extractMoneroAddressFromQr('')).toBeUndefined();
    expect(extractMoneroAddressFromQr('https://example.com')).toBeUndefined();
    expect(extractMoneroAddressFromQr(ADDRESS)).toBeUndefined();
  });
});
