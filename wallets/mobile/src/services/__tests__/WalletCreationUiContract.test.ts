import { readFileSync } from 'fs';
import { resolve } from 'path';

const mobileRoot = resolve(__dirname, '..', '..', '..');
const source = (...parts: string[]) =>
  readFileSync(resolve(mobileRoot, ...parts), 'utf8');

describe('Wallet creation and existing-wallet UI contract', () => {
  const setup = source('src', 'screens', 'WalletSetupScreen.tsx');
  const welcome = source('src', 'screens', 'WelcomeScreen.tsx');
  const service = source('src', 'services', 'WalletService.ts');
  const translations = source('src', 'i18n', 'translations.ts');
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
    expect(setup).toContain("createSelectedFastWallet('hardware')");
    expect(setup).toContain("useState('199')");
    expect(setup).toContain("t('setup.fastWalletSlot')");
  });

  it('never proposes or reuses a retired hosted Fast Wallet slot by default', () => {
    expect(setup).toContain('loadRetiredFastWalletSlots()');
    expect(setup).toContain('nextFastReceiveDerivationIndex(');
    expect(setup).toContain('fastWalletSlotEditedRef.current');
    expect(setup).toContain('setFastWalletSlotInput(String(suggestedSlot))');
    expect(setup).toContain("t('setup.fastWalletSlotRetiredDescription'");
    expect(translations).toContain('Deleted wallet files are gone');
    expect(setup).toContain(
      'productSlot: fastWalletSlotEditedRef.current ? productSlot : undefined',
    );
    expect(translations).toContain('cannot be reused');
    expect(translations).toContain('its local files are gone');
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
      'uint64_t setEstimatedRefreshHeightForNewWallet',
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
      setup.indexOf('const openOperation = openRegisteredWalletById(walletId)'),
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

  it('does not start Ledger wallet creation until BLE is truly ready', () => {
    const createStart = setup.indexOf(
      'const startCreateHardwareWallet = async () =>',
    );
    const createEnd = setup.indexOf(
      'const openExistingWallet = async () =>',
      createStart,
    );
    const createFlow = setup.slice(createStart, createEnd);

    expect(createFlow).toContain('ledgerTransportReady(transportStatus)');
    expect(createFlow).toContain(
      "setupLog('startCreateHardwareWallet.transportNotReady'",
    );
    expect(android).toContain('prepareLedgerBleTransport(status, promise)');
    expect(android).toContain('NativeMoneroWalletJni.ledgerBleConnect()');
    expect(android).toContain('LEDGER_BLE_CONNECT_RETRY_DELAY_MS');
    expect(android).toContain('ledgerTransportExecutor.execute');
    expect(android).toContain('Thread(work, "mfw-ledger-transport")');
    expect(
      android.indexOf('prepareLedgerBleTransport(status, promise)'),
    ).toBeLessThan(
      android.indexOf(
        'promise.resolve(ledgerTransportStatusToWritableMap(preparedStatus))',
      ),
    );
  });

  it('prevents an old Ledger BLE timeout from completing a newer scan', () => {
    const scanStart = android.indexOf(
      'private fun scanLedgerBleDevices(promise: Promise)',
    );
    const scanEnd = android.indexOf(
      'override fun getBiometricAuthStatus',
      scanStart,
    );
    const scanFlow = android.slice(scanStart, scanEnd);
    const finishStart = android.indexOf('private fun finishLedgerBleScan(');
    const finishEnd = android.indexOf(
      'private fun prepareLedgerBleTransport(',
      finishStart,
    );
    const finishFlow = android.slice(finishStart, finishEnd);

    expect(scanStart).toBeGreaterThan(0);
    expect(scanEnd).toBeGreaterThan(scanStart);
    expect(finishStart).toBeGreaterThan(0);
    expect(finishEnd).toBeGreaterThan(finishStart);
    expect(android).toContain('private var pendingLedgerBleScanTimeout: Runnable?');
    expect(android).toContain('private var ledgerBleScanGeneration = 0L');
    expect(scanFlow).toContain('val scanGeneration = ledgerBleScanGeneration');
    expect(scanFlow).toContain('expectedGeneration = scanGeneration');
    expect(scanFlow).toContain('expectedCallback = callback');
    expect(scanFlow).toContain('ledgerBleScanGeneration != scanGeneration');
    expect(scanFlow).toContain(
      'pendingLedgerBleScanCallback !== callback',
    );
    expect(finishFlow).toContain(
      'ledgerBleScanGeneration != expectedGeneration',
    );
    expect(finishFlow).toContain(
      'pendingLedgerBleScanCallback !== expectedCallback',
    );
    expect(finishFlow).toContain(
      'pendingLedgerBleScanTimeout?.let(mainHandler::removeCallbacks)',
    );
    expect(android).toContain('override fun invalidate()');
    expect(android).toContain('cancelPendingLedgerBleScan()');
    expect(android).toContain('private fun cancelPendingLedgerBleScan()');
  });

  it('requires an explicit Ledger scan date like the CLI reference flow', () => {
    expect(setup).toContain('ledgerRestoreStartDate.trim().length > 0');
    expect(setup).toContain("'setup.ledgerScanDateHint'");
    expect(service).toContain(
      'Choose a Ledger scan start date before its first transaction.',
    );
  });

  it('opens the wallet without blocking setup on history or Key-Image reconciliation', () => {
    const createStart = setup.indexOf(
      'const startCreateHardwareWallet = async () =>',
    );
    const createEnd = setup.indexOf(
      'const openExistingWallet = async () =>',
      createStart,
    );
    const createFlow = setup.slice(createStart, createEnd);

    expect(createFlow).not.toContain(
      'walletService.reconcileLedgerViewOnlyWallet(',
    );
    expect(createFlow).toContain(
      "'startCreateHardwareWallet.verificationDeferred'",
    );
    expect(createFlow).toContain('startNetwork: false');
    expect(createFlow).toContain('startNetwork: true');
    expect(createFlow.indexOf("navigation.navigate('Home')")).toBeLessThan(
      createFlow.indexOf('reloadRegisteredWallets()'),
    );
    expect(walletState).toContain("'ledgerAutoVerification.start'");
    expect(walletState).toContain(
      'await reconcileLedgerBalance(true, true, progress =>',
    );
    expect(setup).not.toContain(
      'onValueChange={changePersistLedgerViewOnly}',
    );
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
