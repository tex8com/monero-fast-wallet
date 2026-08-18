import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';

const repositoryRoot = resolve(__dirname, '../../../../..');
const read = (path: string) => readFileSync(resolve(repositoryRoot, path), 'utf8');

describe('bounded public BlockStream spool', () => {
  test('common Core keeps a RAM hot queue and falls back to backpressure', () => {
    const patch = read(
      'third_party/monero-patches/0080-wallet-spill-public-blockstream-overflow-to-bounded-disk.patch',
    );
    expect(patch).toContain('CUPRATE_GRPC_SPOOL_MAX_BYTES');
    expect(patch).toContain('payload_crc32');
    expect(patch).toContain('memory_queue_depth');
    expect(patch).toContain('backpressure_count');
    expect(patch).toContain('public block spool integrity check failed');
    expect(read('third_party/monero-patches/series')).toContain(
      '0080-wallet-spill-public-blockstream-overflow-to-bounded-disk.patch',
    );
  });

  test('Android uses no-backup private storage with a hard free-space reserve', () => {
    const application = read(
      'wallets/mobile/android/app/src/main/java/com/monerowallet/MainApplication.kt',
    );
    expect(application).toContain('File(noBackupFilesDir, "public-block-spool")');
    expect(application).toContain('SPOOL_MAX_BYTES = 8L * GIB');
    expect(application).toContain('SPOOL_FREE_SPACE_RESERVE_BYTES = 2L * GIB');
    expect(application).toContain('mfw-public-block-spool-');
    expect(application.indexOf('loadReactNative(this)')).toBeLessThan(
      application.indexOf('configurePublicBlockSpool()'),
    );
    expect(application).not.toContain('walletId');
  });

  test('Android keeps active data sync alive without bypassing app lock', () => {
    const manifest = read(
      'wallets/mobile/android/app/src/main/AndroidManifest.xml',
    );
    const service = read(
      'wallets/mobile/android/app/src/main/java/com/monerowallet/WalletSyncForegroundService.kt',
    );
    expect(manifest).toContain('android.permission.FOREGROUND_SERVICE_DATA_SYNC');
    expect(manifest).toContain('android:foregroundServiceType="dataSync"');
    expect(service).toContain('NativeAppAuthorization.isAuthorized()');
    expect(service).toContain('START_NOT_STICKY');
    expect(service).toContain('stopForAuthorizationBoundary()');
    expect(service).not.toContain('walletId');
  });

  test('iOS and desktop configure the same bounded common-Core feature', () => {
    const ios = read(
      'wallets/mobile/ios/MoneroWallet/NativeMoneroWallet/RCTNativeMoneroWallet.mm',
    );
    const desktop = read(
      'native/desktop-bridge/cpp/DesktopWalletCore.cpp',
    );
    expect(ios).toContain('CUPRATE_GRPC_SPOOL_DIR');
    expect(ios).toContain('NSURLIsExcludedFromBackupKey');
    expect(desktop).toContain('CUPRATE_GRPC_SPOOL_DIR');
    expect(desktop).toContain('std::filesystem::space');
  });
});
