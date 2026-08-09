import { readFileSync } from 'fs';
import { resolve } from 'path';

const mobileRoot = resolve(__dirname, '..', '..', '..');
const source = (...parts: string[]) =>
  readFileSync(resolve(mobileRoot, ...parts), 'utf8');

describe('Wallet dashboard interaction contract', () => {
  const repoRoot = resolve(mobileRoot, '..', '..');
  const home = source('src', 'screens', 'HomeScreen.tsx');
  const setup = source('src', 'screens', 'WalletSetupScreen.tsx');
  const wallets = source('src', 'screens', 'WalletsScreen.tsx');
  const receive = source('src', 'screens', 'ReceiveScreen.tsx');
  const selector = source('src', 'components', 'WalletSelector.tsx');
  const syncStatus = source('src', 'components', 'SyncStatusBar.tsx');
  const walletState = source('src', 'services', 'WalletState.tsx');
  const appSecurity = source('src', 'services', 'AppSecurity.tsx');
  const fastWalletPush = source('src', 'services', 'FastWalletPushService.ts');
  const priceService = source('src', 'data', 'priceService.ts');
  const walletServiceSource = source('src', 'services', 'WalletService.ts');
  const nativeWallet = source('src', 'services', 'NativeMoneroWallet.ts');
  const nativeAndroidBridge = source(
    'android',
    'app',
    'src',
    'main',
    'java',
    'com',
    'monerowallet',
    'NativeMoneroWalletModule.kt',
  );
  const walletEngine = readFileSync(
    resolve(repoRoot, 'native', 'monero-bridge', 'cpp', 'WalletEngine.cpp'),
    'utf8',
  );

  it('forwards every native shared-download cursor and throughput metric through Android', () => {
    const requiredFields = [
      'downloadStartHeight',
      'downloadedHeight',
      'lastNonEmptyBlockFetchMs',
      'lastNonEmptyBlockCount',
      'lastNonEmptyNetworkBytes',
      'lastNonEmptyPayloadBytes',
      'networkBytesReceived',
      'payloadBytesReceived',
    ];

    for (const field of requiredFields) {
      expect(nativeAndroidBridge).toContain(
        `putDouble("${field}", status.numberValue("${field}"))`,
      );
    }
  });

  it('selects a software wallet immediately while a cold local open finishes behind Home', () => {
    expect(home).toContain('void openRegisteredWalletById(walletId)');
    expect(home).toContain("if (wallet.kind !== 'hardware')");
    expect(home).toContain('Do not manufacture a loading phase');
    expect(home).not.toContain(
      'changedWallet && selectedWallet?.credentialKey',
    );
    expect(setup).toContain(
      'chooseSavedWallet(registeredWallet.id).catch(() => undefined)',
    );
    expect(setup).toContain('const isFocused = useIsFocused()');
    expect(setup).toMatch(
      /useEffect\(\(\) => \{\s+if \(!isFocused\) \{\s+return;/,
    );
    expect(wallets).toContain(
      "if (wallet.kind !== 'hardware' && wallet.credentialKey)",
    );
    expect(wallets).toContain(
      'const opening = openRegisteredWalletById(wallet.id)',
    );
    expect(wallets.indexOf("navigation.navigate('Home')")).toBeLessThan(
      wallets.indexOf('opening.catch'),
    );
    expect(wallets).toContain('accessibilityLabel={`Open ${title}`}');
    expect(wallets).toContain('accessibilityLabel={`Rename ${title}`}');
    expect(wallets).toContain('accessibilityLabel={`Remove ${title}`}');
    expect(wallets).toContain("navigation.navigate('Home')");
  });

  it('offers seed backup only for locally seeded wallets before removal', () => {
    expect(wallets).toContain('findPendingSeedBackupForRemoval');
    expect(wallets).toContain('backUpSeedBeforeRemoval');
    expect(wallets).toContain('backupRegisteredWalletSeed(');
    expect(wallets).toContain('walletRequiresRecoverySeedBackup(candidate)');
    expect(wallets).toContain('const needsSeedBackup =');
    expect(wallets).toContain("t('settings.showBackupSeed')");
    expect(wallets).toContain('confirmRemoveWallet(latestTarget, refreshed)');
  });

  it('cleans every in-memory session removed by a cascading Ledger deletion', () => {
    expect(walletState).toContain(
      'const removedWalletIds = walletsBeforeRemoval',
    );
    expect(walletState).toContain(
      'for (const removedWalletId of removedWalletIds)',
    );
    expect(walletState).toContain(
      'removedSessions.set(removedSession.walletId, removedSession)',
    );
  });

  it('deduplicates cold native opens and reserves card progress for hardware', () => {
    expect(walletState).toContain('walletOpenInFlightRef.current.get');
    expect(walletState).toContain('walletOpenInFlightRef.current.set');
    expect(home).toContain("if (wallet.kind !== 'hardware')");
    expect(selector).toContain('openingWalletId');
    expect(selector).toContain(
      '<ActivityIndicator color={colors.orange} size="small" />',
    );
  });

  it('keeps Add Wallet as the final dashboard carousel card', () => {
    expect(selector).toContain('onAdd?: () => void');
    expect(selector).toContain("t('action.addWallet')");
    expect(home).toContain("onAdd={() => navigation.navigate('WalletSetup')}");
  });

  it('opens wallet management from the All Wallets section header', () => {
    expect(selector).toContain('onManage?: () => void');
    expect(selector).toContain("accessibilityRole=\"link\"");
    expect(selector).toContain("t('wallets.manage')");
    expect(home).toContain("onManage={() => navigation.navigate('Wallets')}");
  });

  it('manages every native subaddress from the selected wallet', () => {
    expect(wallets).toContain("manageAddresses: true");
    expect(wallets).toContain("navigation.navigate('Receive'");
    expect(receive).toContain('route?.params?.manageAddresses === true');
    expect(receive).toContain('walletService.listSubaddresses(session)');
    expect(receive).toContain("t('receive.newAddressName')");
    expect(walletServiceSource).toContain("'listSubaddresses'");
    expect(walletServiceSource).toContain('requireNativeMoneroWallet().listSubaddresses');
    expect(nativeWallet).toContain('listSubaddresses(');
  });

  it('defers network refresh until the local open promise can release the UI', () => {
    expect(walletState).toContain('deferredNativeRefreshTimeoutsRef');
    expect(walletState).toContain(
      "startNativeRefresh(registeredSession, 'sessionOpenedDeferred')",
    );
    expect(walletState).not.toContain(
      "startNativeRefresh(registeredSession, 'sessionOpened');",
    );
  });

  it('includes Fast Wallets in the shared local sync after the app-wide unlock', () => {
    expect(walletState).toContain(
      'Fast Wallets are independent, recoverable local wallets.',
    );
    expect(walletState).toContain(
      'ensureRegisteredWalletOpen(registration, isActive, true)',
    );
    expect(walletState).toContain("registration.kind === 'fast'");
    expect(selector).toContain("badge: fastWallet");
    expect(selector).toContain("kind: fastWallet ? 'fast' : registration.kind");
    expect(selector).toContain('walletSnapshotStatusLabel(snapshot, t)');
  });

  it('keeps hardware status refresh stable so the five-second session poll cannot recreate itself', () => {
    const hardwareRefresh = walletState.slice(
      walletState.indexOf('const refreshHardwareWalletStatus = useCallback'),
      walletState.indexOf('const startNativeRefresh = useCallback'),
    );
    expect(hardwareRefresh).toContain('return hardwareStatusRef.current');
    expect(hardwareRefresh).toContain('hardwareStatusRef.current = nextStatus');
    expect(hardwareRefresh).toContain('}, []);');
    expect(hardwareRefresh).not.toContain('}, [hardwareStatus]);');
    expect(walletState).toContain("'openSessionPolling.started'");
    expect(walletState).toContain("'openSessionPolling.tick'");
    expect(walletState).toContain('setInterval(refreshOpenSessions, 5000)');
  });

  it('defers a Fast Wallet signal until the single app-wide lock is open', () => {
    expect(walletState).toContain("'incomingSignal.refresh.deferred'");
    expect(walletState).toContain('if (!appSecurityReady || appSecurityLocked)');
    expect(walletState).toContain("reason: !appSecurityReady ? 'appSecurityNotReady' : 'appLocked'");
  });

  it('does not turn protected Fast Wallet metadata into a startup error', () => {
    expect(fastWalletPush).toContain('registration.refreshDeferred');
    expect(fastWalletPush).toContain('if (!protection || protection.locked)');
    expect(appSecurity).toContain(
      'void FastWalletPushService.refreshRegistrationQuietly()',
    );
  });

  it('commits cached selection before serialized registry persistence', () => {
    const activation = walletState.slice(
      walletState.indexOf('const activateRegisteredWallet ='),
      walletState.indexOf('const removeRegisteredWallet ='),
    );
    expect(activation).toContain('activeWalletPersistenceRef.current');
    expect(activation).toContain('activeWalletSelectionGenerationRef.current');
    expect(activation.indexOf('setRegisteredWallet(optimisticWallet)')).toBeLessThan(
      activation.indexOf('const persistSelection ='),
    );
    expect(activation.indexOf('setSnapshot(walletSnapshotsRef.current[walletId])')).toBeLessThan(
      activation.indexOf('walletService.setActiveRegisteredWallet(walletId)'),
    );
  });

  it('uses only the cached TEX8 public-content API', () => {
    expect(priceService).toContain('const REQUEST_TIMEOUT_MS = 6_000');
    expect(priceService).toContain('const PRICE_CACHE_KEY');
    expect(priceService).toContain(
      "const TEX8_MARKET_BASE = 'https://xmr.tex8.com/api/v1/market'",
    );
    expect(priceService).toContain('await fetchPriceFromTex8()');
    expect(priceService).toContain('await fetchTex8Chart(tf)');
    expect(priceService).not.toContain('api.coingecko.com');
    expect(priceService).not.toContain('api-pub.bitfinex.com');
    expect(priceService).toContain('loadPersistedPrice()');
    expect(home).toContain("t('home.priceUnavailable')");
  });

  it('keeps separate blockchain and wallet progress visible through completion', () => {
    expect(syncStatus).toContain('testID="blockchain-progress"');
    expect(syncStatus).toContain('testID="wallet-progress"');
    expect(syncStatus).toContain('const blockchainProgress =');
    expect(syncStatus).toContain('const walletProgress =');
    expect(syncStatus).toContain('const blockchainCurrent =');
    expect(syncStatus).toContain('network.ready ? 100 : network.progress ?? 0');
    expect(syncStatus).toContain('network.downloadedHeight');
    expect(syncStatus).toContain(': network.chainHeight');
    expect(syncStatus).toContain('target={network.targetHeight}');
    expect(syncStatus).toContain('t("sync.startingConnectionElapsed"');
    expect(syncStatus).toContain('seconds: connectionElapsedSeconds');
    expect(syncStatus).toContain('const connectionElapsedSeconds = useElapsedSeconds(');
    expect(syncStatus).toContain('extra={blockchainExtra}');
    expect(syncStatus).toContain('t("sync.blockHeight"');
    expect(syncStatus).toContain('const showWalletSync = connected && walletOpened');
    expect(syncStatus).toContain('{showWalletSync ? (');
  });

  it('counts every Monero account once and exports Ledger read access on demand', () => {
    expect(walletEngine).toContain('wallet->numSubaddressAccounts()');
    expect(walletEngine).toContain('next.balanceAtomic += balance');
    expect(walletEngine).toContain('next.unlockedBalanceAtomic += unlocked');
    expect(walletEngine).not.toContain('next.balanceAtomic = wallet->balance(0)');
    expect(home).toContain('const activeWalletSnapshot = registeredWallet');
    expect(home).toContain('walletSnapshotMap[registeredWallet.id]');
    expect(home).toContain('const totalBalanceAtomic = toAtomicBigInt(activeWalletSnapshot?.balanceAtomic)');
    expect(home).toContain('activeWalletSnapshot?.pendingOutputKeyImageCount');
    expect(walletServiceSource).toContain('enableLedgerReadOnlyCompanion');
    expect(walletState).toContain(
      'await walletService.enableLedgerReadOnlyCompanion(activeRegistration)',
    );
  });

  it('opens sync details by default while working and collapses after completion', () => {
    expect(syncStatus).toContain('const fullySynced =');
    expect(syncStatus).toContain('React.useState(() => !fullySynced)');
    expect(syncStatus).toContain('!previous.fullySynced && fullySynced');
    expect(syncStatus).toContain('updateExpanded(false)');
    expect(syncStatus).toContain('testID="sync-status-toggle"');
    expect(syncStatus).toContain('accessibilityState={{ expanded }}');
    expect(syncStatus).toContain('testID="sync-status-details"');
    expect(home).toContain('testID="header-sync-status-toggle"');
    expect(home).toContain('expanded={syncStatusExpanded}');
    expect(home).toContain('onExpandedChange={setSyncStatusExpanded}');
  });

  it('automatically reconciles a remembered Ledger and reserves the button for enrollment', () => {
    expect(walletState).toContain("'ledgerAutoVerification.start'");
    expect(walletState).toContain('await walletService.getLedgerTransportStatus()');
    expect(walletState).toContain('await walletService.requestLedgerTransportAccess()');
    expect(walletState).toContain('await reconcileLedgerBalance()');
    expect(home).toContain('activeWalletSnapshot?.pendingOutputKeyImageCount');
  });

  it('reconciles inactive Ledger companions sequentially without replacing the selected wallet', () => {
    expect(walletState).toContain('ledgerBackgroundReconciliationInFlightRef');
    expect(walletState).toContain("'ledgerBackgroundVerification.start'");
    expect(walletState).toContain('preserveActiveSession: true');
    expect(walletState).toContain('closeViewSessionWhenComplete: true');
    expect(walletServiceSource).toContain('preserveActiveSession?: boolean');
    expect(walletServiceSource).toContain('this.activeSession = { ...previousSession }');
  });

  it('keeps node health global and transient snapshot reads off wallet cards', () => {
    expect(home).not.toContain('nodeConnectionStatus={nodeConnectionStatus}');
    expect(home).not.toContain('error={error}');
    expect(selector).not.toContain("t('sync.connectingNode')");
    expect(selector).not.toContain("t('walletSelector.openToCheckNode')");
    expect(selector).toContain("t('walletSelector.waitingSharedBlocks')");
    expect(walletState).toContain('cacheRetained: Boolean(');
    const refreshErrorIndex = walletState.indexOf(
      "logWalletEvent('WalletState', 'refreshSnapshot.error'",
    );
    const snapshotCatch = walletState.slice(
      refreshErrorIndex - 450,
      refreshErrorIndex + 500,
    );
    expect(snapshotCatch).not.toContain('setError(');
  });
});
