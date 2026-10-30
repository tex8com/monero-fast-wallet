import { readFileSync } from 'fs';
import { join } from 'path';

const mobileRoot = join(__dirname, '../../..');

describe('Fast Wallet encrypted-alert UI contract', () => {
  const walletsScreen = readFileSync(
    join(mobileRoot, 'src/screens/WalletsScreen.tsx'),
    'utf8',
  );
  const walletService = readFileSync(
    join(mobileRoot, 'src/services/WalletService.ts'),
    'utf8',
  );
  const walletSetup = readFileSync(
    join(mobileRoot, 'src/screens/WalletSetupScreen.tsx'),
    'utf8',
  );
  const walletState = readFileSync(
    join(mobileRoot, 'src/services/WalletState.tsx'),
    'utf8',
  );
  const releaseManifest = JSON.parse(
    readFileSync(
      join(mobileRoot, '../../config/v1-release-features.json'),
      'utf8',
    ),
  ) as {
    features: { officialWorker: boolean };
    parameters: {
      fastWalletOfficialWorker: {
        gatewayOrigin: string;
        registrationOrigin: string;
        rootIdHex: string;
      };
    };
  };
  const androidBuild = readFileSync(
    join(mobileRoot, 'android/app/build.gradle'),
    'utf8',
  );
  const androidNative = readFileSync(
    join(
      mobileRoot,
      'android/app/src/main/java/com/monerowallet/NativeMoneroWalletModule.kt',
    ),
    'utf8',
  );
  const iosNative = readFileSync(
    join(
      mobileRoot,
      'ios/MoneroWallet/NativeMoneroWallet/RCTNativeMoneroWallet.mm',
    ),
    'utf8',
  );

  it('keeps the primary wallet list simple and treats Fast Wallet as a wallet', () => {
    expect(walletsScreen).toContain("t('wallets.backupRecoveryWords')");
    expect(walletsScreen).toContain("t('walletSelector.fast')");
    expect(walletsScreen).toContain(
      "navigation.navigate('Receive', { walletId: wallet.id })",
    );
    expect(walletsScreen).not.toContain("t('wallets.fastWallets')");
    expect(walletsScreen).not.toContain('Turn alerts on');
    expect(walletsScreen).not.toContain('Delete scan data');
  });

  it('uses the selected official, approved Community, or private Worker below the simple UI', () => {
    expect(walletService).toContain('loadFastWalletWorkerSelection');
    expect(walletService).toContain(
      'const privateWorkerRequested = Boolean(selectedWorkerDescriptor)',
    );
    expect(walletService).toMatch(
      /privateWorkerRequested && !v1ReleaseFeatures\.privateWorkerPairing/,
    );
    expect(walletService).toMatch(
      /!privateWorkerRequested && !v1ReleaseFeatures\.officialWorker/,
    );
  });

  it('finishes deferred Fast Wallet enrollment with orange and green status', () => {
    const transfer = walletsScreen.indexOf("status: 'transferring'");
    const enrollment = walletsScreen.indexOf(
      'walletService.enableEncryptedFastWalletAlerts',
      transfer,
    );
    const accepted = walletsScreen.indexOf("status: 'accepted'", enrollment);

    expect(transfer).toBeGreaterThan(0);
    expect(enrollment).toBeGreaterThan(transfer);
    expect(accepted).toBeGreaterThan(enrollment);
    expect(walletsScreen).toContain("t('setup.fastWalletTransferSending')");
    expect(walletsScreen).toContain("t('setup.fastWalletTransferAccepted')");
  });

  it('creates an independent software Fast Wallet when selected during Ledger setup', () => {
    const flowStart = walletSetup.indexOf(
      'const startCreateHardwareWallet = async () =>',
    );
    const flowEnd = walletSetup.indexOf(
      'const openExistingWallet = async () =>',
      flowStart,
    );
    const flow = walletSetup.slice(flowStart, flowEnd);

    expect(flow).toContain('walletService.createNamedWalletFromDevice({');
    expect(flow).toContain("await createSelectedFastWallet('hardware')");
    expect(flow).not.toContain('createNamedLedgerWalletPairFromDevice');
    expect(flow).not.toContain('enableEncryptedLedgerFastWalletAlerts');
  });

  it('fails closed if legacy Ledger-account hosting is called', () => {
    const method = walletService.slice(
      walletService.indexOf('async enableEncryptedLedgerFastWalletAlerts'),
      walletService.indexOf('async pairPrivateFastWalletWorker'),
    );
    const gate = method.indexOf('if (!v1ReleaseFeatures.ledgerFastWallet)');
    const push = method.indexOf('enableFastWalletNotifications()');

    expect(gate).toBeGreaterThan(0);
    expect(push).toBeGreaterThan(gate);
    expect(method.slice(gate, push)).toContain(
      'does not have an independent Fast Wallet root',
    );
  });

  it('does not auto-host legacy Ledger account registrations', () => {
    expect(walletState).not.toContain('repairPendingLedgerFastWalletHosting(');
    expect(walletState).not.toContain(
      '.enableEncryptedLedgerFastWalletAlerts({',
    );
  });

  it('pins the official encrypted-hosting service in every product build', () => {
    const official = releaseManifest.parameters.fastWalletOfficialWorker;

    expect(releaseManifest.features.officialWorker).toBe(true);
    expect(official.gatewayOrigin).toBe(
      'http://fastrelayrpcf3hbc4qvykjgbpwpmcuq5dpcsdxoe7gwfh2zxdib3eid.onion',
    );
    expect(official.registrationOrigin).toBe(
      'http://fastrelayrpcf3hbc4qvykjgbpwpmcuq5dpcsdxoe7gwfh2zxdib3eid.onion',
    );
    expect(official.rootIdHex).toMatch(/^[0-9a-f]{64}$/);
    expect(androidBuild).toContain('officialWorkerParameters.gatewayOrigin');
    expect(androidBuild).toContain('officialWorkerParameters.rootIdHex');
    expect(androidBuild).toContain(
      'officialWorker requires a pinned 32-byte lowercase-hex root ID',
    );
  });

  it('does not expose infrastructure terms in the primary action labels', () => {
    expect(walletsScreen).not.toContain('Turn HPKE on');
    expect(walletsScreen).not.toContain('Upload private view key');
    expect(walletsScreen).not.toContain('Register scanner');
  });

  it('activates an assignment only for the exact Worker-acknowledged candidate', () => {
    const androidSubmit = androidNative.slice(
      androidNative.indexOf('override fun submitFastWalletWatch('),
      androidNative.indexOf(
        'override fun disableFastWalletDelivery(',
        androidNative.indexOf('override fun submitFastWalletWatch('),
      ),
    );
    const iosSubmit = iosNative.slice(
      iosNative.indexOf('- (void)submitFastWalletWatch:'),
      iosNative.indexOf(
        '- (void)disableFastWalletDelivery',
        iosNative.indexOf('- (void)submitFastWalletWatch:'),
      ),
    );

    for (const source of [androidSubmit, iosSubmit]) {
      const receiptVerification =
        source.indexOf('verifyFastWalletWorkerReceipt') >= 0
          ? source.indexOf('verifyFastWalletWorkerReceipt')
          : source.indexOf('verifyWorkerReceipt');
      const activeWrite =
        source.indexOf('status = "active"') >= 0
          ? source.indexOf('status = "active"')
          : source.indexOf('@"status": @"active"');
      expect(receiptVerification).toBeGreaterThan(0);
      expect(activeWrite).toBeGreaterThan(receiptVerification);
      expect(source).toContain('assignmentHandle');
      expect(source).toContain('assignmentEpoch');
      expect(source).toContain('Pending Fast Wallet assignment does not exist');
      expect(source).toContain(
        'Acknowledged Fast Wallet assignment is no longer current',
      );
    }

    expect(androidSubmit).toContain(
      'pending.handle == checkedAssignmentHandle',
    );
    expect(androidSubmit).toContain('pending.epoch == checkedAssignmentEpoch');
    expect(iosSubmit).toContain('isEqualToString:checkedAssignmentHandle');
    expect(iosSubmit).toContain('checkedAssignmentEpoch');
  });
});
