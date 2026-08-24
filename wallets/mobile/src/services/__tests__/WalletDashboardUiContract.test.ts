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
  const settings = source('src', 'screens', 'SettingsScreen.tsx');
  const send = source('src', 'screens', 'SendScreen.tsx');
  const syncStatus = source('src', 'components', 'SyncStatusBar.tsx');
  const appTopBar = source('src', 'components', 'AppTopBar.tsx');
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
  const ledgerBleTransport = source(
    'android',
    'app',
    'src',
    'main',
    'java',
    'com',
    'monerowallet',
    'LedgerBleTransport.kt',
  );
  const nativeAndroidJni = source(
    'android',
    'app',
    'src',
    'main',
    'cpp',
    'NativeMoneroWalletJni.cpp',
  );
  const walletEngine = readFileSync(
    resolve(repoRoot, 'native', 'monero-bridge', 'cpp', 'WalletEngine.cpp'),
    'utf8',
  );
  const ledgerNodeRetryPatch = readFileSync(
    resolve(
      repoRoot,
      'third_party',
      'monero-patches',
      '0087-wallet-batch-ledger-history-and-retry-node-only.patch',
    ),
    'utf8',
  );

  it('forwards every native shared-download cursor and throughput metric through Android', () => {
    const requiredFields = [
      'downloadStartHeight',
      'downloadedHeight',
      'priorityWalletHeight',
      'lastNonEmptyBlockFetchMs',
      'lastNonEmptyBlockCount',
      'lastNonEmptyNetworkBytes',
      'lastNonEmptyPayloadBytes',
      'networkBytesReceived',
      'payloadBytesReceived',
      'lastNonEmptyWalletDerivationCount',
      'lastNonEmptyWalletDerivationUs',
      'totalWalletDerivationCount',
      'totalWalletDerivationUs',
    ];

    for (const field of requiredFields) {
      expect(nativeAndroidBridge).toContain(
        `putDouble("${field}", status.numberValue("${field}"))`,
      );
    }
  });

  it('forwards Android sync failure diagnostics instead of dropping their cause', () => {
    expect(nativeAndroidBridge).toContain(
      'putString("lastError", status.stringValue("lastError"))',
    );
    expect(nativeAndroidBridge).toContain(
      'putDouble("consecutiveFailures", status.numberValue("consecutiveFailures"))',
    );
  });

  it('forwards the complete Ledger queue and reconciliation result through Android', () => {
    expect(nativeAndroidBridge).toContain(
      'snapshot.numberValue("pendingOutputKeyImageCount")',
    );
    const resultFields = [
      'verifiedOutputCount',
      'pendingOutputCount',
      'remainingPendingOutputCount',
      'importedOutputCount',
      'derivedOutputCount',
      'spentStatusUnspentOutputCount',
      'spentStatusBlockchainOutputCount',
      'spentStatusPoolOutputCount',
      'derivationDurationMs',
      'spentStatusRpcDurationMs',
      'outgoingRpcDurationMs',
      'stateUpdateDurationMs',
      'verificationDurationMs',
      'storeDurationMs',
      'totalDurationMs',
    ];
    for (const field of resultFields) {
      expect(nativeAndroidJni).toContain(`"${field}"`);
      expect(nativeAndroidBridge).toContain(`result.numberValue("${field}")`);
    }
  });

  it('reconciles only a normal Ledger wallet before and after sending', () => {
    const prepareFlow = send.slice(
      send.indexOf('const prepareForReview = async'),
      send.indexOf('const handleSend = async'),
    );
    const commitFlow = send.slice(
      send.indexOf('const handleSend = async'),
      send.indexOf('const validateRecipientAndContinue'),
    );
    expect(prepareFlow).toContain("registeredWallet?.kind === 'hardware'");
    expect(
      prepareFlow.match(/registeredWallet\?\.kind === 'hardware'/g),
    ).toHaveLength(1);
    expect(prepareFlow).not.toContain('if (session.readOnly)');
    expect(prepareFlow).not.toContain('await reconcileLedgerBalance()');
    expect(prepareFlow).toContain(
      "setLedgerSigningProgress({ phase: 'searching' })",
    );
    expect(prepareFlow).toContain("phase: 'awaiting-confirmation'");
    expect(prepareFlow).toContain('let ledgerHandoffCreated = false');
    expect(prepareFlow).toContain('await restoreLedgerViewAfterSigning()');
    expect(send).toContain('<LedgerSigningModal');
    expect(commitFlow).toContain('await walletService.commitTransaction');
    expect(commitFlow).toContain('await restoreLedgerViewAfterSigning()');
    expect(
      commitFlow.indexOf('await walletService.commitTransaction'),
    ).toBeLessThan(
      commitFlow.indexOf('await restoreLedgerViewAfterSigning()'),
    );
    expect(commitFlow).toContain('await reconcileLedgerBalance().catch');
    expect(
      commitFlow.indexOf('await restoreLedgerViewAfterSigning()'),
    ).toBeLessThan(commitFlow.indexOf('await reconcileLedgerBalance().catch'));
    expect(commitFlow).toContain('send.transactionBroadcastRefreshPending');
    expect(commitFlow).toContain('if (broadcastSucceeded)');
  });

  it('does not expose a new Ledger signing session before sync and account proof', () => {
    const connectStart = walletState.indexOf(
      'const connectLedgerForSigning = useCallback',
    );
    const connectFlow = walletState.slice(
      connectStart,
      walletState.indexOf('const reconcileLedgerBalance', connectStart),
    );
    expect(connectFlow).toContain(
      'const referenceSnapshot = await walletService.snapshot(activeSession)',
    );
    expect(connectFlow).toContain('await walletService.startRefresh(');
    expect(connectFlow).toContain(
      'await waitForLedgerSigningSpendReadyWithSingleRebuild({',
    );
    expect(connectFlow).toContain(
      'walletService.snapshotForLedgerSigningReadiness(',
    );
    expect(connectFlow).toContain(
      'const readSigningSnapshot = (',
    );
    expect(connectFlow).toContain('readSnapshot: readSigningSnapshot');
    expect(connectFlow).toContain('accountIndex: expectedAccountIndex');
    expect(connectFlow).toContain('const spendScopedSigningSession = {');
    expect(
      connectFlow.indexOf('await walletService.startRefresh('),
    ).toBeLessThan(
      connectFlow.indexOf(
        'await waitForLedgerSigningSpendReadyWithSingleRebuild({',
      ),
    );
    expect(
      connectFlow.indexOf(
        'await waitForLedgerSigningSpendReadyWithSingleRebuild({',
      ),
    ).toBeLessThan(connectFlow.indexOf('return spendScopedSigningSession'));
    expect(connectFlow).toContain(
      '.closeWallet(openedSigningSession, true)',
    );
    expect(connectFlow).toContain('refreshReferenceAfterMismatch:');
    expect(connectFlow).toContain('await waitForWalletSnapshotAtHeight({');
    expect(connectFlow).toContain(
      'await walletService.rebuildHardwareWalletCacheFromViewOnly(',
    );
    expect(
      connectFlow.match(/rebuildHardwareWalletCacheFromViewOnly/g),
    ).toHaveLength(1);
    expect(
      connectFlow.indexOf(
        'await waitForLedgerSigningSpendReadyWithSingleRebuild({',
      ),
    ).toBeLessThan(connectFlow.lastIndexOf('await closeReadOnlyCompanion()'));
  });

  it('connects the session-local transaction control plane before Core prepares a transfer', () => {
    const prepareStart = walletEngine.indexOf(
      'prepareTransaction(const PrepareTransactionRequest',
    );
    const prepareTransaction = walletEngine.slice(
      prepareStart,
      walletEngine.indexOf(
        'PreparedTransaction commitTransaction(',
        prepareStart,
      ),
    );
    const controlPlane = walletEngine.slice(
      walletEngine.indexOf('void initializeTransactionControlPlane('),
      walletEngine.indexOf(
        'LedgerKeyImageSyncResult syncLedgerKeyImagesToViewWallet(',
      ),
    );

    expect(controlPlane).toContain('session.wallet->init(');
    expect(controlPlane).toContain('session.wallet->connectToDaemon()');
    expect(controlPlane).toContain('networkInitializationGeneration');
    expect(prepareTransaction).toContain('initializeTransactionControlPlane(');
    expect(
      prepareTransaction.indexOf('initializeTransactionControlPlane('),
    ).toBeLessThan(prepareTransaction.indexOf('createTransaction'));
    expect(prepareTransaction).toContain(
      'transaction preparation requires configured network sync',
    );
  });

  it('does not hot-loop shared sync while Ledger owns a scanner session', () => {
    expect(walletEngine).toContain(
      '(pendingScans > 0 || !temporarilyBusyScanners.empty())',
    );
  });

  it('selects a software wallet immediately while a cold local open finishes behind Home', () => {
    expect(home).toContain('openRegisteredWalletById(walletId)');
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

  it('keeps seed backup optional and never blocks confirmed removal', () => {
    expect(wallets).toContain('backupRegisteredWalletSeed(');
    expect(wallets).toContain('const needsSeedBackup =');
    expect(wallets).toContain(
      'onRemove={() => showRemoveWalletConfirmation(wallet)}',
    );
    expect(wallets).not.toContain('findPendingSeedBackupForRemoval');
    expect(wallets).not.toContain('backUpSeedBeforeRemoval');
    expect(walletServiceSource).not.toContain('requireFastWalletSafeToRemove');
    expect(walletServiceSource).not.toContain("reason: 'seed-backup-required'");
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
    expect(selector).toContain('accessibilityRole="link"');
    expect(selector).toContain("t('wallets.manage')");
    expect(home).toContain("onManage={() => navigation.navigate('Wallets')}");
  });

  it('manages every native subaddress from the selected wallet', () => {
    expect(wallets).toContain('manageAddresses: true');
    expect(wallets).toContain("navigation.navigate('Receive'");
    expect(receive).toContain('route?.params?.manageAddresses === true');
    expect(receive).toContain('walletService.listSubaddresses(');
    expect(receive).toContain('receiveAccountIndexesKey');
    expect(receive).toContain('transaction.subaddrAccount');
    expect(receive).toContain("t('receive.newAddressName')");
    expect(walletServiceSource).toContain("'listSubaddresses'");
    expect(walletServiceSource).toContain(
      'requireNativeMoneroWallet().listSubaddresses',
    );
    expect(nativeWallet).toContain('listSubaddresses(');
  });

  it('keeps receive addresses stable and shows exact address activity', () => {
    expect(receive).toContain('walletAddresses.map(item =>');
    expect(receive).not.toContain('otherWalletAddresses.map(item =>');
    expect(receive).toContain('addressBalanceDetail(');
    expect(receive).toContain('ledgerBalanceUnverified');
    expect(receive).toContain('ledgerBalanceNeedsVerification(');
    expect(receive).not.toContain('{item.accountIndex}.{item.addressIndex}');
    expect(receive).toContain(
      'transactionsForWalletAddress(transactions, selectedAddress)',
    );
    expect(receive).not.toContain("t('receive.privacyTitle')");
    expect(receive).not.toContain("t('receive.stealthTitle')");
    expect(walletServiceSource).toContain(
      'nativeAddressById.get(address.id)!.balanceAtomic',
    );
    expect(nativeAndroidBridge).toContain('putString("balanceAtomic"');
    expect(nativeAndroidJni).toContain('"balanceAtomic"');
    expect(walletEngine).toContain(
      'wallet->balancePerSubaddress(accountIndex)',
    );
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
    expect(walletState).toContain('await ensureRegisteredWalletOpen(');
    expect(walletState).toContain(
      'registration,\n                    isActive,',
    );
    expect(walletState).toContain("registration.kind === 'fast'");
    expect(selector).toContain("? t('walletSelector.fast')");
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
    expect(walletState).toContain(
      'if (!appSecurityReady || appSecurityLocked)',
    );
    expect(walletState).toContain(
      "reason: !appSecurityReady ? 'appSecurityNotReady' : 'appLocked'",
    );
  });

  it('does not turn protected Fast Wallet metadata into a startup error', () => {
    expect(fastWalletPush).toContain('registration.refreshDeferred');
    expect(fastWalletPush).toContain('if (!protection || protection.locked)');
    expect(fastWalletPush).not.toContain('Push diagnostics');
    expect(fastWalletPush).not.toContain('Alert.alert');
    expect(appSecurity).toContain(
      'FastWalletPushService.refreshRegistrationQuietly(undefined, true)',
    );
  });

  it('commits cached selection before serialized registry persistence', () => {
    const activation = walletState.slice(
      walletState.indexOf('const activateRegisteredWallet ='),
      walletState.indexOf('const removeRegisteredWallet ='),
    );
    expect(activation).toContain('activeWalletPersistenceRef.current');
    expect(activation).toContain('activeWalletSelectionGenerationRef.current');
    expect(
      activation.indexOf('setRegisteredWallet(optimisticWallet)'),
    ).toBeLessThan(activation.indexOf('const persistSelection ='));
    expect(
      activation.indexOf('setSnapshot(walletSnapshotsRef.current[walletId])'),
    ).toBeLessThan(
      activation.indexOf('walletService.setActiveRegisteredWallet('),
    );
  });

  it('uses only the cached TEX8 public-content API', () => {
    expect(priceService).toContain('const REQUEST_TIMEOUT_MS = 6_000');
    expect(priceService).toContain('const PRICE_CACHE_KEY');
    expect(priceService).toContain(
      'const TEX8_MARKET_BASE = `${PRIMARY_PRIVATE_SERVICE_ORIGIN}/api/v1/market`',
    );
    expect(priceService).toContain(
      "import {torFetch} from '../services/TorHttp'",
    );
    expect(priceService).not.toContain('https://xmr.tex8.com/api/v1/market');
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
    expect(syncStatus).toContain(
      "presentation.phase === 'finalizing'\n      ? 100",
    );
    expect(syncStatus).toContain('const blockchainCurrent =');
    expect(syncStatus).toContain('blockHeightProgress(blockchainCurrent, network.targetHeight)');
    expect(syncStatus).toContain('walletHeightProgress ?? presentation.progress ?? 0');
    expect(syncStatus).toContain('network.downloadedHeight');
    expect(syncStatus).toContain(': network.chainHeight');
    expect(syncStatus).toContain('target={network.targetHeight}');
    expect(syncStatus).toContain('useAggregateNetworkRate(networkStatus)');
    expect(syncStatus).toContain('updateMobileNetworkSyncRateWindow(');
    expect(syncStatus).toContain(
      'syncStartHeight ?? snapshot?.walletHeight',
    );
    expect(syncStatus).toContain('networkStatus.priorityWalletHeight,');
    expect(syncStatus).toContain('networkStatus.targetHeight,');
    expect(syncStatus).toContain(
      'snapshot.synchronized && walletHeight >= daemonTargetHeight',
    );
    expect(syncStatus).toContain(
      'walletSyncDerivationsPerSecond(networkStatus)',
    );
    expect(syncStatus).toContain("t('sync.networkRate'");
    expect(syncStatus).toContain("t('sync.derivationRate'");
    expect(syncStatus).toContain('variant="blockchain"');
    expect(syncStatus).toContain('variant="wallet"');
    expect(syncStatus).toContain('s.fillBlockchain');
    expect(syncStatus).toContain('s.fillWallet');
    expect(syncStatus).toContain("t('sync.startingConnectionElapsed'");
    expect(syncStatus).toContain('seconds: connectionElapsedSeconds');
    expect(syncStatus).toContain(
      'const connectionElapsedSeconds = useElapsedSeconds(',
    );
    expect(syncStatus).toContain('extra={blockchainExtra}');
    expect(syncStatus).toContain("t('sync.blockHeight'");
    expect(syncStatus).toContain('style={s.metricsPrimary}');
    expect(syncStatus).toContain(
      'const showWalletSync = blockchainConnected && walletOpened',
    );
    expect(syncStatus).toContain('{showWalletSync ? (');
  });

  it('counts every Monero account once and exports Ledger read access on demand', () => {
    expect(walletEngine).toContain('wallet->numSubaddressAccounts()');
    expect(walletEngine).toContain('next.balanceAtomic += balance');
    expect(walletEngine).toContain('next.unlockedBalanceAtomic += unlocked');
    expect(walletEngine).not.toContain(
      'next.balanceAtomic = wallet->balance(0)',
    );
    expect(walletServiceSource).toContain(
      'session.accountIndex === undefined || !spendScope',
    );
    expect(walletServiceSource).toContain(
      'const spendScope = await this.resolveSpendAccountScope',
    );
    const snapshotStart = walletServiceSource.indexOf(
      'private async snapshotWithKnownAccountHistory(',
    );
    const snapshotMethod = walletServiceSource.slice(
      snapshotStart,
      walletServiceSource.indexOf(
        'async getTransactions(',
        snapshotStart,
      ),
    );
    expect(snapshotMethod).not.toContain(
      'const accountIndex = session.accountIndex ?? 0;',
    );
    expect(snapshotMethod).toContain('spendAccountIndex: spendScope.accountIndex');
    expect(walletServiceSource).toContain(
      'accountIndex: spendScope.accountIndex',
    );
    expect(send).toContain('snapshot?.spendUnlockedBalanceAtomic');
    expect(home).toContain('const activeWalletSnapshot = registeredWallet');
    expect(home).toContain('walletSnapshotMap[registeredWallet.id]');
    expect(home).toContain('const totalBalanceAtomic = toAtomicBigInt(');
    expect(home).toContain('activeWalletSnapshot?.pendingOutputKeyImageCount');
    expect(walletServiceSource).toContain('enableLedgerReadOnlyCompanion');
    expect(walletState).toContain(
      'await walletService.enableLedgerReadOnlyCompanion(',
    );
  });

  it('labels Ledger account 1 clearly and keeps internal verification diagnostics out of the dashboard', () => {
    expect(selector).toContain("t('walletSelector.ledgerFast')");
    expect(selector).toContain("t('walletSelector.ledgerFastAccount')");
    expect(selector).toContain(
      'isLegacyLedgerAccountRegistration(registration)',
    );
    expect(selector).toContain('ledgerVerificationRequired');
    expect(selector).toContain('snapshotHasKnownLedgerActivity(snapshot)');
    expect(home).toContain("hasUnverifiedLedgerBalance\n    ? '—'");
    expect(home).not.toContain("t('home.ledgerBalanceNeedsVerification')");
    expect(home).not.toContain('<Text style={s.statusError}');
    expect(selector).not.toContain(
      "t('walletSelector.ledgerBalanceNeedsVerification')",
    );
    expect(home).toContain("t('home.marketPrice')");
    expect(home).not.toContain("t('home.ledgerBalanceVerificationHint')");
    expect(home).not.toContain("t('home.verifyLedgerBalance')");
  });

  it('opens sync details by default while working and collapses after completion', () => {
    expect(syncStatus).toContain('const fullySynced =');
    expect(syncStatus).toContain('() => !fullySynced');
    expect(syncStatus).toContain('!previous.fullySynced && fullySynced');
    expect(syncStatus).toContain('updateExpanded(false)');
    expect(syncStatus).toContain('testID="sync-status-toggle"');
    expect(syncStatus).toContain('accessibilityState={{ expanded }}');
    expect(syncStatus).toContain('testID="sync-status-details"');
    expect(appTopBar).toContain('useConnectivityState');
    expect(appTopBar).toContain("{ label: 'Tor', route: connectivity.tor }");
    expect(appTopBar).toContain(
      "{ label: 'Sync', route: connectivity.clearnet }",
    );
    expect(appTopBar).toContain("stateLabel: 'connected'");
    expect(appTopBar).toContain('<MoneroLogo size={27} />');
    expect(home).not.toContain('testID="header-sync-status-toggle"');
    expect(home).toContain('expanded={syncStatusExpanded}');
    expect(home).toContain('onExpandedChange={setSyncStatusExpanded}');
  });

  it('shows distinct Ledger, spend-output, and node-retry phases', () => {
    expect(home).toContain('const connectivity = useConnectivityState()');
    expect(home).toContain('torStatus={connectivity.tor}');
    expect(syncStatus).toContain("torStatus.phase !== 'error'");
    expect(syncStatus).toContain("t('topBar.connectingTor')");
    expect(syncStatus).toContain("readinessPhase === 'scanning-spend-outputs'");
    expect(syncStatus).toContain("t('sync.spendOutputsChecking')");
    expect(syncStatus).toContain(
      "readinessPhase === 'retrying-spent-output-node'",
    );
    expect(syncStatus).toContain("t('sync.spendOutputsNodeRetry')");
    expect(syncStatus).toContain("? t('sync.spendOutputs')");
    expect(syncStatus).toContain("readinessPhase === 'waiting-ledger'");
    expect(syncStatus).toContain("t('sync.waitingLedger')");
    expect(syncStatus).toContain(
      "readinessPhase === undefined || readinessPhase === 'ready'",
    );
    expect(syncStatus).toContain('fullySynced && s.statusLedReady');
  });

  it('performs only the initial Ledger reconciliation automatically with bounded discovery', () => {
    expect(walletState).toContain("'ledgerAutoVerification.start'");
    expect(walletState).toContain(
      'await walletService.getLedgerTransportStatus()',
    );
    expect(walletState).toContain(
      'await walletService.requestLedgerTransportAccess()',
    );
    expect(walletState).toContain(
      "setLedgerReconciliationProgress({ phase: 'connecting-ledger' })",
    );
    expect(walletState).toContain(
      'ledgerNodeRetryRegistrationId === registration.id',
    );
    expect(walletState).toContain("? 'retrying-spent-output-node'");
    expect(walletState).toContain(
      'await reconcileLedgerBalance(true, true, progress =>',
    );
    expect(walletState).toContain('let derivationStarted = false');
    expect(walletState).toContain('derivationStarted = true');
    expect(walletState).toContain(
      'const retryAllowed = !derivationStarted || nodeVerificationFailed',
    );
    expect(walletState).toContain('if (retryAllowed) {');
    expect(walletState).toContain('ledgerInitialVerificationAttemptedRef');
    expect(walletState).toContain(
      'ledgerInitialVerificationAttemptedRef.current.add(registrationId)',
    );
    expect(walletState).toContain('ledgerInitialVerificationCanStart(');
    expect(walletState).toContain(
      'ledgerInitialVerificationAttemptedRef.current.delete(registrationId)',
    );
    expect(walletState).toContain(
      'ledgerInitialVerificationNextAttemptAtRef.current',
    );
    expect(walletState).toContain('ledgerReconciliationInFlightRef');
    expect(walletState).toContain("reason: 'active-wallet-changed'");
    expect(walletState).toContain("reason: 'effect-invalidated'");
    expect(walletState).toContain('ledgerAutoVerificationReady');
    expect(walletState).toContain(
      'ledgerNodeRetryRegistrationIdRef.current !== registrationId',
    );
    expect(walletState).toContain('scheduleRetry(15_000)');
    const autoVerificationEffect = walletState.slice(
      walletState.indexOf('const ledgerAutoVerificationRegistrationId'),
      walletState.indexOf("'openSessionPolling.started'"),
    );
    expect(autoVerificationEffect).not.toContain(
      'ledgerReconciliationProgress,\n    reconcileLedgerBalance',
    );
    expect(autoVerificationEffect).not.toContain(
      'registeredWallet,\n    snapshot,\n    walletSnapshots',
    );
    const effectInvalidatedStart = autoVerificationEffect.indexOf(
      'if (cancelled) {',
    );
    const effectInvalidatedEnd = autoVerificationEffect.indexOf(
      'if (registeredWalletRef.current?.id !== registrationId)',
      effectInvalidatedStart,
    );
    const effectInvalidatedBranch = autoVerificationEffect.slice(
      effectInvalidatedStart,
      effectInvalidatedEnd,
    );
    expect(effectInvalidatedBranch).toContain(
      'ledgerInitialVerificationNextAttemptAtRef.current.set(',
    );
    expect(effectInvalidatedBranch).toContain("reason: 'effect-invalidated'");
    const failedAttemptStart = autoVerificationEffect.indexOf(
      'const nodeVerificationFailed = isLedgerNodeVerificationError(reason)',
    );
    const failedAttemptEnd = autoVerificationEffect.indexOf(
      '} finally {',
      failedAttemptStart,
    );
    const failedAttempt = autoVerificationEffect.slice(
      failedAttemptStart,
      failedAttemptEnd,
    );
    expect(failedAttempt.indexOf('if (retryAllowed) {')).toBeLessThan(
      failedAttempt.indexOf(
        'ledgerInitialVerificationAttemptedRef.current.delete(registrationId)',
      ),
    );
    expect(autoVerificationEffect).toContain(
      'if (progress.phase === \'deriving-owned-output-key-images\')',
    );
    expect(autoVerificationEffect).not.toContain(
      "requiresLedgerVerification\n                ? 'waiting-ledger'",
    );
    expect(walletState).toContain('available: transport.available');
    expect(walletState).toContain('deviceCount: transport.deviceCount');
    expect(walletState).toContain(
      'permissionGranted: transport.permissionGranted',
    );
    expect(walletState).toContain('supported: transport.supported');
    expect(walletServiceSource).toContain(
      'viewSnapshot.walletHeight >= observedTargetHeight',
    );
    expect(walletServiceSource).not.toContain(
      'viewSnapshot.synchronized &&\n      observedTargetHeight > 0',
    );
    expect(home).toContain('activeWalletSnapshot?.pendingOutputKeyImageCount');
    expect(home).toContain('transactions.length');
    expect(home).not.toContain('onPress={verifyLedgerBalance}');
    expect(settings).not.toContain('verifyLedgerBalance');
    expect(settings).toContain('settings.ledgerBalanceVerification');
    expect(settings).toContain('recheckLedgerSpendOutputs');
    expect(settings).toContain('reconcileLedgerBalance(true)');
    expect(walletServiceSource).toContain('fullSpendOutputScan?: boolean');
    expect(walletServiceSource).toContain(
      'Boolean(options?.fullSpendOutputScan)',
    );
    expect(walletState).toContain('!registration.ledgerKeyImagesVerifiedAt');
    expect(walletState).not.toContain('pendingOutputCount === 0');
    expect(walletState).toContain(
      'await walletService.getTransactionsForAllAccounts(activeSession, 0)',
    );
    expect(walletState).toContain("'ledgerReconciliation.stateRefreshed'");
    expect(walletState).toContain('outgoingTransactionCount:');
    expect(nativeAndroidBridge).toContain(
      '"ledgerBle.scan.noLiveAdvertisement"',
    );
    expect(nativeAndroidBridge).not.toContain(
      'previouslyPairedLedgerBleStatus()',
    );
    expect(nativeAndroidBridge).toContain(
      'bluetoothEnabled && LedgerBleTransport.isConnected()',
    );
    expect(nativeAndroidBridge).toContain(
      'result.matchesLedgerBleService() ||',
    );
    expect(ledgerBleTransport).toContain('diagnostic("connect.timeout")');
  });

  it('batches Ledger history RPCs and retries cached key images without hardware', () => {
    expect(ledgerNodeRetryPatch).toContain(
      'restricted_gettransactions_batch_size = 100',
    );
    expect(ledgerNodeRetryPatch).toContain(
      'key_image_checkpoint_durable = true',
    );
    expect(ledgerNodeRetryPatch).toContain('reconcile_cached_key_images');
    expect(walletServiceSource).toContain(
      "'reconcileLedgerViewOnlyWallet.ledgerCompleteNodeRetry'",
    );
    expect(walletServiceSource).toContain(
      "nodeOnlyRetry ? '' : hardwareSession!.walletId",
    );
    expect(walletEngine).toContain(
      'destination->reconcileCachedKeyImagesWithStats(',
    );
  });

  it('shows the complete wallet-container history instead of only Ledger account 0', () => {
    expect(walletState).toContain(
      'walletService.getTransactionsForAllAccounts(',
    );
    expect(walletState).toContain(
      "registration.kind === 'hardware' && registration.role === 'fast'",
    );
  });

  it('publishes mobile balance and history only from one bracketed native revision', () => {
    expect(walletState).toContain('snapshotPublicationToken(beforeHistory)');
    expect(walletState).toContain('snapshotPublicationToken(afterHistory)');
    expect(walletState).toContain(
      'walletStateSamplesByRegistrationRef.current.set(',
    );
    expect(walletState).toContain(
      'const sample = walletStateSamplesByRegistrationRef.current.get(',
    );
    expect(walletState).toContain('transactions: sample?.transactions ?? []');
  });

  it('shows discovered Ledger receives during restore and observes only coherent samples', () => {
    expect(walletState).toContain('const visibleTransactions = useMemo');
    expect(walletState).toContain("transaction.direction === 'in'");
    expect(walletState).toContain('transactions: [...visibleTransactions]');
    expect(walletState).toContain('snapshot: publishedSnapshot');
    expect(walletState).toContain(
      'await observeTransactionSample(registration, sample)',
    );
    expect(walletState).toContain(
      'historicalScanComplete: sample.snapshot.synchronized',
    );
    expect(walletState).not.toContain('announceInitial:');
    expect(walletState).not.toContain('suppressNotices:');
  });

  it('never wakes an inactive Ledger in the background and exposes an explicit settings action', () => {
    expect(walletState).toContain('ledgerReconciliationInFlightRef');
    expect(walletState).not.toContain("'ledgerBackgroundVerification.start'");
    expect(walletState).not.toContain(
      'setInterval(() => void attempt(), 15_000)',
    );
    expect(settings).toContain('recheckLedgerSpendOutputs');
    expect(settings).toContain('reconcileLedgerBalance(true)');
    expect(walletState).toContain(
      'await walletService.openRegisteredWalletRegistration(\n            activeRegistration,',
    );
    expect(walletServiceSource).toContain('preserveActiveSession?: boolean');
    expect(walletServiceSource).toContain('viewSession !== leasedViewSession');
    expect(walletServiceSource).toContain(
      'this.activeSession = { ...previousSession }',
    );
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
