import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  canUseMfwClaimRelay,
  mfwClaimRelayReadiness,
  scheduleServerMfwClaim,
  refreshMfwClaimRelayJobs,
  assertNoHeldMfwClaim,
  cancelServerMfwClaim,
} from '../MfwClaimRelayService';
import { torFetch } from '../TorHttp';
import { loadActiveNodeConnectionSettings } from '../NodeConnectionSettings';
import {
  loadMfwOwnedNames,
  upsertMfwOwnedName,
} from '../MfwNameRegistrationRegistry';

jest.mock('@react-native-async-storage/async-storage', () => {
  const entries = new Map<string, string>();
  return {
    __esModule: true,
    default: {
      getItem: jest.fn(async (key: string) => entries.get(key) ?? null),
      setItem: jest.fn(async (key: string, value: string) => {
        entries.set(key, value);
      }),
      removeItem: jest.fn(async (key: string) => {
        entries.delete(key);
      }),
      clear: jest.fn(async () => {
        entries.clear();
      }),
    },
  };
});

let mockIdentifier = 0;
jest.mock('../NativeMoneroWallet', () => ({
  requireNativeMoneroWallet: () => ({
    createSecureRandomIdentifier: async () =>
      `claim_${String(++mockIdentifier).padStart(48, '0')}`,
  }),
}));
jest.mock('../NodeConnectionSettings', () => ({
  loadActiveNodeConnectionSettings: jest.fn(),
}));
jest.mock('../TorHttp', () => ({ torFetch: jest.fn() }));
jest.mock('../MfwNameRegistrationRegistry', () => ({
  loadMfwOwnedNames: jest.fn(),
  upsertMfwOwnedName: jest.fn(),
}));
const fetchMock = torFetch as jest.Mock;
const input = {
  registrationId: 'name-1',
  walletRegistrationId: 'wallet-1',
  commitTxid: 'ab'.repeat(32),
  claimTxid: 'cd'.repeat(32),
  rawTxHex: '1234',
};
const storageKey = 'monero-fast-wallet.mfw-claim-relay.v1';
function response(jobId: string, state = 'waiting') {
  return {
    ok: true,
    status: 200,
    json: async () => ({ jobId, claimTxid: input.claimTxid, state }),
  };
}

beforeEach(async () => {
  await AsyncStorage.clear();
  jest.clearAllMocks();
  mockIdentifier = 0;
  (loadActiveNodeConnectionSettings as jest.Mock).mockResolvedValue({
    daemon: { address: 'xmr.tex8.com:18089' },
  });
  (loadMfwOwnedNames as jest.Mock).mockResolvedValue([
    { id: 'name-1', commitTxidHex: input.commitTxid, stage: 'commit-pending' },
  ]);
});

it('uses manual fallback for custom nodes without contacting TEX8', async () => {
  (loadActiveNodeConnectionSettings as jest.Mock).mockResolvedValue({
    daemon: { address: 'https://private.example:18081' },
  });
  expect(await canUseMfwClaimRelay('mainnet')).toBe(false);
  expect(await mfwClaimRelayReadiness('mainnet')).toBe('manual-custom-node');
  expect(await canUseMfwClaimRelay('stagenet')).toBe(false);
  expect(fetchMock).not.toHaveBeenCalled();
});

it('recognizes the legacy TEX8 host and retries a transient capability failure', async () => {
  (loadActiveNodeConnectionSettings as jest.Mock).mockResolvedValue({
    daemon: { address: '152.53.133.188:18089' },
  });
  fetchMock
    .mockRejectedValueOnce(new Error('new Tor circuit'))
    .mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        version: 1,
        network: 'mainnet',
        durable: true,
        commitMaturityBlocks: 15,
        commitRevealWindowBlocks: 720,
      }),
    });
  expect(await mfwClaimRelayReadiness('mainnet')).toBe('ready');
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

it('only accepts the matching durable relay capability', async () => {
  fetchMock.mockResolvedValue({
    ok: true,
    json: async () => ({
      version: 1,
      network: 'mainnet',
      durable: true,
      commitMaturityBlocks: 15,
      commitRevealWindowBlocks: 720,
    }),
  });
  expect(await canUseMfwClaimRelay('mainnet')).toBe(true);
  fetchMock.mockRejectedValue(new Error('offline'));
  expect(await canUseMfwClaimRelay('mainnet')).toBe(false);
});

it('persists before upload and retries identical credentials/bytes after a lost acknowledgement', async () => {
  fetchMock.mockImplementation(async () => {
    expect(
      JSON.parse((await AsyncStorage.getItem(storageKey))!)[0].submission
        .rawTxHex,
    ).toBe('1234');
    throw new Error('timeout after acceptance');
  });
  await scheduleServerMfwClaim(input);
  const first = fetchMock.mock.calls[0];
  await expect(assertNoHeldMfwClaim('wallet-1')).rejects.toThrow('reserved');
  await expect(assertNoHeldMfwClaim('wallet-2')).resolves.toBeUndefined();
  fetchMock.mockResolvedValue(response('1'.padStart(48, '0')));
  await refreshMfwClaimRelayJobs();
  expect(fetchMock.mock.calls[1]).toEqual(first);
  const job = JSON.parse((await AsyncStorage.getItem(storageKey))!)[0];
  expect(job.state).toBe('waiting');
  expect(upsertMfwOwnedName).toHaveBeenLastCalledWith(
    expect.objectContaining({
      claimRelayState: 'waiting',
      stage: 'claim-pending',
    }),
  );
});

it('never turns a send receipt or server confirmation into local ownership', async () => {
  const id = '1'.padStart(48, '0');
  fetchMock.mockResolvedValue(response(id));
  await scheduleServerMfwClaim(input);
  fetchMock.mockResolvedValue(response(id, 'broadcast'));
  await refreshMfwClaimRelayJobs();
  await expect(assertNoHeldMfwClaim('wallet-1')).rejects.toThrow();
  fetchMock.mockResolvedValue(response(id, 'confirmed'));
  await refreshMfwClaimRelayJobs();
  await expect(assertNoHeldMfwClaim('wallet-1')).resolves.toBeUndefined();
  expect(upsertMfwOwnedName).not.toHaveBeenCalledWith(
    expect.objectContaining({ stage: 'active' }),
  );
});

it('does not overwrite a restarted registration with an old relay result', async () => {
  const id = '1'.padStart(48, '0');
  fetchMock.mockResolvedValue(response(id));
  await scheduleServerMfwClaim(input);
  (loadMfwOwnedNames as jest.Mock).mockResolvedValue([
    { id: 'name-1', commitTxidHex: 'ef'.repeat(32), stage: 'commit-pending' },
  ]);
  (upsertMfwOwnedName as jest.Mock).mockClear();
  fetchMock.mockResolvedValue(response(id, 'expired'));
  await refreshMfwClaimRelayJobs();
  expect(upsertMfwOwnedName).not.toHaveBeenCalled();
});

it('keeps inputs reserved on mismatched receipt and corrupt local storage', async () => {
  fetchMock.mockResolvedValue(response('f'.repeat(48)));
  await scheduleServerMfwClaim(input);
  await expect(assertNoHeldMfwClaim('wallet-1')).rejects.toThrow();
  await AsyncStorage.setItem(storageKey, 'broken');
  await expect(assertNoHeldMfwClaim('wallet-1')).rejects.toThrow();
});

it('does not unlock on a refused cancellation and clears raw bytes only after acknowledged cancellation', async () => {
  const id = '1'.padStart(48, '0');
  fetchMock.mockResolvedValue(response(id));
  await scheduleServerMfwClaim(input);
  fetchMock.mockResolvedValue({
    ok: false,
    status: 409,
    json: async () => ({}),
  });
  await expect(cancelServerMfwClaim('name-1')).rejects.toThrow(
    'cancelled safely',
  );
  await expect(assertNoHeldMfwClaim('wallet-1')).rejects.toThrow();
  fetchMock.mockResolvedValue(response(id, 'cancelled'));
  (loadMfwOwnedNames as jest.Mock).mockResolvedValue([
    {
      id: 'name-1',
      commitTxidHex: input.commitTxid,
      claimRelayJobId: id,
      stage: 'claim-pending',
    },
  ]);
  await cancelServerMfwClaim('name-1');
  await expect(assertNoHeldMfwClaim('wallet-1')).resolves.toBeUndefined();
  expect(
    JSON.parse((await AsyncStorage.getItem(storageKey))!)[0].submission
      .rawTxHex,
  ).toBe('');
  expect(upsertMfwOwnedName).toHaveBeenLastCalledWith(
    expect.objectContaining({
      stage: 'commit-pending',
      claimRelayJobId: undefined,
    }),
  );
});

it('rejects claims larger than the native transport budget before storing or transmitting', async () => {
  await expect(
    scheduleServerMfwClaim({ ...input, rawTxHex: 'ab'.repeat(31_000) }),
  ).rejects.toThrow('Invalid signed claim');
  expect(fetchMock).not.toHaveBeenCalled();
  expect(await AsyncStorage.getItem(storageKey)).toBeNull();
});
