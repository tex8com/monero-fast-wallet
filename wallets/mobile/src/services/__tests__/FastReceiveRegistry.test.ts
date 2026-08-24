jest.mock('@react-native-async-storage/async-storage', () => {
  const storage = new Map<string, string>();
  const mock = {
    clear: jest.fn(async () => {
      storage.clear();
    }),
    getItem: jest.fn(async (key: string) => storage.get(key) ?? null),
    setItem: jest.fn(async (key: string, value: string) => {
      storage.set(key, value);
    }),
  };

  return {
    __esModule: true,
    default: mock,
  };
});

import AsyncStorage from '@react-native-async-storage/async-storage';

import {
  applyGlobalFastWalletDeliveryState,
  createFastReceiveIdentityId,
  createFastReceiveIdentityRecord,
  FAST_RECEIVE_IDENTITIES_STORAGE_KEY,
  isIndependentFastReceiveIdentityId,
  loadFastReceiveIdentities,
  loadRetiredFastWalletSlots,
  nextFastReceiveDerivationIndex,
  removeFastReceiveIdentity,
  reserveRetiredFastWalletSlot,
  upsertFastReceiveIdentity,
} from '../FastReceiveRegistry';

describe('FastReceiveRegistry', () => {
  beforeEach(async () => {
    await AsyncStorage.clear();
  });

  it('persists fast receive metadata without private keys', async () => {
    const record = createFastReceiveIdentityRecord(
      {
        id: 'fast-receive-v2-0',
        label: 'Fast Receive',
        path: '/app/wallets/stagenet/fast-receive-v2-0',
        address: '54A1testAddress',
        network: 'stagenet',
        restoreHeight: 123,
        derivationIndex: 0,
        scannerStatus: 'local-only',
      },
      '2026-06-17T00:00:00.000Z',
      {
        credentialKey: 'monero.wallet.fast.stagenet.fast-receive-v2-0.v2',
        sourceWalletId: 'software-stagenet-primary',
      },
    );

    await upsertFastReceiveIdentity(record);

    const persisted = await AsyncStorage.getItem(
      FAST_RECEIVE_IDENTITIES_STORAGE_KEY,
    );
    expect(persisted).not.toBeNull();
    expect(JSON.parse(persisted ?? '[]')).toEqual([
      {
        id: 'fast-receive-v2-0',
        label: 'Fast Wallet',
        path: '/app/wallets/stagenet/fast-receive-v2-0',
        address: '54A1testAddress',
        network: 'stagenet',
        credentialKey: 'monero.wallet.fast.stagenet.fast-receive-v2-0.v2',
        sourceWalletId: 'software-stagenet-primary',
        restoreHeight: 123,
        derivationIndex: 0,
        status: 'local-only',
        scannerStatus: 'local-only',
        scannerUrl: '',
        notificationsEnabled: false,
        workerReceiptVerified: false,
        createdAt: '2026-06-17T00:00:00.000Z',
        updatedAt: '2026-06-17T00:00:00.000Z',
      },
    ]);
    expect(persisted).not.toContain('private');
    expect(persisted).not.toContain('viewKey');
    expect(persisted).not.toContain('spend');
    expect(persisted).not.toContain('seed');
    expect(persisted).not.toContain('password');
  });

  it('loads records and derives the next identity index', async () => {
    await upsertFastReceiveIdentity(
      createFastReceiveIdentityRecord(
        {
          id: 'fast-receive-v2-0',
          label: 'Fast Receive',
          path: '/app/wallets/stagenet/fast-receive-v2-0',
          address: '54A1testAddress',
          network: 'stagenet',
          restoreHeight: 10,
          derivationIndex: 0,
          scannerStatus: 'local-only',
        },
        '2026-06-17T00:00:00.000Z',
      ),
    );

    const loaded = await loadFastReceiveIdentities();

    expect(loaded).toHaveLength(1);
    expect(nextFastReceiveDerivationIndex(loaded)).toBe(199);
  });

  it('creates stable path-safe identity ids', () => {
    const id = createFastReceiveIdentityId(
      2,
      new Date('2026-06-17T12:34:56.000Z'),
    );
    expect(id).toBe('fast-receive-v2-2-20260617T123456');
    expect(isIndependentFastReceiveIdentityId(id)).toBe(true);
  });

  it('keeps a key-free tombstone so a previously hosted slot is never reused', async () => {
    await reserveRetiredFastWalletSlot(
      'mainnet',
      199,
      '2026-08-10T15:00:00.000Z',
    );
    await reserveRetiredFastWalletSlot(
      'mainnet',
      199,
      '2026-08-10T15:01:00.000Z',
    );

    await expect(loadRetiredFastWalletSlots()).resolves.toEqual([
      {
        network: 'mainnet',
        productSlot: 199,
        retiredAt: '2026-08-10T15:00:00.000Z',
      },
    ]);
    expect(nextFastReceiveDerivationIndex([], [199])).toBe(200);
  });

  it('marks legacy v1 identities as blocked without deleting metadata', async () => {
    await AsyncStorage.setItem(
      FAST_RECEIVE_IDENTITIES_STORAGE_KEY,
      JSON.stringify([
        {
          id: 'fast-receive-2-legacy',
          label: 'Legacy Fast Wallet',
          path: '/app/wallets/stagenet/fast-receive-2-legacy',
          address: '54A1legacyAddress',
          network: 'stagenet',
          restoreHeight: 123,
          derivationIndex: 2,
          status: 'enabled',
          scannerStatus: 'enabled',
          scannerUrl: 'https://xmr.tex8.com',
          createdAt: '2026-06-17T00:00:00.000Z',
          updatedAt: '2026-06-17T00:00:00.000Z',
        },
      ]),
    );

    await expect(loadFastReceiveIdentities()).resolves.toEqual([
      expect.objectContaining({
        id: 'fast-receive-2-legacy',
        status: 'legacy-blocked',
        scannerStatus: 'legacy-blocked',
      }),
    ]);
  });

  it('removes a fast receive identity from the local registry', async () => {
    await upsertFastReceiveIdentity(
      createFastReceiveIdentityRecord(
        {
          id: 'fast-receive-v2-0',
          label: 'Fast Receive',
          path: '/app/wallets/stagenet/fast-receive-v2-0',
          address: '54A1testAddress',
          network: 'stagenet',
          restoreHeight: 10,
          derivationIndex: 0,
          scannerStatus: 'local-only',
        },
        '2026-06-17T00:00:00.000Z',
      ),
    );

    const next = await removeFastReceiveIdentity('fast-receive-v2-0');

    expect(next).toEqual([]);
    expect(await loadFastReceiveIdentities()).toEqual([]);
  });

  it('models provider delivery as one installation-wide switch', () => {
    const first = {
      ...createFastReceiveIdentityRecord({
        id: 'fast-receive-v2-first',
        label: 'First',
        path: '/wallets/first',
        address: '54A1firstAddress',
        network: 'stagenet' as const,
        restoreHeight: 1,
        derivationIndex: 0,
        scannerStatus: 'enabled',
      }),
      assignmentHandle: '11'.repeat(32),
      notificationsEnabled: false,
    };
    const localOnly = createFastReceiveIdentityRecord({
      id: 'fast-receive-v2-local',
      label: 'Local',
      path: '/wallets/local',
      address: '54A1localAddress',
      network: 'stagenet',
      restoreHeight: 2,
      derivationIndex: 1,
      scannerStatus: 'local-only',
    });

    const enabled = applyGlobalFastWalletDeliveryState(
      [first, localOnly],
      true,
      '2026-07-26T00:00:00.000Z',
    );
    expect(enabled.map(identity => identity.notificationsEnabled)).toEqual([
      true,
      false,
    ]);

    const disabled = applyGlobalFastWalletDeliveryState(
      enabled,
      false,
      '2026-07-26T00:01:00.000Z',
    );
    expect(disabled.map(identity => identity.notificationsEnabled)).toEqual([
      false,
      false,
    ]);
  });
});
