import {
  beginPrivatePhoneSharingRevocation,
  completePrivatePhoneSharingRevocation,
  loadPrivatePhoneConsent,
  mayFindPrivatePhoneContacts,
  mayPublishPrivatePhoneContacts,
  setPrivatePhoneDiscoveryConsent,
  setPrivatePhoneSharedContacts,
} from '../PrivatePhoneConsentRegistry';
import {
  loadProtectedMetadata,
  storeProtectedMetadata,
} from '../ProtectedMetadataStorage';

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

describe('PrivatePhoneConsentRegistry', () => {
  beforeEach(() => {
    mockedLoad.mockReset();
    mockedStore.mockReset();
  });

  it('fails closed when consent is missing or malformed', async () => {
    mockedLoad.mockResolvedValueOnce(null).mockResolvedValueOnce('{broken');
    await expect(loadPrivatePhoneConsent()).resolves.toMatchObject({
      findPeopleEnabled: false,
      sharingStatus: 'off',
      sharedContacts: [],
    });
    await expect(loadPrivatePhoneConsent()).resolves.toMatchObject({
      findPeopleEnabled: false,
      sharingStatus: 'off',
      sharedContacts: [],
    });
  });

  it('keeps discovery and sharing as independent choices', async () => {
    mockedLoad.mockResolvedValue(
      JSON.stringify({
        version: 1,
        findPeopleEnabled: false,
        sharingStatus: 'active',
        sharedContacts: [
          {
            contactId: 'person-1',
            e164: '+50761234567',
            policy: 'badge',
          },
        ],
      }),
    );
    mockedStore.mockResolvedValue();
    const next = await setPrivatePhoneDiscoveryConsent(true);
    expect(mayFindPrivatePhoneContacts(next)).toBe(true);
    expect(mayPublishPrivatePhoneContacts(next)).toBe(true);
    expect(mockedStore).toHaveBeenCalledWith(
      expect.stringContaining('private-phone-consent'),
      expect.stringContaining('"findPeopleEnabled":true'),
    );
  });

  it('requires a wallet before direct publication and an address after acknowledgement', async () => {
    mockedLoad.mockResolvedValue(null);
    mockedStore.mockResolvedValue();
    await expect(
      setPrivatePhoneSharedContacts([
        {
          contactId: 'person-1',
          e164: '+50761234567',
          policy: 'direct',
        },
      ]),
    ).rejects.toThrow('requires a selected wallet');
    await expect(
      setPrivatePhoneSharedContacts([
        {
          contactId: 'person-1',
          e164: '+50761234567',
          policy: 'direct',
          walletRegistrationId: 'wallet-1',
          publicationStatus: 'publishing',
        },
      ]),
    ).resolves.toMatchObject({
      sharingStatus: 'active',
    });
    await expect(
      setPrivatePhoneSharedContacts([
        {
          contactId: 'person-1',
          e164: '+50761234567',
          policy: 'direct',
          walletRegistrationId: 'wallet-1',
          publicationStatus: 'active',
          address: `8${'1'.repeat(94)}`,
        },
      ]),
    ).resolves.toMatchObject({
      sharingStatus: 'active',
    });
  });

  it('retains selections until remote revocation is acknowledged', async () => {
    const active = {
      version: 1 as const,
      findPeopleEnabled: true,
      sharingStatus: 'active' as const,
      sharedContacts: [
        {
          contactId: 'person-1',
          e164: '+50761234567',
          policy: 'ask' as const,
        },
      ],
    };
    mockedLoad
      .mockResolvedValueOnce(JSON.stringify(active))
      .mockResolvedValueOnce(
        JSON.stringify({...active, sharingStatus: 'revocation-pending'}),
      );
    mockedStore.mockResolvedValue();
    await expect(beginPrivatePhoneSharingRevocation()).resolves.toMatchObject({
      sharingStatus: 'revocation-pending',
      sharedContacts: active.sharedContacts,
    });
    await expect(completePrivatePhoneSharingRevocation()).resolves.toMatchObject({
      sharingStatus: 'off',
      sharedContacts: [],
      findPeopleEnabled: true,
    });
  });
});
