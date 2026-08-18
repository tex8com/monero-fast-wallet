import {
  loadProtectedMetadata,
  storeProtectedMetadata,
} from '../ProtectedMetadataStorage';
import {
  acceptRecipientReview,
  createPrivatePhoneSendPreset,
  createRecipientReview,
  maskPhoneNumber,
  recipientFingerprint,
  validatePrivatePhoneSendPreset,
} from '../RecipientReview';

jest.mock('../ProtectedMetadataStorage', () => ({
  loadProtectedMetadata: jest.fn(),
  storeProtectedMetadata: jest.fn(),
}));

const mockedLoad = loadProtectedMetadata as jest.MockedFunction<
  typeof loadProtectedMetadata
>;
const mockedStore = storeProtectedMetadata as jest.MockedFunction<
  typeof storeProtectedMetadata
>;
const firstAddress = `8${'1'.repeat(94)}`;
const secondAddress = `8${'2'.repeat(94)}`;

describe('RecipientReview', () => {
  let stored: string | null;

  beforeEach(() => {
    stored = null;
    mockedLoad.mockImplementation(async () => stored);
    mockedStore.mockImplementation(async (_key, value) => {
      stored = value;
    });
  });

  it('creates the same public review shape for ordinary recipient paths', () => {
    expect(
      createRecipientReview({
        source: 'qr-code',
        network: 'mainnet',
        address: firstAddress,
        now: 50,
      }),
    ).toEqual({
      version: 1,
      source: 'qr-code',
      network: 'mainnet',
      address: firstAddress,
      displayName: '',
      resolvedAt: 50,
      addressChanged: false,
    });
    expect(recipientFingerprint(firstAddress)).toBe(
      `${firstAddress.slice(0, 8)}…${firstAddress.slice(-8)}`,
    );
  });

  it('warns about a changed private address only after an earlier review was accepted', async () => {
    const first = await createPrivatePhoneSendPreset({
      flowId: 'flow-1',
      phoneNumber: '+50761234567',
      displayName: 'Alice',
      network: 'mainnet',
      address: firstAddress,
      issuedAt: 90,
      expiresAt: 200,
      sequence: 1,
      now: 100,
    });
    expect(first.addressChanged).toBe(false);

    await acceptRecipientReview(first, 101);
    const changed = await createPrivatePhoneSendPreset({
      flowId: 'flow-2',
      phoneNumber: '+50761234567',
      displayName: 'Alice',
      network: 'mainnet',
      address: secondAddress,
      issuedAt: 102,
      expiresAt: 220,
      sequence: 2,
      now: 110,
    });
    expect(changed.addressChanged).toBe(true);
    expect(maskPhoneNumber(changed.privatePhoneNumber)).not.toContain(
      '61234567',
    );
  });

  it('rejects injected, expired, wrong-network-shaped route presets', async () => {
    const preset = await createPrivatePhoneSendPreset({
      flowId: 'flow-3',
      phoneNumber: '+50761234567',
      network: 'stagenet',
      address: firstAddress,
      issuedAt: 90,
      expiresAt: 200,
      sequence: 3,
      now: 100,
    });
    expect(validatePrivatePhoneSendPreset(preset, 100)).toEqual(preset);
    expect(
      validatePrivatePhoneSendPreset({ ...preset, expiresAt: 99 }, 100),
    ).toBeUndefined();
    expect(
      validatePrivatePhoneSendPreset({ ...preset, network: 'unknown' }, 100),
    ).toBeUndefined();
    expect(
      validatePrivatePhoneSendPreset({ ...preset, address: 'not-monero' }, 100),
    ).toBeUndefined();
  });
});
