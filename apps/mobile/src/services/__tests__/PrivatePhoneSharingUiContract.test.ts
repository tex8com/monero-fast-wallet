import { readFileSync } from 'fs';
import { resolve } from 'path';

const mobileRoot = resolve(__dirname, '..', '..', '..');
const repoRoot = resolve(mobileRoot, '..', '..');
const source = (...parts: string[]) =>
  readFileSync(resolve(mobileRoot, ...parts), 'utf8');

describe('private phone sharing UI contract', () => {
  const menu = source('src', 'screens', 'MenuScreen.tsx');
  const navigation = source('src', 'navigation', 'TabNavigator.tsx');
  const screen = source('src', 'screens', 'PrivateContactsScreen.tsx');
  const send = source('src', 'screens', 'SendScreen.tsx');
  const sharing = source('src', 'services', 'PrivatePhoneSharingService.ts');
  const requests = source('src', 'services', 'PrivatePhoneAddressRequests.ts');
  const review = source('src', 'services', 'RecipientReview.ts');
  const manifest = JSON.parse(
    readFileSync(
      resolve(repoRoot, 'config', 'v1-release-features.json'),
      'utf8',
    ),
  );

  it('keeps the retired screen out of the product navigation', () => {
    expect(menu).not.toContain('PrivateContacts');
    expect(navigation).not.toContain('PrivateContacts');
    expect(manifest.features.deviceContactDiscovery).toBe(false);
    expect(manifest.parameters.privatePhoneDirectory).toBeNull();
  });

  it('keeps finding, verification and selected sharing as separate actions', () => {
    expect(screen).toContain("t('privateContacts.findTitle')");
    expect(screen).toContain("t('privateContacts.verifyTitle')");
    expect(screen).toContain("t('privateContacts.shareTitle')");
    expect(screen).toContain('requestPrivatePhoneDiscoveryConsent');
    expect(screen).toContain('startPrivatePhoneVerification');
    expect(screen).toContain('sharePrivatePhoneContact');
  });

  it('uses plain-language choices and requires an open wallet for direct sharing', () => {
    expect(screen).toContain("t('privateContacts.badge')");
    expect(screen).toContain("t('privateContacts.ask')");
    expect(screen).toContain("t('privateContacts.direct')");
    expect(screen).toContain("t('privateContacts.walletRequired')");
  });

  it('persists intent before publication and tombstones before local removal', () => {
    expect(sharing).toMatch(
      /publicationStatus: 'publishing'[\s\S]+setPrivatePhoneSharedContacts[\s\S]+publishPrivatePhoneContact/,
    );
    expect(sharing).toMatch(
      /publicationStatus: 'revoking'[\s\S]+revokePublishedPrivatePhoneContact[\s\S]+filter/,
    );
    expect(sharing).toMatch(
      /beginPrivatePhoneSharingRevocation[\s\S]+removePrivatePhoneParticipant[\s\S]+completePrivatePhoneSharingRevocation/,
    );
  });

  it('never handles opaque tokens, pair IDs, snapshots or private keys', () => {
    expect(screen).not.toMatch(
      /phoneTokenHex|pairIdHex|snapshotBytes|privateKeyHex|hpkePublicKeyHex|blindedRequest/i,
    );
    expect(sharing).not.toMatch(
      /phoneTokenHex|pairIdHex|snapshotBytes|privateKeyHex|hpkePublicKeyHex|blindedRequest/i,
    );
  });

  it('routes a direct card through one native-validated recipient review', () => {
    expect(screen).toContain('client.inspectContact');
    expect(screen).toContain('createPrivatePhoneSendPreset');
    expect(screen).toContain("navigation.navigate('Send'");
    expect(send).toContain('validatePrivatePhoneSendPreset');
    expect(send).toContain('walletService.validateRecipientAddress');
    expect(send).toContain("setStep('recipient-review')");
    expect(send).toContain('acceptRecipientReview(recipientReview)');
    expect(review).toContain('addressChanged: Boolean');
    expect(review).toContain('storeProtectedMetadata');
  });

  it('keeps AskEveryTime simple while native code owns every protocol secret', () => {
    expect(screen).toContain('requestSelectedAddress');
    expect(screen).toContain('checkAddressRequestResult');
    expect(screen).toContain('answerIncomingRequest');
    expect(screen).toContain("t('privateContacts.requestAddress')");
    expect(screen).toContain("t('privateContacts.approveRequest')");
    expect(requests).toContain('requestPrivatePhoneAddress');
    expect(requests).toContain('pollPrivatePhoneAddressRequest');
    expect(requests).toContain('pollIncomingPrivatePhoneAddressRequests');
    expect(requests).not.toMatch(
      /phoneTokenHex|pairIdHex|privateKeyHex|hpkePublicKeyHex|requestState|envelopeHex/,
    );
  });
});
