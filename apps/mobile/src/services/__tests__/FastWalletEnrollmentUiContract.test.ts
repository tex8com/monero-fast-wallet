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
  const enrollmentService = readFileSync(
    join(mobileRoot, 'src/services/FastWalletEnrollmentService.ts'),
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

  it('keeps the primary wallet list simple and treats Fast Wallet as a wallet', () => {
    expect(walletsScreen).toContain('Back up recovery words');
    expect(walletsScreen).toContain("t('walletSelector.fast')");
    expect(walletsScreen).toContain(
      "navigation.navigate('Receive', { walletId: wallet.id })",
    );
    expect(walletsScreen).not.toContain("t('wallets.fastWallets')");
    expect(walletsScreen).not.toContain('Turn alerts on');
    expect(walletsScreen).not.toContain('Delete scan data');
  });

  it('keeps official and private enrollment capability below the simple UI', () => {
    expect(walletService).toContain(
      'const privateWorkerRequested = Boolean(input.workerDescriptorHex?.trim())',
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

  it('hosts the selected Ledger Fast Wallet instead of stopping after local creation', () => {
    const pairCreated = walletSetup.indexOf(
      'createNamedLedgerWalletPairFromDevice',
    );
    const transferStarted = walletSetup.indexOf(
      "setFastWalletTransferStatus('transferring')",
      pairCreated,
    );
    const hosted = walletSetup.indexOf(
      'walletService.enableEncryptedLedgerFastWalletAlerts',
      transferStarted,
    );
    const accepted = walletSetup.indexOf(
      "setFastWalletTransferStatus('accepted')",
      hosted,
    );

    expect(pairCreated).toBeGreaterThan(0);
    expect(transferStarted).toBeGreaterThan(pairCreated);
    expect(hosted).toBeGreaterThan(transferStarted);
    expect(accepted).toBeGreaterThan(hosted);
    expect(walletSetup).not.toContain('hostingRequested: false');
    expect(walletService).toContain('enableEncryptedLedgerFastWalletAlerts');
    expect(enrollmentService).toContain('sealLedgerFastWalletWatch');
    expect(enrollmentService).toContain('submitFastWalletWatch');
  });

  it('keeps a completed Ledger wallet when encrypted hosting is deferred', () => {
    const flowStart = walletSetup.indexOf(
      'const startCreateHardwareWallet = async () =>',
    );
    const flowEnd = walletSetup.indexOf(
      'const openExistingWallet = async () =>',
      flowStart,
    );
    const flow = walletSetup.slice(flowStart, flowEnd);
    const enrollment = flow.indexOf(
      'await walletService.enableEncryptedLedgerFastWalletAlerts',
    );
    const deferred = flow.indexOf(
      "setupLog('startCreateHardwareWallet.fastWallet.hostingDeferred'",
      enrollment,
    );
    const home = flow.indexOf("navigation.navigate('Home')", deferred);

    expect(flowStart).toBeGreaterThan(0);
    expect(flowEnd).toBeGreaterThan(flowStart);
    expect(enrollment).toBeGreaterThan(0);
    expect(deferred).toBeGreaterThan(enrollment);
    expect(home).toBeGreaterThan(deferred);
    expect(flow.slice(enrollment, deferred)).not.toContain(
      'setLedgerPromptVisible(true)',
    );
    expect(flow).toContain(
      "setupLog('startCreateHardwareWallet.walletListRefreshDeferred'",
    );
  });

  it('registers the authenticated installation before Ledger hosting', () => {
    const method = walletService.slice(
      walletService.indexOf('async enableEncryptedLedgerFastWalletAlerts'),
      walletService.indexOf('async pairPrivateFastWalletWorker'),
    );
    const push = method.indexOf(
      'await FastWalletPushService.enableFastWalletNotifications()',
    );
    const enrollment = method.indexOf('await enrollLedgerFastWalletWatch');
    const hosted = method.indexOf("fastWalletHostingStatus: 'enabled'");

    expect(push).toBeGreaterThan(0);
    expect(enrollment).toBeGreaterThan(0);
    expect(enrollment).toBeGreaterThan(push);
    expect(hosted).toBeGreaterThan(enrollment);
    expect(method).not.toContain(
      'void FastWalletPushService.enableFastWalletNotifications()',
    );
    expect(method).toContain('ledgerFastWalletAlerts.push.error');
  });

  it('repairs Fast Wallets created by older clients without blocking wallet open', () => {
    expect(walletState).toContain('repairPendingLedgerFastWalletHosting(');
    expect(walletState).toContain(
      "wallet.fastWalletHostingStatus !== 'enabled'",
    );
    expect(walletState).toContain('.enableEncryptedLedgerFastWalletAlerts({');
    expect(walletState).toContain("'ledgerFastWalletHostingRepair.accepted'");
    expect(walletState).toContain("'ledgerFastWalletHostingRepair.deferred'");
    expect(walletState).not.toContain(
      'await repairPendingLedgerFastWalletHosting(',
    );
  });

  it('pins the official encrypted-hosting service in every product build', () => {
    const official = releaseManifest.parameters.fastWalletOfficialWorker;

    expect(releaseManifest.features.officialWorker).toBe(true);
    expect(official.gatewayOrigin).toBe('https://xmr.tex8.com');
    expect(official.registrationOrigin).toBe('https://xmr.tex8.com');
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
});
