import { readFileSync } from 'fs';
import { resolve } from 'path';

import {
  classifyDiagnosticFailure,
  formatWalletLogLine,
} from '../WalletLogger';

const mobileRoot = resolve(__dirname, '..', '..', '..');

function source(...parts: string[]) {
  return readFileSync(resolve(mobileRoot, ...parts), 'utf8');
}

const nativeSpec = source('specs', 'NativeMoneroWallet.ts');
const nativeAdapter = source('src', 'services', 'NativeMoneroWallet.ts');
const privatePhoneRequests = source(
  'src',
  'services',
  'PrivatePhoneAddressRequests.ts',
);
const settingsScreen = source('src', 'screens', 'SettingsScreen.tsx');
const walletSetupScreen = source('src', 'screens', 'WalletSetupScreen.tsx');
const androidWalletModule = source(
  'android',
  'app',
  'src',
  'main',
  'java',
  'com',
  'monerowallet',
  'NativeMoneroWalletModule.kt',
);
const iosWalletModule = source(
  'ios',
  'MoneroWallet',
  'NativeMoneroWallet',
  'RCTNativeMoneroWallet.mm',
);
const walletEngine = source(
  '..',
  '..',
  'native',
  'monero-bridge',
  'cpp',
  'WalletEngine.cpp',
);

describe('sensitive native boundary contract', () => {
  it('keeps recovery-seed import entirely outside the React Native boundary', () => {
    expect(nativeSpec).toContain('restoreWalletWithNativeSeed(');
    expect(nativeAdapter).toContain('restoreWalletWithNativeSeed:');
    expect(walletSetupScreen).toContain(
      'walletService.restoreNamedWalletWithNativeSeed(',
    );
    expect(nativeSpec).not.toMatch(/\bmnemonic\b/);
    expect(nativeAdapter).not.toMatch(/\bmnemonic\b/);
    expect(walletSetupScreen).not.toMatch(
      /\bconst\s*\[\s*(?:seed|mnemonic)\b/i,
    );
    expect(walletSetupScreen).not.toMatch(/\bset(?:Seed|Mnemonic)\s*\(/);
    expect(androidWalletModule).toContain(
      'override fun restoreWalletWithNativeSeed(',
    );
    expect(iosWalletModule).toContain('- (void)restoreWalletWithNativeSeed:');
  });

  it('exposes only purpose-bound secret operations to React Native', () => {
    expect(nativeSpec).toContain('ensureWalletSecret(');
    expect(nativeSpec).toContain('deleteWalletSecret(');
    expect(nativeSpec).toContain('storeDaemonPassword(');
    expect(nativeSpec).toContain('deleteDaemonPassword(');
    expect(nativeSpec).not.toMatch(/\bstoreSecret\s*\(/);
    expect(nativeSpec).not.toMatch(/\bverifySecret\s*\(/);
    expect(nativeSpec).not.toMatch(/\bsetWalletPassword\s*\(/);
  });

  it('exposes no generic wallet-file deletion and rechecks empty Fast Wallet removal natively', () => {
    expect(nativeSpec).toContain('deleteEmptyWalletFiles(');
    expect(nativeSpec).not.toMatch(/\bdeleteWalletFiles\s*\(/);
    expect(nativeAdapter).not.toMatch(/\bdeleteWalletFiles\s*:/);
    expect(androidWalletModule).toContain(
      'override fun deleteEmptyWalletFiles(',
    );
    expect(androidWalletModule).toContain(
      'NativeMoneroWalletJni.snapshot(walletId)',
    );
    expect(androidWalletModule).toContain(
      'java.math.BigInteger(balanceAtomic) == java.math.BigInteger.ZERO',
    );
    expect(iosWalletModule).toContain('- (void)deleteEmptyWalletFiles:');
    expect(iosWalletModule).toContain('if (!snapshot.synchronized)');
    expect(iosWalletModule).toContain('if (snapshot.balanceAtomic != 0)');
  });

  it('never returns a recovery seed through the React Native API', () => {
    expect(nativeSpec).not.toMatch(/\bgetSeed\s*\(/);
    expect(nativeAdapter).not.toMatch(/\bgetSeed\s*:/);
    expect(nativeSpec).toContain('presentRecoverySeed(');
    expect(nativeAdapter).toContain('presentRecoverySeed:');
    expect(settingsScreen).toContain('walletService.presentRecoverySeed(');
    expect(walletSetupScreen).toContain('walletService.presentRecoverySeed(');
    expect(walletSetupScreen).not.toContain('seedModal');
    expect(androidWalletModule).toContain('AlertDialog.Builder(activity)');
    expect(iosWalletModule).toContain(
      'alertControllerWithTitle:@"Recovery seed"',
    );
  });

  it('requires an exact, single-use native transaction approval', () => {
    expect(androidWalletModule).toContain(
      'NativeSensitiveApprovalState.consume(walletId, pendingId)',
    );
    expect(androidWalletModule).toContain('TRANSACTION_APPROVAL_TTL_MS');
    expect(androidWalletModule).toContain('requestFreshAuthorization(');
    expect(androidWalletModule).toContain('.setTitle("Confirm transaction")');

    expect(iosWalletModule).toContain(
      '[_pendingTransactionApprovals removeObjectForKey:pendingId]',
    );
    expect(iosWalletModule).toContain('[self requestFreshAuthorization:');
    expect(iosWalletModule).toContain(
      'alertControllerWithTitle:@"Confirm transaction"',
    );
  });

  it('keeps private-phone request plaintext and keys below React Native', () => {
    expect(nativeSpec).toContain('requestPrivatePhoneAddress(');
    expect(nativeSpec).toContain('pollPrivatePhoneAddressRequest(');
    expect(nativeSpec).toContain('pollIncomingPrivatePhoneAddressRequests()');
    expect(nativeSpec).toContain('respondPrivatePhoneAddressRequest(');
    expect(androidWalletModule).toContain(
      'override fun requestPrivatePhoneAddress(',
    );
    expect(iosWalletModule).toContain('- (void)requestPrivatePhoneAddress:');
    expect(privatePhoneRequests).not.toMatch(
      /phoneTokenHex|pairIdHex|privateKeyHex|hpkePublicKeyHex|requestState|envelopeHex/,
    );
  });

  it('drops wallet canaries and arbitrary strings from diagnostic logs', () => {
    const canaries = [
      'seed-canary-alpha-beta-gamma',
      '49walletAddressCanary',
      '/private/wallet/path',
      'https://scanner.example',
      'wallet-id-canary',
      '5000000000000',
    ];
    const line = formatWalletLogLine('WalletService', 'security.canary', {
      address: canaries[1],
      amountAtomic: canaries[5],
      count: 2,
      network: 'mainnet',
      path: canaries[2],
      scannerUrl: canaries[3],
      seed: canaries[0],
      status: canaries[4],
      walletId: canaries[4],
    });

    for (const canary of canaries) {
      expect(line).not.toContain(canary);
    }
    expect(line).toContain('"count":2');
    expect(line).toContain('"network":"mainnet"');
  });

  it('records only a bounded failure class instead of sensitive error text', () => {
    const line = formatWalletLogLine('WalletService', 'open.error', {
      error:
        'Could not read /private/wallet/path for 49walletAddressCanary: app session is locked',
    });

    expect(line).toContain('"failureCode":"app-locked"');
    expect(line).not.toContain('/private/wallet/path');
    expect(line).not.toContain('49walletAddressCanary');
    expect(classifyDiagnosticFailure('operation timed out')).toBe('timeout');
    expect(classifyDiagnosticFailure('specified file already exists')).toBe(
      'file-exists',
    );
    expect(classifyDiagnosticFailure('TLS socket connection failed')).toBe(
      'network',
    );
  });

  it('keeps native diagnostics behind an explicit release build flag', () => {
    expect(walletEngine).toMatch(
      /void logEngineDiagnostic[\s\S]*?#if defined\(NDEBUG\) && !TEX8_WALLET_DIAGNOSTICS[\s\S]*?\(void\)fields;/,
    );
    expect(walletEngine).toContain(
      'safeFields.find(field.first) == safeFields.end()',
    );
  });

  it('serializes native wallet work off the React Native module thread', () => {
    expect(androidWalletModule).toContain(
      'Executors.newSingleThreadExecutor',
    );
    expect(androidWalletModule).toContain('"mfw-native-wallet"');
    expect(androidWalletModule).toContain('nativeWalletExecutor.execute');
    expect(androidWalletModule).toContain('"queuedMs" to');
    expect(androidWalletModule).toContain(
      'if (!requireAppAuthorized(promise))',
    );
  });
});
