import {readFileSync} from 'fs';
import {resolve} from 'path';

const mobileRoot = resolve(__dirname, '..', '..', '..');
const setupSource = readFileSync(
  resolve(mobileRoot, 'src', 'screens', 'WalletSetupScreen.tsx'),
  'utf8',
);
const walletsSource = readFileSync(
  resolve(mobileRoot, 'src', 'screens', 'WalletsScreen.tsx'),
  'utf8',
);

describe('app-wide protection UI contract', () => {
  it('never renders an individual wallet password field while opening a wallet', () => {
    expect(setupSource).not.toContain('value={walletPassword}');
    expect(setupSource).not.toContain('openRegisteredWallet(walletPassword)');
    expect(setupSource).toContain("setPasswordPromptMode('restore')");
  });

  it('requires the stored device credential for Fast Wallet management', () => {
    expect(walletsSource).toContain('hasSecureWalletCredential');
    expect(walletsSource).not.toContain("t('settings.walletPassword')");
    expect(walletsSource).not.toContain('password: needsPassword');
  });
});
