import { readFileSync } from 'fs';
import { resolve } from 'path';

const mobileRoot = resolve(__dirname, '..', '..', '..');
const source = (...parts: string[]) =>
  readFileSync(resolve(mobileRoot, ...parts), 'utf8');

describe('Wallet creation and existing-wallet UI contract', () => {
  const setup = source('src', 'screens', 'WalletSetupScreen.tsx');
  const welcome = source('src', 'screens', 'WelcomeScreen.tsx');
  const service = source('src', 'services', 'WalletService.ts');
  const walletState = source('src', 'services', 'WalletState.tsx');
  const walletCore = source(
    '..',
    '..',
    'native',
    'monero-bridge',
    'cpp',
    'WalletEngine.cpp',
  );
  const android = source(
    'android',
    'app',
    'src',
    'main',
    'java',
    'com',
    'monerowallet',
    'NativeMoneroWalletModule.kt',
  );
  const ios = source(
    'ios',
    'MoneroWallet',
    'NativeMoneroWallet',
    'RCTNativeMoneroWallet.mm',
  );

  it('keeps Create Wallet available independently of saved wallets', () => {
    const carousel = setup.indexOf('registeredWallets.map');
    const createAction = setup.indexOf("title={t('action.createWallet')}");

    expect(carousel).toBeGreaterThan(0);
    expect(createAction).toBeGreaterThan(carousel);
    expect(setup.slice(carousel, createAction)).toContain('</ScrollView>');
    expect(setup).toContain("t('setup.existingWallets')");
  });

  it('restores the privacy choice and per-wallet Fast Wallet switch', () => {
    expect(welcome).toContain("t('welcome.privacyOnly')");
    expect(welcome).toContain("t('welcome.privacyComfort')");
    expect(welcome).toContain('continueToSetup(false)');
    expect(welcome).toContain('continueToSetup(true)');
    expect(welcome).toContain('fastWalletEnabled');
    expect(setup).toContain("t('setup.fastWalletToggle')");
    expect(setup).toContain('<Switch');
    expect(setup).toContain('value={fastWalletEnabled}');
    expect(setup).toContain('onValueChange={changeFastWalletEnabled}');
    expect(setup).toContain("createSelectedFastWallet('software')");
    expect(setup).toContain("createSelectedFastWallet('restore')");
    expect(setup).not.toContain('createSelectedFastWallet(\'hardware\')');
  });

  it('never lets daemon startup block the primary recovery-seed backup', () => {
    const createStart = setup.indexOf(
      'const startCreateWalletWithDeviceSecret = async () =>',
    );
    const createEnd = setup.indexOf(
      'const startRestoreWallet = async () =>',
      createStart,
    );
    const createFlow = setup.slice(createStart, createEnd);
    const initialRegistration = createFlow.indexOf('startNetwork: false');
    const seedPresentation = createFlow.indexOf(
      'walletService.presentRecoverySeed',
    );
    const deferredNetworkStart = createFlow.indexOf('startNetwork: true');

    expect(createStart).toBeGreaterThan(0);
    expect(createEnd).toBeGreaterThan(createStart);
    expect(initialRegistration).toBeGreaterThan(0);
    expect(seedPresentation).toBeGreaterThan(initialRegistration);
    expect(deferredNetworkStart).toBeGreaterThan(seedPresentation);
  });

  it('shows transfer and confirmed acceptance while enrolling a Fast Wallet', () => {
    const enrollmentStart = setup.indexOf(
      "setFastWalletTransferStatus('transferring')",
    );
    const enrollment = setup.indexOf(
      'walletService.enableEncryptedFastWalletAlerts',
      enrollmentStart,
    );
    const accepted = setup.indexOf(
      "setFastWalletTransferStatus('accepted')",
      enrollment,
    );

    expect(enrollmentStart).toBeGreaterThan(0);
    expect(enrollment).toBeGreaterThan(enrollmentStart);
    expect(accepted).toBeGreaterThan(enrollment);
    expect(setup).toContain('s.fastWalletTransferLedTransferring');
    expect(setup).toContain('s.fastWalletTransferLedAccepted');
    expect(setup).toContain("t('setup.fastWalletTransferSending')");
    expect(setup).toContain("t('setup.fastWalletTransferAccepted')");
  });

  it('keeps fresh-wallet daemon initialization local and non-blocking', () => {
    const helperStart = walletCore.indexOf(
      'void setEstimatedRefreshHeightForNewWallet',
    );
    const helperEnd = walletCore.indexOf(
      'uint64_t fastReceiveDerivationIndexFromId',
      helperStart,
    );
    const helper = walletCore.slice(helperStart, helperEnd);

    expect(helperStart).toBeGreaterThan(0);
    expect(helperEnd).toBeGreaterThan(helperStart);
    expect(helper).toContain('wallet->getRefreshFromBlockHeight()');
    expect(helper).toContain('wallet->setRecoveringFromSeed(true)');
  });

  it('renders saved wallets as a snapping horizontal slider', () => {
    expect(setup).toMatch(
      /<ScrollView[\s\S]+horizontal[\s\S]+snapToInterval=\{206\}/,
    );
    expect(setup).toContain('registeredWallets.map');
    expect(setup).toContain('chooseSavedWallet(wallet.id)');
    expect(setup).toContain(
      'const openOperation = openRegisteredWalletById(walletId)',
    );
    expect(setup).toContain('openingWalletId === wallet.id');
    expect(setup).toContain("t('setup.step.openingWallet')");
    expect(setup).toContain('setWalletOpenError(message)');
    expect(setup).toContain('accessibilityLiveRegion="assertive"');
    expect(
      setup.indexOf(
        'const openOperation = openRegisteredWalletById(walletId)',
      ),
    ).toBeLessThan(setup.indexOf("navigation.navigate('Home')"));
    expect(setup).toContain('WALLET_OPEN_TIMEOUT_MS');
    expect(setup).toContain('openingElapsedSeconds');
  });

  it('opens only the wallet explicitly selected by the owner', () => {
    expect(walletState).not.toContain("'autoOpen.start'");
    expect(walletState).not.toContain("'autoOpen.success'");
    expect(walletState).toContain('openById.native.start');
    expect(walletState).toContain('openById.native.success');
  });

  it('checks native wallet and sidecar files before choosing a name', () => {
    expect(service).toContain('nativeWallet.walletPathOccupied(path)');
    for (const platformSource of [android, ios]) {
      expect(platformSource).toContain('walletPathOccupied');
      expect(platformSource).toContain('.keys');
      expect(platformSource).toContain('.address.txt');
      expect(platformSource).toContain('.lock');
      expect(platformSource).toContain(
        'outside the protected app wallet directory',
      );
    }
  });

  it('re-registers only wallets with a matching device-held credential', () => {
    expect(service).toContain('recoverUnregisteredWallets');
    expect(service).toContain('nativeWallet.listWalletNames(network)');
    expect(service).toContain(
      'nativeWallet.walletSecretExists(softwareCredentialKey)',
    );
    expect(service).toContain(
      'nativeWallet.walletSecretExists(hardwareCredentialKey)',
    );
    expect(service).not.toContain('ensureSecret(softwareCredentialKey)');
    expect(walletState.indexOf('recoverUnregisteredWallets()')).toBeLessThan(
      walletState.indexOf('walletService.loadRegisteredWallet()'),
    );
    for (const platformSource of [android, ios]) {
      expect(platformSource).toContain('listWalletNames');
      expect(platformSource).toContain('walletSecretExists');
    }
  });
});
