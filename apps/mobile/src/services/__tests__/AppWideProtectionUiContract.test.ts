import {readFileSync} from 'fs';
import {resolve} from 'path';

const mobileRoot = resolve(__dirname, '..', '..', '..');
const setupSource = readFileSync(
  resolve(mobileRoot, 'src', 'screens', 'WalletSetupScreen.tsx'),
  'utf8',
);
const walletsSource = readFileSync(
  resolve(mobileRoot, 'src', 'screens', 'WalletsScreen.tsx'),
  'utf8',
);
const appSecuritySource = readFileSync(
  resolve(mobileRoot, 'src', 'services', 'AppSecurity.tsx'),
  'utf8',
);
const androidNativeSource = readFileSync(
  resolve(
    mobileRoot,
    'android',
    'app',
    'src',
    'main',
    'java',
    'com',
    'monerowallet',
    'NativeMoneroWalletModule.kt',
  ),
  'utf8',
);
const iosNativeSource = readFileSync(
  resolve(
    mobileRoot,
    'ios',
    'MoneroWallet',
    'NativeMoneroWallet',
    'RCTNativeMoneroWallet.mm',
  ),
  'utf8',
);

describe('app-wide protection UI contract', () => {
  it('never renders an individual wallet password field while opening a wallet', () => {
    expect(setupSource).not.toContain('value={walletPassword}');
    expect(setupSource).not.toContain('openRegisteredWallet(walletPassword)');
    expect(setupSource).toContain("setPasswordPromptMode('restore')");
  });

  it('requires the stored device credential for Fast Wallet management', () => {
    expect(walletsSource).toContain('hasSecureWalletCredential');
    expect(walletsSource).not.toContain("t('settings.walletPassword')");
    expect(walletsSource).not.toContain('password: needsPassword');
  });

  it('makes app protection mandatory and enforces it in native code', () => {
    expect(appSecuritySource).toContain(
      "export type AppProtectionMode = 'biometric' | 'password'",
    );
    expect(appSecuritySource).not.toContain(
      "export type AppProtectionMode = 'none'",
    );
    expect(appSecuritySource).toContain('password.length < 12');
    expect(appSecuritySource).toContain('getAppProtectionStatus');
    expect(appSecuritySource).toContain('walletService.unlockApp');
    expect(appSecuritySource).not.toContain('PROTECTION_PASSWORD_KEY');
    expect(appSecuritySource).toContain('setLocked(true)');
    expect(appSecuritySource).toContain(
      'accessibilityElementsHidden={protectedContentHidden}',
    );
    expect(appSecuritySource).toContain(
      "protectedContentHidden ? 'no-hide-descendants' : 'auto'",
    );
    expect(appSecuritySource).toContain('pointerEvents={protectedContentHidden');
    expect(appSecuritySource).toContain(
      "protectedContentHidden: { display: 'none' }",
    );
    expect(androidNativeSource).toContain('requireAppAuthorized');
    expect(androidNativeSource).toContain('recordNativeUnlockFailure');
    expect(androidNativeSource).toContain('Argon2Mode.ARGON2_ID');
    expect(androidNativeSource).toContain('PBKDF2WithHmacSHA256');
    expect(iosNativeSource).toContain('requireAppAuthorized');
    expect(iosNativeSource).toContain('recordNativeUnlockFailure');
    expect(iosNativeSource).toContain('crypto_pwhash_argon2id_str');
    expect(iosNativeSource).toContain('CCKeyDerivationPBKDF');
  });
});
