import {readFileSync} from 'fs';
import {resolve} from 'path';

import {formatWalletLogLine} from '../WalletLogger';

const mobileRoot = resolve(__dirname, '..', '..', '..');

function source(...parts: string[]) {
  return readFileSync(resolve(mobileRoot, ...parts), 'utf8');
}

const nativeSpec = source('specs', 'NativeMoneroWallet.ts');
const nativeAdapter = source('src', 'services', 'NativeMoneroWallet.ts');
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
    expect(walletSetupScreen).not.toMatch(/\bconst\s*\[\s*(?:seed|mnemonic)\b/i);
    expect(walletSetupScreen).not.toMatch(/\bset(?:Seed|Mnemonic)\s*\(/);
    expect(androidWalletModule).toContain(
      'override fun restoreWalletWithNativeSeed(',
    );
    expect(iosWalletModule).toContain(
      '- (void)restoreWalletWithNativeSeed:',
    );
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
    expect(iosWalletModule).toContain(
      '[self requestFreshAuthorization:',
    );
    expect(iosWalletModule).toContain(
      'alertControllerWithTitle:@"Confirm transaction"',
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

  it('compiles native diagnostics out of release builds', () => {
    expect(walletEngine).toMatch(
      /void logEngineDiagnostic[\s\S]*?#if defined\(NDEBUG\)[\s\S]*?\(void\)fields;/,
    );
    expect(walletEngine).toContain(
      'safeFields.find(field.first) == safeFields.end()',
    );
  });
});
