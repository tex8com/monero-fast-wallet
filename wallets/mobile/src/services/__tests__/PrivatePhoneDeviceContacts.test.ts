const mockBeginSystemUiInterruption = jest.fn(
  async (reason: string) => `native-${reason}`,
);
const mockEndSystemUiInterruption = jest.fn(async () => undefined);

jest.mock('../NativeMoneroWallet', () => ({
  requireNativeMoneroWallet: () => ({
    beginSystemUiInterruption: mockBeginSystemUiInterruption,
    endSystemUiInterruption: mockEndSystemUiInterruption,
  }),
}));

import { loadPrivatePhoneDeviceContacts } from '../PrivatePhoneDeviceContacts';

describe('PrivatePhoneDeviceContacts', () => {
  it('does not request native permission while the release feature is off', async () => {
    const native = {
      loadPrivatePhoneDeviceContacts: jest.fn(),
    };
    await expect(
      loadPrivatePhoneDeviceContacts({
        featureEnabled: false,
        consentGranted: false,
        native,
      }),
    ).rejects.toThrow('not available');
    expect(native.loadPrivatePhoneDeviceContacts).not.toHaveBeenCalled();
  });

  it('does not request native permission before explicit discovery consent', async () => {
    const native = {
      loadPrivatePhoneDeviceContacts: jest.fn(),
    };
    await expect(
      loadPrivatePhoneDeviceContacts({
        featureEnabled: true,
        consentGranted: false,
        native,
      }),
    ).rejects.toThrow('Find people from my contacts');
    expect(native.loadPrivatePhoneDeviceContacts).not.toHaveBeenCalled();
  });

  it('accepts only bounded canonical E.164 projections', async () => {
    const native = {
      loadPrivatePhoneDeviceContacts: jest.fn(async () => [
        {
          contactId: 'contact-1',
          displayName: ' Alice ',
          e164Numbers: ['+436641234567', '+436641234567', 'invalid'],
        },
      ]),
    };

    await expect(
      loadPrivatePhoneDeviceContacts({
        featureEnabled: true,
        consentGranted: true,
        native,
      }),
    ).resolves.toEqual([
      {
        contactId: 'contact-1',
        displayName: 'Alice',
        e164Numbers: ['+436641234567'],
      },
    ]);
  });

  it('rejects duplicate contact identities and empty canonical projections', async () => {
    const duplicateNative = {
      loadPrivatePhoneDeviceContacts: jest.fn(async () => [
        {
          contactId: 'same',
          displayName: 'Alice',
          e164Numbers: ['+436641234567'],
        },
        {
          contactId: 'same',
          displayName: 'Bob',
          e164Numbers: ['+50761234567'],
        },
      ]),
    };
    await expect(
      loadPrivatePhoneDeviceContacts({
        featureEnabled: true,
        consentGranted: true,
        native: duplicateNative,
      }),
    ).rejects.toThrow('duplicate IDs');

    const emptyNative = {
      loadPrivatePhoneDeviceContacts: jest.fn(async () => [
        {
          contactId: 'contact-2',
          displayName: 'Bob',
          e164Numbers: ['00436641234567'],
        },
      ]),
    };
    await expect(
      loadPrivatePhoneDeviceContacts({
        featureEnabled: true,
        consentGranted: true,
        native: emptyNative,
      }),
    ).rejects.toThrow('no valid phone number');
  });
});
