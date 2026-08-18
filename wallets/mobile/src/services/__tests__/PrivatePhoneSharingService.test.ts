import {
  removePrivatePhoneParticipant,
  revokePrivatePhoneContact,
  sharePrivatePhoneContact,
} from '../PrivatePhoneSharingService';
import {
  beginPrivatePhoneSharingRevocation,
  completePrivatePhoneSharingRevocation,
  loadPrivatePhoneConsent,
  setPrivatePhoneSharedContacts,
} from '../PrivatePhoneConsentRegistry';

jest.mock('../PrivatePhoneConsentRegistry', () => ({
  beginPrivatePhoneSharingRevocation: jest.fn(),
  completePrivatePhoneSharingRevocation: jest.fn(),
  loadPrivatePhoneConsent: jest.fn(),
  setPrivatePhoneSharedContacts: jest.fn(),
}));

const mockedLoad = loadPrivatePhoneConsent as jest.MockedFunction<
  typeof loadPrivatePhoneConsent
>;
const mockedSet = setPrivatePhoneSharedContacts as jest.MockedFunction<
  typeof setPrivatePhoneSharedContacts
>;
const mockedBegin =
  beginPrivatePhoneSharingRevocation as jest.MockedFunction<
    typeof beginPrivatePhoneSharingRevocation
  >;
const mockedComplete =
  completePrivatePhoneSharingRevocation as jest.MockedFunction<
    typeof completePrivatePhoneSharingRevocation
  >;

const emptyState = {
  version: 1 as const,
  findPeopleEnabled: false,
  sharingStatus: 'off' as const,
  sharedContacts: [],
};
const address = `8${'1'.repeat(94)}`;

describe('PrivatePhoneSharingService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedLoad.mockResolvedValue(emptyState);
    mockedSet.mockImplementation(async contacts => ({
      ...emptyState,
      sharingStatus: contacts.length === 0 ? 'off' : 'active',
      sharedContacts: contacts,
    }));
    mockedBegin.mockResolvedValue(emptyState);
    mockedComplete.mockResolvedValue(emptyState);
  });

  it('fails closed before calling native when the signed feature is disabled', async () => {
    const native = {
      publishPrivatePhoneContact: jest.fn(),
      revokePublishedPrivatePhoneContact: jest.fn(),
      removePrivatePhoneParticipant: jest.fn(),
      getPrivatePhoneParticipantStatus: jest.fn(),
    };
    await expect(
      sharePrivatePhoneContact(
        {
          contactId: 'person-1',
          e164: '+50761234567',
          policy: 'badge',
        },
        {featureEnabled: false, trustConfigured: true, native},
      ),
    ).rejects.toThrow('not available');
    expect(native.publishPrivatePhoneContact).not.toHaveBeenCalled();
    expect(mockedSet).not.toHaveBeenCalled();
  });

  it('stores publishing intent before native creates and publishes a direct subaddress', async () => {
    const order: string[] = [];
    mockedSet.mockImplementation(async contacts => {
      order.push(`store:${contacts[0]?.publicationStatus ?? 'empty'}`);
      return {
        ...emptyState,
        sharingStatus: contacts.length === 0 ? 'off' : 'active',
        sharedContacts: contacts,
      };
    });
    const native = {
      publishPrivatePhoneContact: jest.fn(async () => {
        order.push('native');
        return {
          policy: 'direct',
          network: 'stagenet',
          address,
          issuedAt: Math.floor(Date.now() / 1_000),
          expiresAt: Math.floor(Date.now() / 1_000) + 3_600,
          sequence: 1,
        };
      }),
      revokePublishedPrivatePhoneContact: jest.fn(),
      removePrivatePhoneParticipant: jest.fn(),
      getPrivatePhoneParticipantStatus: jest.fn(),
    };

    await expect(
      sharePrivatePhoneContact(
        {
          contactId: 'person-1',
          e164: '+50761234567',
          policy: 'direct',
          wallet: {
            registrationId: 'wallet-registration-1',
            nativeWalletId: 'native-wallet-1',
            accountIndex: 0,
            network: 'stagenet',
          },
        },
        {featureEnabled: true, trustConfigured: true, native},
      ),
    ).resolves.toMatchObject({
      publicationStatus: 'active',
      address,
    });
    expect(order).toEqual(['store:publishing', 'native', 'store:active']);
    expect(native.publishPrivatePhoneContact).toHaveBeenCalledWith(
      '+50761234567',
      'native-wallet-1',
      0,
      'direct',
      'stagenet',
    );
  });

  it('retains publishing state when the native network mutation fails', async () => {
    const native = {
      publishPrivatePhoneContact: jest.fn(async () => {
        throw new Error('offline');
      }),
      revokePublishedPrivatePhoneContact: jest.fn(),
      removePrivatePhoneParticipant: jest.fn(),
      getPrivatePhoneParticipantStatus: jest.fn(),
    };
    await expect(
      sharePrivatePhoneContact(
        {
          contactId: 'person-1',
          e164: '+50761234567',
          policy: 'ask',
        },
        {featureEnabled: true, trustConfigured: true, native},
      ),
    ).rejects.toThrow('offline');
    expect(mockedSet).toHaveBeenCalledTimes(1);
    expect(mockedSet.mock.calls[0][0][0]).toMatchObject({
      publicationStatus: 'publishing',
    });
  });

  it('marks a contact revoking until native acknowledges its tombstone', async () => {
    mockedLoad.mockResolvedValue({
      ...emptyState,
      sharingStatus: 'active',
      sharedContacts: [
        {
          contactId: 'person-1',
          e164: '+50761234567',
          policy: 'ask',
          publicationStatus: 'active',
        },
      ],
    });
    const native = {
      publishPrivatePhoneContact: jest.fn(),
      revokePublishedPrivatePhoneContact: jest.fn(async () => undefined),
      removePrivatePhoneParticipant: jest.fn(),
      getPrivatePhoneParticipantStatus: jest.fn(),
    };
    await revokePrivatePhoneContact('+50761234567', {
      featureEnabled: true,
      trustConfigured: true,
      native,
    });
    expect(mockedSet.mock.calls[0][0][0]).toMatchObject({
      publicationStatus: 'revoking',
    });
    expect(native.revokePublishedPrivatePhoneContact).toHaveBeenCalledWith(
      '+50761234567',
    );
    expect(mockedSet.mock.calls[1][0]).toEqual([]);
  });

  it('keeps global revocation pending until native removes the participant', async () => {
    const native = {
      publishPrivatePhoneContact: jest.fn(),
      revokePublishedPrivatePhoneContact: jest.fn(),
      removePrivatePhoneParticipant: jest.fn(async () => undefined),
      getPrivatePhoneParticipantStatus: jest.fn(async () => ({
        verified: true,
        expiresAt: Math.floor(Date.now() / 1_000) + 3_600,
      })),
    };
    await removePrivatePhoneParticipant({
      featureEnabled: true,
      trustConfigured: true,
      native,
    });
    expect(mockedBegin).toHaveBeenCalledTimes(1);
    expect(native.removePrivatePhoneParticipant).toHaveBeenCalledTimes(1);
    expect(mockedComplete).toHaveBeenCalledTimes(1);
  });

  it('can finish local cleanup after native participant removal already succeeded', async () => {
    const native = {
      publishPrivatePhoneContact: jest.fn(),
      revokePublishedPrivatePhoneContact: jest.fn(),
      removePrivatePhoneParticipant: jest.fn(),
      getPrivatePhoneParticipantStatus: jest.fn(async () => ({
        verified: false,
        expiresAt: 0,
      })),
    };
    await removePrivatePhoneParticipant({
      featureEnabled: true,
      trustConfigured: true,
      native,
    });
    expect(mockedBegin).toHaveBeenCalledTimes(1);
    expect(native.removePrivatePhoneParticipant).not.toHaveBeenCalled();
    expect(mockedComplete).toHaveBeenCalledTimes(1);
  });
});
