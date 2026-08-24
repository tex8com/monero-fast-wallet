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
const appVaultStateMachineSource = readFileSync(
  resolve(
    mobileRoot,
    '..',
    '..',
    'packages',
    'wallet-shared',
    'src',
    'appVaultStateMachine.ts',
  ),
  'utf8',
);
const walletStateSource = readFileSync(
  resolve(mobileRoot, 'src', 'services', 'WalletState.tsx'),
  'utf8',
);
const walletServiceSource = readFileSync(
  resolve(mobileRoot, 'src', 'services', 'WalletService.ts'),
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

  it('uses the one app-wide vault instead of per-wallet credentials', () => {
    expect(walletsSource).toContain('backupRegisteredWalletSeed');
    expect(walletsSource).not.toContain("t('settings.walletPassword')");
    expect(walletsSource).not.toContain('password: needsPassword');
    expect(walletsSource).not.toContain('hasSecureWalletCredential');
  });

  it('keeps one app-wide vault while allowing protection to be skipped once', () => {
    expect(appSecuritySource).toContain(
      "export type AppProtectionMode = 'biometric' | 'none' | 'password'",
    );
    expect(appSecuritySource).toContain("await onConfigure('none')");
    expect(appSecuritySource).toContain('testID="app-security-skip"');
    expect(androidNativeSource).toContain('mode == "none"');
    expect(iosNativeSource).toContain('[mode isEqualToString:@"none"]');
    expect(appSecuritySource).toMatch(
      /validateRecoveryPassword\(password(?:\s*\?\?\s*['"]{2})?\)/,
    );
    expect(appVaultStateMachineSource).toContain(
      'MFW_APP_VAULT_PASSWORD_MINIMUM_CHARACTERS',
    );
    expect(appSecuritySource).toContain('getAppProtectionStatus');
    expect(appSecuritySource).toContain('walletService.unlockApp');
    expect(walletServiceSource).toContain(
      "logWalletEvent('WalletService', 'unlockApp.complete'",
    );
    expect(walletServiceSource).toContain(
      'private appUnlockInFlight?: Promise<BiometricAuthResult>',
    );
    expect(walletServiceSource).toContain(
      "logWalletEvent('WalletService', 'unlockApp.coalesced'",
    );
    expect(walletServiceSource).toContain(
      'if (this.appUnlockInFlight === pending)',
    );
    expect(walletServiceSource).toContain('authorized: result.success');
    expect(walletServiceSource).not.toContain(
      "traceWalletOperation(\n      'unlockApp'",
    );
    expect(appSecuritySource).toContain('queueMicrotask');
    expect(appSecuritySource).not.toContain(
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
      "onboardingComplete: onboardingStage === 'protection'",
    );
    expect(appSecuritySource).toContain("presentation === 'welcome'");
    expect(appSecuritySource).toContain('<InitialProtectionWelcome');
    expect(appSecuritySource).toContain('ready && configured && !locked');
    expect(appSecuritySource).not.toContain('securityResetInProgress');
    expect(appSecuritySource).toContain('{canMountProtectedContent ? (');
    expect(tabNavigatorSource).toContain(
      'status === "empty" || status === "error"',
    );
    expect(tabNavigatorSource).toContain('? "WalletSetup"');
    expect(tabNavigatorSource).toContain('"walletScreen.presented"');
    expect(tabNavigatorSource).toContain('!appSecurityLocked');
    expect(walletStateSource).toContain(
      "'appBackground.sessionRetainedUntilTimeout'",
    );
    expect(walletStateSource).toContain("'unmount.nativeLockOwnsPersistence'");
    expect(walletStateSource).toContain(
      'walletService.clearSessionReferencesAfterAppLock()',
    );
    expect(walletStateSource).not.toContain('closeSessionsInOrder');
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
    expect(appSecuritySource).toContain('visible={securityModalVisible}');
    expect(appSecuritySource).toContain('{inlineSecuritySurfaceVisible ? (');
    expect(appSecuritySource).toContain('<View style={styles.securityRoot}>');
    expect(appSecuritySource).toContain(
      '<View style={styles.inlineSecuritySurface}>{securitySurface}</View>',
    );
    expect(appSecuritySource).toContain(
      'protectedContentEverMountedRef.current',
    );
    expect(appSecuritySource).toContain('onRequestClose={() => undefined}');
    expect(appSecuritySource).toContain(
      'securityModal: { flex: 1, backgroundColor: colors.bg }',
    );
    expect(androidNativeSource).toContain('requireAppAuthorized');
    expect(androidNativeSource).toContain('recordNativeUnlockFailure');
    expect(androidNativeSource).toContain(
      'private fun unlockDelaySeconds(failures: Int)',
    );
    expect(androidNativeSource).toContain(
      'activity.lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED)',
    );
    expect(androidNativeSource).toContain('activity.window.decorView.isShown');
    expect(androidNativeSource).not.toContain(
      'Lifecycle.State.RESUMED) && activity.hasWindowFocus()',
    );
    expect(androidNativeSource).not.toContain('clearApplicationUserData()');
    expect(androidNativeSource).not.toContain('scheduleApplicationDataReset');
    expect(androidNativeSource).not.toContain('markSecurityResetRequired');
    expect(androidNativeSource).toContain('Argon2Mode.ARGON2_ID');
    expect(androidNativeSource).toContain('PBKDF2WithHmacSHA256');
    expect(androidNativeSource).toContain(
      'storeSecretValue(APP_PASSWORD_VERIFIER_KEY, createPasswordVerifier(password))',
    );
    expect(androidNativeSource).toContain(
      'if (mode == "biometric" && password.isEmpty())',
    );
    expect(androidNativeSource).toMatch(
      /if \(mode == "biometric" && password\.isEmpty\(\)\)[\s\S]+?authorizeAppOnSuccess = true,[\s\S]+?allowDeviceCredential = true/,
    );
    expect(androidNativeSource).toContain(
      'BIOMETRIC_STRONG or\n            BiometricManager.Authenticators.DEVICE_CREDENTIAL',
    );
    expect(iosNativeSource).toContain('requireAppAuthorized');
    expect(iosNativeSource).toContain('recordNativeUnlockFailure');
    expect(iosNativeSource).toContain(
      'uint64_t nativeUnlockDelaySeconds(NSInteger failures)',
    );
    expect(iosNativeSource).not.toContain('scheduleApplicationDataReset');
    expect(iosNativeSource).not.toContain('markAppSecurityResetRequired');
    expect(iosNativeSource).not.toContain(
      'deleteKeychainSecretsWithPrefixes(@[@""])',
    );
    expect(iosNativeSource).toContain('crypto_pwhash_argon2id_str');
    expect(iosNativeSource).toContain('CCKeyDerivationPBKDF');
  });

  it('reopens every stored wallet after the single app unlock without a per-wallet unlock screen', () => {
    expect(appSource).not.toContain('WalletUnlockRedirect');
    expect(appSource).not.toContain("mode: 'open'");
    expect(walletStateSource).toContain(
      'canOpenRegisteredWalletAutomatically',
    );
    expect(walletStateSource).toContain('const maxAttempts = isActive ? 3 : 2');
    expect(walletStateSource).toContain("'warmWallet.retryScheduled'");
    expect(walletStateSource).toContain("'warmWallet.allOpen'");
    expect(walletStateSource).toContain("return 'opening';");
    expect(walletStateSource).not.toContain("return 'locked';");
  });

  it('does not mistake bounded operating-system permission sheets for leaving the wallet', () => {
    expect(appSecuritySource).toContain('activeSystemUiInterruptionDeadlineMs');
    expect(appSecuritySource).toContain('appState.lockDeferred');
    expect(appSecuritySource).toContain('appState.alreadyLocked');
    expect(appSecuritySource).toContain('if (locked)');
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
    expect(setupSource).toMatch(
      /withSystemUiInterruption\(\s*['"]ledger-transport-permission['"]/,
    );
    expect(scannerSource).toContain("'camera-permission'");
    expect(discoverySource).toContain("'location-permission'");
    expect(pushSource).toContain("'notification-permission'");
    const protectionGuard = pushSource.indexOf('.getAppProtectionStatus()');
    const protectedMetadataRead = pushSource.indexOf(
      'await getStoredSubscriptionId()',
      protectionGuard,
    );
    expect(protectionGuard).toBeGreaterThanOrEqual(0);
    expect(protectedMetadataRead).toBeGreaterThan(protectionGuard);
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
    expect(androidActivitySource).toContain('activityPause.systemUiDeferred');
    expect(androidActivitySource).toContain(
      'NativeMoneroWalletModule.notifyAppBackgrounded()',
    );
    expect(androidActivitySource).toContain(
      'commitNativeDeviceLock("device-lock")',
    );
    expect(walletStateSource).toContain(
      'appBackground.sessionRetainedUntilTimeout',
    );
    expect(androidSystemUiSource).toContain(
      'private const val MAX_TIMEOUT_MS = 45_000L',
    );
    expect(androidSystemUiSource).toContain('val token = "sui_${nextToken++}"');
    expect(iosNativeSource).toContain(
      '- (void)beginSystemUiInterruption:(NSString *)reason',
    );
    expect(iosNativeSource).toContain(
      '- (void)endSystemUiInterruption:(NSString *)token',
    );
    expect(iosNativeSource).toContain('MIN(45000.0, MAX(1.0, timeoutMs))');
  });
});
