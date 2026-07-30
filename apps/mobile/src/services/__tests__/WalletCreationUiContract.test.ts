import { readFileSync } from 'fs';
import { resolve } from 'path';

const mobileRoot = resolve(__dirname, '..', '..', '..');
const source = (...parts: string[]) =>
  readFileSync(resolve(mobileRoot, ...parts), 'utf8');

describe('Wallet creation and existing-wallet UI contract', () => {
  const setup = source('src', 'screens', 'WalletSetupScreen.tsx');
  const service = source('src', 'services', 'WalletService.ts');
  const walletState = source('src', 'services', 'WalletState.tsx');
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
