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

  it('keeps backup, alert opt-in, delivery opt-out and hosted deletion separate', () => {
    expect(walletsScreen).toContain('Back up recovery words');
    expect(walletsScreen).toContain('Turn alerts on');
    expect(walletsScreen).toContain('Turn all alerts off');
    expect(walletsScreen).toContain('Delete scan data');
    expect(walletsScreen).toContain(
      'A viewing key already shared with a service cannot be made secret again',
    );
  });

  it('distinguishes official enrollment from explicitly paired private enrollment', () => {
    expect(walletsScreen).toContain('Use my own scan service');
    expect(walletsScreen).toContain('parsePrivateFastWalletWorkerQr');
    expect(walletsScreen).toContain(
      'await walletService.pairPrivateFastWalletWorker',
    );
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

  it('does not expose infrastructure terms in the primary action labels', () => {
    expect(walletsScreen).not.toContain('Turn HPKE on');
    expect(walletsScreen).not.toContain('Upload private view key');
    expect(walletsScreen).not.toContain('Register scanner');
  });
});
