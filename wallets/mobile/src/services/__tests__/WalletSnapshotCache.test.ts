import { loadProtectedMetadata, storeProtectedMetadata } from '../ProtectedMetadataStorage';
import { loadWalletSnapshotCache, pruneWalletSnapshotCache, saveWalletSnapshot } from '../WalletSnapshotCache';
import type { WalletSnapshot } from '../NativeMoneroWallet';
import { nextWalletPublication } from '../../../../../packages/wallet-shared/src/walletSync';

jest.mock('../ProtectedMetadataStorage', () => ({
  loadProtectedMetadata: jest.fn(), storeProtectedMetadata: jest.fn(),
}));

const mockedLoad = loadProtectedMetadata as jest.MockedFunction<typeof loadProtectedMetadata>;
const mockedStore = storeProtectedMetadata as jest.MockedFunction<typeof storeProtectedMetadata>;
const snapshot = {
  id: 'old-session', path: '/synthetic/wallet', primaryAddress: '4'.repeat(95),
  balanceAtomic: '3000000000000', unlockedBalanceAtomic: '2000000000000',
  walletHeight: 100, daemonHeight: 100, daemonTargetHeight: 100,
  synchronized: true, snapshotRevision: 900,
  spendAccountIndex: 1, spendPrimaryAddress: '8'.repeat(95),
  spendBalanceAtomic: '2000000000000', spendUnlockedBalanceAtomic: '1000000000000',
} as WalletSnapshot;

describe('durable wallet snapshots', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedLoad.mockResolvedValue(JSON.stringify({ saved: snapshot }));
    mockedStore.mockResolvedValue(undefined);
  });

  it('preserves a complete, consistent transaction account scope', async () => {
    expect((await loadWalletSnapshotCache()).saved).toMatchObject({
      spendAccountIndex: 1, spendPrimaryAddress: snapshot.spendPrimaryAddress,
      spendBalanceAtomic: '2000000000000', spendUnlockedBalanceAtomic: '1000000000000',
    });
  });

  it.each([
    ['missing field', { spendPrimaryAddress: undefined }],
    ['fractional index', { spendAccountIndex: 0.5 }],
    ['negative index', { spendAccountIndex: -1 }],
    ['overflowing index', { spendAccountIndex: 4_294_967_296 }],
    ['malformed amount', { spendBalanceAtomic: 'invalid' }],
    ['overflowing amount', { spendBalanceAtomic: '18446744073709551616' }],
    ['negative amount', { spendUnlockedBalanceAtomic: '-1' }],
    ['unlocked exceeds account balance', { spendBalanceAtomic: '1' }],
    ['account exceeds aggregate balance', { spendBalanceAtomic: '4000000000000' }],
    ['account unlocked exceeds aggregate', { spendUnlockedBalanceAtomic: '3000000000000', spendBalanceAtomic: '3000000000000' }],
  ])('drops the entire optional scope for %s without fabricating one', async (_name, overrides) => {
    mockedLoad.mockResolvedValue(JSON.stringify({ saved: { ...snapshot, ...(overrides as object) } }));
    const loaded = (await loadWalletSnapshotCache()).saved;
    expect(loaded.balanceAtomic).toBe(snapshot.balanceAtomic);
    expect(loaded).not.toHaveProperty('spendAccountIndex');
    expect(loaded).not.toHaveProperty('spendPrimaryAddress');
    expect(loaded).not.toHaveProperty('spendBalanceAtomic');
    expect(loaded).not.toHaveProperty('spendUnlockedBalanceAtomic');
  });

  it('keeps zero unlocked funds as a known locked balance', async () => {
    mockedLoad.mockResolvedValue(JSON.stringify({ saved: { ...snapshot, spendUnlockedBalanceAtomic: '0' } }));
    expect((await loadWalletSnapshotCache()).saved.spendUnlockedBalanceAtomic).toBe('0');
  });

  it('does not persist or replay a native-session revision', async () => {
    const loaded = (await loadWalletSnapshotCache()).saved;
    expect(loaded).not.toHaveProperty('snapshotRevision');
    await saveWalletSnapshot('fresh', snapshot);
    const saved = JSON.parse(mockedStore.mock.calls[0][1]);
    expect(saved.fresh).not.toHaveProperty('snapshotRevision');
    expect(saved.fresh.spendUnlockedBalanceAtomic).toBe('1000000000000');
  });

  it('allows a reopened native session to publish revision one after cached hydration', async () => {
    const cached = (await loadWalletSnapshotCache()).saved;
    const previous = nextWalletPublication<WalletSnapshot, string>(undefined, {
      snapshot: cached, transactions: ['cached'],
      requiresLedgerVerification: false, ledgerVerified: true,
    });
    const fresh = nextWalletPublication<WalletSnapshot, string>(previous, {
      snapshot: { ...snapshot, id: 'new-session', snapshotRevision: 1 },
      transactions: ['fresh'], requiresLedgerVerification: false, ledgerVerified: true,
    });
    expect(fresh.publishedRevision).toBe(1);
    expect(fresh.publishedSnapshot?.id).toBe('new-session');
    expect(fresh.publishedTransactions).toEqual(['fresh']);
  });

  it('preserves a swept zero balance while another wallet saves concurrently', async () => {
    let durable = JSON.stringify({ fast: snapshot, other: snapshot });
    mockedLoad.mockImplementation(async () => durable);
    mockedStore.mockImplementation(async (_key, value) => { durable = value; });
    const swept = {
      ...snapshot, balanceAtomic: '0', unlockedBalanceAtomic: '0',
      spendBalanceAtomic: '0', spendUnlockedBalanceAtomic: '0',
    };
    await Promise.all([
      saveWalletSnapshot('fast', swept),
      saveWalletSnapshot('other', snapshot),
    ]);
    const loaded = await loadWalletSnapshotCache();
    expect(loaded.fast.balanceAtomic).toBe('0');
    expect(loaded.other.balanceAtomic).toBe(snapshot.balanceAtomic);
  });

  it('does not resurrect a pruned wallet when a concurrent wallet saves', async () => {
    let durable = JSON.stringify({ retired: snapshot, other: snapshot });
    mockedLoad.mockImplementation(async () => durable);
    mockedStore.mockImplementation(async (_key, value) => { durable = value; });
    await Promise.all([
      pruneWalletSnapshotCache(['other']),
      saveWalletSnapshot('other', snapshot),
    ]);
    expect(await loadWalletSnapshotCache()).not.toHaveProperty('retired');
  });

  it('continues saving after an earlier storage failure', async () => {
    mockedStore.mockRejectedValueOnce(new Error('synthetic storage failure'));
    const results = await Promise.allSettled([
      saveWalletSnapshot('failed', snapshot),
      saveWalletSnapshot('next', snapshot),
    ]);
    expect(results.map(result => result.status)).toEqual(['rejected', 'fulfilled']);
  });
});
