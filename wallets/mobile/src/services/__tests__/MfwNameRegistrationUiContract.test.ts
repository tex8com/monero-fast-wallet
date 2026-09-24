import { readFileSync } from 'fs';
import { resolve } from 'path';

const mobileRoot = resolve(__dirname, '..', '..', '..');
const repoRoot = resolve(mobileRoot, '..', '..');
const source = (...parts: string[]) =>
  readFileSync(resolve(mobileRoot, ...parts), 'utf8');

describe('MFW name registration UI contract', () => {
  const home = source('src', 'screens', 'HomeScreen.tsx');
  const ticker = source('src', 'components', 'MfwNameTicker.tsx');
  const menu = source('src', 'screens', 'MenuScreen.tsx');
  const names = source('src', 'screens', 'MfwNamesScreen.tsx');
  const app = source('App.tsx');
  const lifecycleBanner = source(
    'src',
    'components',
    'MfwNameLifecycleBanner.tsx',
  );
  const localNotification = source(
    'android',
    'app',
    'src',
    'main',
    'java',
    'com',
    'monerowallet',
    'LocalPushNotificationModule.kt',
  );
  const send = source('src', 'screens', 'SendScreen.tsx');
  const navigation = source('src', 'navigation', 'TabNavigator.tsx');
  const registration = source('src', 'services', 'MfwNameRegistration.ts');
  const androidNative = source(
    'android',
    'app',
    'src',
    'main',
    'java',
    'com',
    'monerowallet',
    'NativeMoneroWalletModule.kt',
  );
  const manifest = JSON.parse(
    readFileSync(
      resolve(repoRoot, 'config', 'v1-release-features.json'),
      'utf8',
    ),
  );

  it('ships the explicitly release-gated registration screen with frozen parameters', () => {
    expect(ticker).toContain("t('mfwNames.claimYourAddress')");
    expect(home).not.toContain('nameClaimCard');
    expect(menu).toContain('v1ReleaseFeatures.mfwNameRegistration');
    expect(menu).toContain('"MfwNames", IcoKey');
    expect(navigation).toContain('name="MfwNames"');
    expect(manifest.features.mfwNameRegistration).toBe(true);
    expect(manifest.parameters.mfwNameGenesis.network).toBe('mainnet');
    expect(manifest.parameters.mfwNameGenesis.registryAddress).toBe(
      '49indexNameRuJZKgFL42yi11NgwYn3pzgf45HvvbEpCZq29KfQknnUM6xaptUokNsjh8TRghjr94ioSN2ZNhePm1vzJLQJ',
    );
    expect(manifest.parameters.mfwNameGenesis.maximumTermYears).toBe(1_000);
    expect(manifest.parameters.mfwNameResolverOrigins).toEqual([
      'http://fastrelayrpcf3hbc4qvykjgbpwpmcuq5dpcsdxoe7gwfh2zxdib3eid.onion',
      'http://quietportrpccujodzxhwcfefbmhftof5i6oiq7rrx5tnzna7rxirhqd.onion',
    ]);
    expect(manifest.parameters.mfwNameSuggestionOnionOrigins).toEqual([
      'http://fastrelayrpcf3hbc4qvykjgbpwpmcuq5dpcsdxoe7gwfh2zxdib3eid.onion',
    ]);
    expect(names).toContain('!v1ReleaseFeatures.mfwNameRegistration');
  });

  it('offers every stored wallet address and a dedicated privacy subaddress', () => {
    expect(names).toContain('loadWalletAddresses');
    expect(names).toContain('walletService.createSubaddress');
    expect(names).not.toContain("t('mfwNames.publicWarning')");
    expect(names).toContain("t('mfwNames.createDedicated')");
    expect(names).toContain("addressInputMode === 'manual'");
    expect(names).toContain('walletService.validateRecipientAddress');
  });

  it('documents and enforces the two-approval commit/reveal journey', () => {
    expect(names).toContain("t('mfwNames.twoApprovals')");
    expect(names).toContain("t('mfwNames.commitTitle')");
    expect(names).toContain("t('mfwNames.claimTitle')");
    expect(send).toContain('validateMfwNameSendPreset');
    expect(send).toContain("setStep('confirm')");
    expect(send).toContain("mfwNamePreset.kind === 'commit'");
    expect(send).toContain("mfwNamePreset?.kind === 'claim'");
    expect(names).toContain('getTransactionsForAllAccounts(session, 0)');
    expect(names).toContain("t('mfwNames.stepOneComplete')");
    expect(names).toContain("t('mfwNames.stepTwoReady')");
    expect(app).toContain('<MfwNameLifecycleBanner');
    expect(lifecycleBanner).toContain('scheduleMfwNameClaimReminder');
    expect(lifecycleBanner).toContain('notifyMfwNameClaimReady');
    expect(localNotification).toContain('fun schedule(');
    expect(localNotification).toContain('MfwClaimReminderReceiver');
  });

  it('opens the shared Ledger signing flow before native name preparation', () => {
    const firstPreparation = names.indexOf(
      'walletService.prepareMfwNameRegistration(signingSession',
    );
    expect(names).toContain('prepareWithSigningSession');
    expect(names).toContain('await connectLedgerForSigning({');
    expect(names).toContain('let ledgerHandoffCreated = false');
    expect(names).toContain('await restoreLedgerViewAfterSigning()');
    expect(names).toContain('<LedgerSigningModal');
    expect(firstPreparation).toBeGreaterThan(
      names.indexOf('const prepareWithSigningSession'),
    );
    expect(names).not.toContain(
      'walletService.prepareMfwNameRegistration(session,',
    );
    expect(names).not.toContain('walletService.prepareMfwNameClaim(session,');
    expect(names).not.toContain(
      'walletService.prepareMfwNameTransition(session,',
    );
  });

  it('keeps new registration lean and enforces the 1,000-year hard cap', () => {
    expect(names).toContain('type RegistrationStep = 1 | 2 | 3');
    expect(names).toContain('setRegistrationStep(2)');
    expect(names).toContain('setRegistrationStep(3)');
    expect(names).not.toContain('style={s.registrationSteps}');
    expect(names).not.toContain("t('mfwNames.selectedWallet'");
    expect(names).toContain('maxLength={4}');
    expect(registration).toContain(
      'export const MFW_NAME_MAX_TERM_YEARS = 1_000',
    );
  });

  it('shows at most three recent names and opens full details only on demand', () => {
    expect(names).toContain('loadMfwOwnedNames');
    expect(names).toContain('.slice(0, 3)');
    expect(names).toContain('visibleOwnedNames.map');
    expect(names).toContain("t('mfwNames.showMore')");
    expect(names).toContain('setSelectedOwnedNameId(record.id)');
    expect(names).toContain('[selectedOwnedName].map');
    expect(names).toContain('record.expiryHeight');
    expect(names).toContain('mfwNameRemainingDays');
    expect(names).toContain("t('mfwNames.expiryEstimate')");
  });

  it('requires quorum availability and offers complete active-name management', () => {
    expect(names).toContain('checkConfiguredMfwNameAvailability');
    expect(names).toContain('estimateMfwNameExpiryTimestampMs');
    expect(names).toContain("t('mfwNames.estimatedValidUntil')");
    expect(names).toContain("t('mfwNames.checkedChainTip')");
    expect(names).toContain("t('mfwNames.checkedAt')");
    expect(names).toContain("registeredWallet?.network ?? 'mainnet'");
    expect(names).not.toMatch(
      /!registeredWallet\s*\|\|[\s\S]{0,80}!v1ReleaseFeatures\.mfwNameRegistration/,
    );
    expect(names).toContain("availability.value.status !== 'available'");
    expect(names).toContain("record.ownerAuthority !== 'recovery-required'");
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

  it('backs up new owner authority before commit and restores public names by address', () => {
    expect(names).toContain('discoverConfiguredMfwNamesForAddresses');
    expect(names).toContain("ownerAuthority: 'recovery-required'");
    expect(names).toContain('walletService.exportMfwNameRecovery');
    expect(names).toContain("throw new Error(t('mfwNames.recoveryRequired'))");
    expect(androidNative).toContain('Intent.ACTION_CREATE_DOCUMENT');
    const exportResult = androidNative.slice(
      androidNative.indexOf('override fun onActivityResult'),
      androidNative.indexOf('override fun onNewIntent'),
    );
    expect(exportResult).toContain('output.write(bytes');
    expect(exportResult.indexOf('output.write(bytes')).toBeLessThan(
      exportResult.indexOf('promise.resolve(true)'),
    );
  });
});
