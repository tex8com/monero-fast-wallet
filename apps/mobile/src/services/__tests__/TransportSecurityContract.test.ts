import {readFileSync} from 'fs';
import {resolve} from 'path';

const mobileRoot = resolve(__dirname, '..', '..', '..');
const androidManifest = readFileSync(
  resolve(mobileRoot, 'android', 'app', 'src', 'main', 'AndroidManifest.xml'),
  'utf8',
);
const androidWalletModule = readFileSync(
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
const iosInfoPlist = readFileSync(
  resolve(mobileRoot, 'ios', 'MoneroWallet', 'Info.plist'),
  'utf8',
);
const iosWalletModule = readFileSync(
  resolve(
    mobileRoot,
    'ios',
    'MoneroWallet',
    'NativeMoneroWallet',
    'RCTNativeMoneroWallet.mm',
  ),
  'utf8',
);
const scannerClient = readFileSync(
  resolve(mobileRoot, 'src', 'services', 'FastReceiveScannerClient.ts'),
  'utf8',
);
const walletService = readFileSync(
  resolve(mobileRoot, 'src', 'services', 'WalletService.ts'),
  'utf8',
);
const nativeSpec = readFileSync(
  resolve(mobileRoot, 'specs', 'NativeMoneroWallet.ts'),
  'utf8',
);

describe('mobile transport security contract', () => {
  it('disables platform-wide cleartext network access', () => {
    expect(androidManifest).toContain('android:usesCleartextTraffic="false"');
    expect(androidManifest).not.toContain('android:usesCleartextTraffic="true"');
    expect(iosInfoPlist).toMatch(
      /<key>NSAllowsArbitraryLoads<\/key>\s*<false\/>/,
    );
  });

  it('requires a clean HTTPS scanner origin in both native clients', () => {
    expect(androidWalletModule).toContain('parsed.scheme == "https"');
    expect(androidWalletModule).toContain('parsed.userInfo == null');
    expect(androidWalletModule).toContain('parsed.rawQuery == null');
    expect(iosWalletModule).toContain(
      'components.scheme.lowercaseString isEqualToString:@"https"',
    );
    expect(iosWalletModule).toContain('components.user.length > 0');
    expect(iosWalletModule).toContain('components.query.length > 0');
  });

  it('keeps per-wallet scanner credentials outside JavaScript', () => {
    expect(scannerClient).not.toContain('authorization');
    expect(scannerClient).not.toContain('scannerAuthToken');
    expect(walletService).toContain('fastReceiveScannerCredentialKey');
    expect(walletService).toContain('scannerAuthSecretKey');
    expect(nativeSpec).toContain('scannerAuthSecretKey: string');
    expect(androidWalletModule).toContain(
      'readRequiredSecretValue(scannerAuthSecretKey)',
    );
    expect(iosWalletModule).toContain(
      'readRequiredKeychainSecret(scannerAuthSecretKey)',
    );
  });
});
