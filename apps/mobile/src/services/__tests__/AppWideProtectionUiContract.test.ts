import { readFileSync } from 'fs';
import { resolve } from 'path';

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
const walletStateSource = readFileSync(
  resolve(mobileRoot, 'src', 'services', 'WalletState.tsx'),
  'utf8',
);
const appSource = readFileSync(resolve(mobileRoot, 'App.tsx'), 'utf8');
const tabNavigatorSource = readFileSync(
  resolve(mobileRoot, 'src', 'navigation', 'TabNavigator.tsx'),
  'utf8',
);
const scannerSource = readFileSync(
  resolve(mobileRoot, 'src', 'components', 'RecipientQrScanner.tsx'),
  'utf8',
);
const discoverySource = readFileSync(
  resolve(mobileRoot, 'src', 'services', 'EnthusiastDiscoveryService.ts'),
  'utf8',
);
const pushSource = readFileSync(
  resolve(mobileRoot, 'src', 'services', 'FastWalletPushService.ts'),
  'utf8',
);
const contactsSource = readFileSync(
  resolve(mobileRoot, 'src', 'services', 'PrivatePhoneDeviceContacts.ts'),
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
const androidActivitySource = readFileSync(
  resolve(
    mobileRoot,
    'android',
    'app',
    'src',
    'main',
    'java',
    'com',
    'monerowallet',
    'MainActivity.kt',
  ),
  'utf8',
);
const androidSystemUiSource = readFileSync(
  resolve(
    mobileRoot,
    'android',
    'app',
    'src',
    'main',
    'java',
    'com',
    'monerowallet',
    'NativeSystemUiInterruption.kt',
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
    expect(appSecuritySource).toContain(
      'InteractionManager.runAfterInteractions',
    );
    expect(appSecuritySource).toContain(
      "if (AppState.currentState === 'active')",
    );
    expect(appSecuritySource).toContain('automaticBiometricPending');
    expect(appSecuritySource).toContain("setLocked(nextMode === 'biometric')");
    expect(appSecuritySource).toContain('setAutomaticBiometricPending(true)');
    expect(appSecuritySource).toContain('await walletService.lockApp()');
    expect(appSecuritySource).toContain(
      "onboardingStage === 'welcome'",
    );
    expect(appSecuritySource).toContain('<InitialProtectionWelcome');
    expect(appSecuritySource).toContain(
      'const canMountProtectedContent = ready && configured',
    );
    expect(appSecuritySource).toContain(
      '{canMountProtectedContent ? (',
    );
    expect(tabNavigatorSource).toContain(
      'status === "empty" || status === "error"',
    );
    expect(tabNavigatorSource).toContain('? "WalletSetup"');
    expect(tabNavigatorSource).toContain('"walletScreen.presented"');
    expect(tabNavigatorSource).toContain('!appSecurityLocked');
    expect(walletStateSource).toContain(
      "logWalletEvent('WalletState', 'appSecurity.persistWallets.start'",
    );
    expect(walletStateSource).toContain(
      'if (!appSecurityReady || appSecurityLocked)',
    );
    expect(appSecuritySource).not.toContain('PROTECTION_PASSWORD_KEY');
    expect(appSecuritySource).toContain('setLocked(true)');
    expect(appSecuritySource).toContain(
      'accessibilityElementsHidden={protectedContentHidden}',
    );
    expect(appSecuritySource).toContain(
      "protectedContentHidden ? 'no-hide-descendants' : 'auto'",
    );
    expect(appSecuritySource).toContain(
      'pointerEvents={protectedContentHidden',
    );
    expect(appSecuritySource).toContain(
      "protectedContentHidden: { display: 'none' }",
    );
    expect(appSecuritySource).toContain(
      'visible={securityModalVisible}',
    );
    expect(appSecuritySource).toContain(
      'onRequestClose={() => undefined}',
    );
    expect(appSecuritySource).toContain(
      'securityModal: { flex: 1, backgroundColor: colors.bg }',
    );
    expect(androidNativeSource).toContain('requireAppAuthorized');
    expect(androidNativeSource).toContain('recordNativeUnlockFailure');
    expect(androidNativeSource).toContain(
      'private const val MAX_APP_PASSWORD_ATTEMPTS = 3',
    );
    expect(androidNativeSource).toContain(
      'activityManager.clearApplicationUserData()',
    );
    expect(androidNativeSource).toContain('APP_SECURITY_RESET_REQUIRED_KEY');
    expect(androidNativeSource).toContain('Argon2Mode.ARGON2_ID');
    expect(androidNativeSource).toContain('PBKDF2WithHmacSHA256');
    expect(androidNativeSource).toContain(
      'if (currentMode == mode && mode == "biometric")',
    );
    expect(androidNativeSource).toMatch(
      /if \(mode == "biometric"\)[\s\S]+?authorizeAppOnSuccess = true,[\s\S]+?allowDeviceCredential = false/,
    );
    expect(iosNativeSource).toContain('requireAppAuthorized');
    expect(iosNativeSource).toContain('recordNativeUnlockFailure');
    expect(iosNativeSource).toContain(
      'constexpr NSInteger kMaxAppPasswordAttempts = 3',
    );
    expect(iosNativeSource).toContain('scheduleApplicationDataReset');
    expect(iosNativeSource).toContain('kAppSecurityResetRequiredKey');
    expect(iosNativeSource).toContain(
      'deleteKeychainSecretsWithPrefixes(@[@""])',
    );
    expect(iosNativeSource).toContain('crypto_pwhash_argon2id_str');
    expect(iosNativeSource).toContain('CCKeyDerivationPBKDF');
  });

  it('does not force a credential-backed wallet through Wallet Setup after app unlock', () => {
    const redirectPredicate =
      appSource.match(/const requiresVisibleUnlock =([\s\S]+?);\n/)?.[1] ?? '';
    expect(redirectPredicate).toContain(
      "registeredWallet.kind === 'hardware'",
    );
    expect(redirectPredicate).toContain('!registeredWallet.credentialKey');
    expect(redirectPredicate).not.toContain('unlockRequestId');
  });

  it('does not mistake bounded operating-system permission sheets for leaving the wallet', () => {
    expect(appSecuritySource).toContain(
      'activeSystemUiInterruptionDeadlineMs',
    );
    expect(appSecuritySource).toContain('appState.lockDeferred');
    expect(appSecuritySource).toContain('system-ui-timeout');
    expect(appSecuritySource).toContain(
      'recentlyCompletedSystemUiInterruption',
    );
    expect(appSecuritySource).toContain(
      "commitBackgroundLock('system-ui-expired-on-resume')",
    );
    expect(walletStateSource).toContain(
      'appBackground.persistWallets.deferred',
    );
    expect(walletStateSource).toContain(
      'activeSystemUiInterruptionDeadlineMs()',
    );
    expect(setupSource).toContain(
      "withSystemUiInterruption(\n            'ledger-transport-permission'",
    );
    expect(scannerSource).toContain("'camera-permission'");
    expect(discoverySource).toContain("'location-permission'");
    expect(pushSource).toContain("'notification-permission'");
    expect(pushSource).toMatch(
      /try \{\s+\/\/ Protected metadata[\s\S]+?await getStoredSubscriptionId\(\)/,
    );
    expect(contactsSource).toContain("'contacts-permission'");
    expect(androidNativeSource).toContain(
      'override fun beginSystemUiInterruption',
    );
    expect(androidNativeSource).toContain(
      'override fun endSystemUiInterruption',
    );
    expect(androidActivitySource).toContain(
      'NativeSystemUiInterruption.remainingMs()',
    );
    expect(androidActivitySource).toContain(
      'activityPause.systemUiDeferred',
    );
    expect(androidActivitySource).toContain(
      'commitNativePauseLock("app-background")',
    );
    expect(androidSystemUiSource).toContain(
      'private const val MAX_TIMEOUT_MS = 45_000L',
    );
    expect(androidSystemUiSource).toContain(
      'val token = "sui_${nextToken++}"',
    );
  });
});
