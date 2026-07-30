import { readFileSync } from 'fs';
import { resolve } from 'path';

const mobileRoot = resolve(__dirname, '..', '..', '..');
const repoRoot = resolve(mobileRoot, '..', '..');
const source = (...parts: string[]) =>
  readFileSync(resolve(mobileRoot, ...parts), 'utf8');

describe('MFW name registration UI contract', () => {
  const home = source('src', 'screens', 'HomeScreen.tsx');
  const menu = source('src', 'screens', 'MenuScreen.tsx');
  const names = source('src', 'screens', 'MfwNamesScreen.tsx');
  const send = source('src', 'screens', 'SendScreen.tsx');
  const navigation = source('src', 'navigation', 'TabNavigator.tsx');
  const registration = source('src', 'services', 'MfwNameRegistration.ts');
  const manifest = JSON.parse(
    readFileSync(
      resolve(repoRoot, 'config', 'v1-release-features.json'),
      'utf8',
    ),
  );

  it('keeps the discovery screen reachable while transaction activation stays gated', () => {
    expect(home).toMatch(
      /v1ReleaseFeatures\.mfwNameRegistration[\s\S]+mfwNames\.claimYourAddress/,
    );
    expect(menu).toContain('screen: "MfwNames"');
    expect(navigation).toContain('name="MfwNames"');
    expect(manifest.features.mfwNameRegistration).toBe(false);
    expect(manifest.parameters.mfwNameGenesis).toBeNull();
    expect(names).toContain('!v1ReleaseFeatures.mfwNameRegistration');
  });

  it('offers every stored wallet address and a dedicated privacy subaddress', () => {
    expect(names).toContain('loadWalletAddresses');
    expect(names).toContain('walletService.createSubaddress');
    expect(names).toContain("t('mfwNames.publicWarning')");
    expect(names).toContain("t('mfwNames.createDedicated')");
  });

  it('documents and enforces the two-approval commit/reveal journey', () => {
    expect(names).toContain("t('mfwNames.twoApprovals')");
    expect(names).toContain("t('mfwNames.commitTitle')");
    expect(names).toContain("t('mfwNames.claimTitle')");
    expect(send).toContain('validateMfwNameSendPreset');
    expect(send).toContain("setStep('confirm')");
    expect(send).toContain("mfwNamePreset.kind === 'commit'");
    expect(send).toContain("mfwNamePreset?.kind === 'claim'");
  });

  it('lists every locally tracked name with exact expiry and estimated days', () => {
    expect(names).toContain('loadMfwOwnedNames');
    expect(names).toContain('ownedNames.map');
    expect(names).toContain('record.expiryHeight');
    expect(names).toContain('mfwNameRemainingDays');
    expect(names).toContain("t('mfwNames.expiryEstimate')");
  });

  it('requires quorum availability and offers complete active-name management', () => {
    expect(names).toContain('checkConfiguredMfwNameAvailability');
    expect(names).toContain("availability.value.status !== 'available'");
    expect(names).toContain("const renewable = stage === 'active'");
    expect(names).toContain('beginRenewal(record)');
    expect(names).toContain('continueRenewal');
    expect(names).toContain('beginAddressUpdate(record)');
    expect(names).toContain('continueAddressUpdate');
    expect(names).toContain('continueRevocation(record)');
    expect(send).toContain("mfwNamePreset.kind === 'renew'");
    expect(send).toContain("mfwNamePreset.kind === 'update'");
    expect(send).toContain("mfwNamePreset.kind === 'revoke'");
    expect(registration).toContain("| 'update'");
    expect(registration).toContain("| 'revoke'");
  });

  it('never passes owner secret, commit salt or raw tx_extra through React navigation', () => {
    const preset = registration.slice(
      registration.indexOf('export interface MfwNameSendPreset'),
      registration.indexOf('export interface MfwNameRegistrationDraft'),
    );
    expect(preset).not.toMatch(/ownerSecret|privateKey|commitSalt|txExtra/i);
    expect(registration).toContain(
      'They stay in native protected storage / the native pending transaction.',
    );
  });

  it('keeps owner recovery import in native UI and owner-matches the chain record', () => {
    expect(names).toContain('resolveConfiguredMfwOwnedNameForImport');
    expect(names).toContain('walletService.importMfwNameRecovery');
    expect(names).toContain('resolution.ownerPublicKeyHex');
    expect(names).not.toMatch(/\bbundleHex\b|\bpassphrase\b/);
  });
});
