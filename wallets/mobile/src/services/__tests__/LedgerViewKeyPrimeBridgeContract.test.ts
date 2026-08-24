import { readFileSync } from 'fs';
import { resolve } from 'path';

const mobileRoot = resolve(__dirname, '..', '..', '..');
const repoRoot = resolve(mobileRoot, '..', '..');
const source = (...parts: string[]) =>
  readFileSync(resolve(mobileRoot, ...parts), 'utf8');
const repoSource = (...parts: string[]) =>
  readFileSync(resolve(repoRoot, ...parts), 'utf8');

describe('Ledger companion signing prime bridge contract', () => {
  const spec = source('specs', 'NativeMoneroWallet.ts');
  const wrapper = source('src', 'services', 'NativeMoneroWallet.ts');
  const walletService = source('src', 'services', 'WalletService.ts');
  const walletState = source('src', 'services', 'WalletState.tsx');
  const androidModule = source(
    'android',
    'app',
    'src',
    'main',
    'java',
    'com',
    'monerowallet',
    'NativeMoneroWalletModule.kt',
  );
  const androidJni = source(
    'android',
    'app',
    'src',
    'main',
    'cpp',
    'NativeMoneroWalletJni.cpp',
  );
  const androidJniKotlin = source(
    'android',
    'app',
    'src',
    'main',
    'java',
    'com',
    'monerowallet',
    'NativeMoneroWalletJni.kt',
  );
  const iosBridge = source(
    'ios',
    'MoneroWallet',
    'NativeMoneroWallet',
    'RCTNativeMoneroWallet.mm',
  );

  const walletEngineHeader = repoSource(
    'native',
    'monero-bridge',
    'cpp',
    'WalletEngine.h',
  );
  const walletEngineSource = repoSource(
    'native',
    'monero-bridge',
    'cpp',
    'WalletEngine.cpp',
  );
  const localResetPatch = repoSource(
    'third_party',
    'monero-patches',
    '0091-wallet-add-local-shared-sync-cache-reset.patch',
  );

  it('exposes opaque session ids and an explicit restore height through React Native', () => {
    const specMethod = spec.slice(
      spec.indexOf('primeHardwareWalletFromViewOnly('),
      spec.indexOf(
        'rebuildHardwareWalletCacheFromViewOnly(',
        spec.indexOf('primeHardwareWalletFromViewOnly('),
      ),
    );
    expect(specMethod).toContain('hardwareWalletId: string');
    expect(specMethod).toContain('viewOnlyWalletId: string');
    expect(specMethod).toContain('Promise<void>');
    expect(specMethod).not.toContain('privateViewKey');

    const specRebuildStart = spec.indexOf(
      'rebuildHardwareWalletCacheFromViewOnly(',
    );
    const specRebuild = spec.slice(
      specRebuildStart,
      spec.indexOf('syncLedgerKeyImagesToViewWallet(', specRebuildStart),
    );
    expect(specRebuild).toContain('hardwareWalletId: string');
    expect(specRebuild).toContain('viewOnlyWalletId: string');
    expect(specRebuild).toContain('restoreHeight: number');
    expect(specRebuild).toContain('Promise<void>');
    expect(specRebuild).not.toContain('privateViewKey');

    const wrapperStart = wrapper.indexOf(
      'primeHardwareWalletFromViewOnly: (',
    );
    const wrapperMethod = wrapper.slice(
      wrapperStart,
      wrapper.indexOf(
        'rebuildHardwareWalletCacheFromViewOnly:',
        wrapperStart,
      ),
    );
    expect(wrapperMethod).toContain(
      'turboModule.primeHardwareWalletFromViewOnly(',
    );
    expect(wrapperMethod).not.toContain('privateViewKey');

    const wrapperRebuildStart = wrapper.indexOf(
      'rebuildHardwareWalletCacheFromViewOnly:',
    );
    const wrapperRebuild = wrapper.slice(
      wrapperRebuildStart,
      wrapper.indexOf('syncLedgerKeyImagesToViewWallet:', wrapperRebuildStart),
    );
    expect(wrapperRebuild).toContain(
      'turboModule.rebuildHardwareWalletCacheFromViewOnly(',
    );
    expect(wrapperRebuild).toContain('restoreHeight');
    expect(wrapperRebuild).not.toContain('privateViewKey');
  });

  it('keeps the private view key inside C++ on Android and iOS', () => {
    const androidStart = androidModule.indexOf(
      'override fun primeHardwareWalletFromViewOnly(',
    );
    const androidPrime = androidModule.slice(
      androidStart,
      androidModule.indexOf(
        'override fun rebuildHardwareWalletCacheFromViewOnly(',
        androidStart,
      ),
    );
    expect(androidPrime).toContain(
      'NativeMoneroWalletJni.primeHardwareWalletFromViewOnly(',
    );
    expect(androidPrime).toContain('maskIdentifier(hardwareWalletId)');
    expect(androidPrime).toContain('maskIdentifier(viewOnlyWalletId)');
    expect(androidPrime).not.toContain('privateViewKey');

    const androidRebuildStart = androidModule.indexOf(
      'override fun rebuildHardwareWalletCacheFromViewOnly(',
    );
    const androidRebuild = androidModule.slice(
      androidRebuildStart,
      androidModule.indexOf('override fun prepareTransaction(', androidRebuildStart),
    );
    expect(androidRebuild).toContain(
      'NativeMoneroWalletJni.rebuildHardwareWalletCacheFromViewOnly(',
    );
    expect(androidRebuild).toContain('restoreHeight: Double');
    expect(androidRebuild).not.toContain('privateViewKey');

    const jniStart = androidJni.indexOf(
      'nativePrimeHardwareWalletFromViewOnly(',
    );
    const jniPrime = androidJni.slice(
      jniStart,
      androidJni.indexOf(
        'nativeRebuildHardwareWalletCacheFromViewOnly(',
        jniStart,
      ),
    );
    expect(jniPrime).toContain(
      'walletEngine().primeHardwareWalletFromViewOnly(',
    );
    expect(jniPrime).not.toContain('privateViewKey');

    const jniRebuildStart = androidJni.indexOf(
      'nativeRebuildHardwareWalletCacheFromViewOnly(',
    );
    const jniRebuild = androidJni.slice(
      jniRebuildStart,
      androidJni.indexOf(
        'nativeSyncLedgerKeyImagesToViewWallet(',
        jniRebuildStart,
      ),
    );
    expect(jniRebuild).toContain(
      'walletEngine().rebuildHardwareWalletCacheFromViewOnly(',
    );
    expect(jniRebuild).toContain(
      'toExactUInt64(restoreHeight, "restoreHeight")',
    );
    expect(jniRebuild).not.toContain('privateViewKey');

    const kotlinJniStart = androidJniKotlin.indexOf(
      'fun primeHardwareWalletFromViewOnly(',
    );
    const kotlinJniPrime = androidJniKotlin.slice(
      kotlinJniStart,
      androidJniKotlin.indexOf(
        'fun rebuildHardwareWalletCacheFromViewOnly(',
        kotlinJniStart,
      ),
    );
    expect(kotlinJniPrime).toContain(
      'nativePrimeHardwareWalletFromViewOnly(hardwareWalletId, viewOnlyWalletId)',
    );
    expect(kotlinJniPrime).not.toContain('privateViewKey');

    const kotlinRebuildStart = androidJniKotlin.indexOf(
      'fun rebuildHardwareWalletCacheFromViewOnly(',
    );
    const kotlinRebuild = androidJniKotlin.slice(
      kotlinRebuildStart,
      androidJniKotlin.indexOf(
        'fun getOwnedOutputKeyImages(',
        kotlinRebuildStart,
      ),
    );
    expect(kotlinRebuild).toContain(
      'nativeRebuildHardwareWalletCacheFromViewOnly(',
    );
    expect(kotlinRebuild).toContain('restoreHeight: Double');
    expect(kotlinRebuild).not.toContain('privateViewKey');

    const iosStart = iosBridge.indexOf(
      '- (void)primeHardwareWalletFromViewOnly:',
    );
    const iosPrime = iosBridge.slice(
      iosStart,
      iosBridge.indexOf(
        '- (void)rebuildHardwareWalletCacheFromViewOnly:',
        iosStart,
      ),
    );
    expect(iosPrime).toContain('engine.primeHardwareWalletFromViewOnly(');
    expect(iosPrime).toContain('maskIdentifier(hardwareWalletId)');
    expect(iosPrime).toContain('maskIdentifier(viewOnlyWalletId)');
    expect(iosPrime).not.toContain('privateViewKey');

    const iosRebuildStart = iosBridge.indexOf(
      '- (void)rebuildHardwareWalletCacheFromViewOnly:',
    );
    const iosRebuild = iosBridge.slice(
      iosRebuildStart,
      iosBridge.indexOf('- (void)prepareTransaction:', iosRebuildStart),
    );
    expect(iosRebuild).toContain(
      'engine.rebuildHardwareWalletCacheFromViewOnly(',
    );
    expect(iosRebuild).toContain(
      'toExactHeight(restoreHeight, "restoreHeight")',
    );
    expect(iosRebuild).not.toContain('privateViewKey');
  });

  it('forces a local cache reset and proves the shared-sync restart boundary', () => {
    expect(walletEngineHeader).toContain(
      'void rebuildHardwareWalletCacheFromViewOnly(',
    );
    const rebuildStart = walletEngineSource.indexOf(
      'void rebuildHardwareWalletCacheFromViewOnly(',
    );
    const rebuild = walletEngineSource.slice(
      rebuildStart,
      walletEngineSource.indexOf(
        'FastReceiveIdentity createFastReceiveIdentity(',
        rebuildStart,
      ),
    );
    expect(rebuild).toContain('std::unique_lock<std::shared_timed_mutex>');
    expect(rebuild).toContain('hardware->publicViewKey() != viewOnly->publicViewKey()');
    expect(rebuild).toContain('hardware->publicSpendKey() != viewOnly->publicSpendKey()');
    expect(rebuild).toContain('viewOnly->watchOnly()');
    expect(rebuild).toContain('prepareHardwareWalletScanFromViewOnly(*viewOnly)');
    expect(rebuild).toContain(
      'hardware->setRefreshFromBlockHeight(effectiveRestoreHeight)',
    );
    expect(rebuild).toContain(
      'hardware->resetBlockchainCacheForSharedSync()',
    );
    expect(rebuild).toContain('heightAfterReset != 1');
    expect(rebuild).toContain('targetAfterReset != effectiveRestoreHeight');
    expect(rebuild).toContain(
      'updateCachedSnapshot(*hardwareSession, companionHeight)',
    );
    expect(rebuild).not.toContain('viewOnly->getTransactions');
    expect(rebuild).not.toContain('viewOnly->balance');

    expect(localResetPatch).toContain(
      'm_wallet->rescan_blockchain(false, false);',
    );
    expect(localResetPatch).toContain('m_history->refresh();');
    expect(localResetPatch).toContain('m_synchronized = false;');
  });

  it('primes while keeping the companion open through the first parity check', () => {
    const connectStart = walletState.indexOf(
      'const connectLedgerForSigning = useCallback',
    );
    const connectFlow = walletState.slice(
      connectStart,
      walletState.indexOf('const reconcileLedgerBalance', connectStart),
    );
    const companionBranchStart = connectFlow.indexOf(
      'if (hasEncryptedViewCompanion) {',
    );
    const companionBranch = connectFlow.slice(
      companionBranchStart,
      connectFlow.indexOf(
        '// Await the native coordinator join',
        companionBranchStart,
      ),
    );
    expect(companionBranch).toContain(
      'await walletService.primeHardwareWalletFromViewOnly(',
    );
    expect(companionBranch).not.toContain('await closeReadOnlyCompanion()');
    expect(connectFlow.indexOf('primeHardwareWalletFromViewOnly')).toBeLessThan(
      connectFlow.indexOf('await walletService.startRefresh('),
    );
    expect(
      connectFlow.indexOf(
        'await waitForLedgerSigningSpendReadyWithSingleRebuild({',
      ),
    ).toBeLessThan(connectFlow.lastIndexOf('await closeReadOnlyCompanion()'));
    expect(connectFlow).toContain('refreshReferenceAfterMismatch:');
    expect(connectFlow).toContain(
      'await walletService.rebuildHardwareWalletCacheFromViewOnly(',
    );
    expect(connectFlow).toContain(
      'const readOnlySession = readOnlyCompanionClosed',
    );
    expect(connectFlow).toContain(': activeSession;');
    expect(connectFlow).not.toContain('exportHardwarePrivateViewKey');

    const serviceStart = walletService.indexOf(
      'async primeHardwareWalletFromViewOnly(',
    );
    const servicePrime = walletService.slice(
      serviceStart,
      walletService.indexOf(
        'async enableLedgerReadOnlyCompanion(',
        serviceStart,
      ),
    );
    expect(servicePrime).toContain(
      'requireNativeMoneroWallet().primeHardwareWalletFromViewOnly(',
    );
    expect(servicePrime).not.toContain('privateViewKey');
  });
});
