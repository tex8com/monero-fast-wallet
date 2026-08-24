import {
  applyMfwNameBroadcast,
  estimateMfwNameExpiryTimestampMs,
  effectiveMfwOwnedNameStage,
  loadMfwOwnedNames,
  mfwNameRemainingBlocks,
  mfwNameRemainingDays,
  reconcileMfwNameTransactionState,
  upsertMfwOwnedName,
  type MfwOwnedNameRecord,
} from '../MfwNameRegistrationRegistry';
import {
  loadProtectedMetadata,
  storeProtectedMetadata,
} from '../ProtectedMetadataStorage';

jest.mock('../ProtectedMetadataStorage', () => ({
  loadProtectedMetadata: jest.fn(),
  storeProtectedMetadata: jest.fn(),
}));

const mockedLoad = loadProtectedMetadata as jest.MockedFunction<
  typeof loadProtectedMetadata
>;
const mockedStore = storeProtectedMetadata as jest.MockedFunction<
  typeof storeProtectedMetadata
>;

const record: MfwOwnedNameRecord = {
  version: 1,
  id: 'name-1',
  canonicalName: 'alice.mfw',
  walletRegistrationId: 'wallet-1',
  walletAddressId: 'wallet-1:0:2',
  address: '8'.repeat(95),
  network: 'mainnet',
  stage: 'active',
  termYears: 2,
  sequence: 0,
  ownerPublicKeyHex: '1'.repeat(64),
  sourceTxidHex: '2'.repeat(64),
  expiryHeight: 2_000,
  lastChainTipHeight: 1_000,
  createdAt: '2026-07-26T00:00:00.000Z',
  updatedAt: '2026-07-26T00:00:00.000Z',
};

const normalizedRecord: MfwOwnedNameRecord = {
  ...record,
  commitHeight: undefined,
  commitTxidHex: undefined,
  ownerAuthority: 'local',
  pendingAddress: undefined,
  recoveryExportedAt: undefined,
};

describe('MFW owned name registry', () => {
  beforeEach(() => {
    mockedLoad.mockReset();
    mockedStore.mockReset();
  });

  it('lists normalized non-secret name records', async () => {
    mockedLoad.mockResolvedValue(
      JSON.stringify({ version: 1, names: [record] }),
    );
    await expect(loadMfwOwnedNames()).resolves.toEqual([normalizedRecord]);
    expect(JSON.stringify(record)).not.toMatch(/ownerSecret|privateKey|salt/i);
  });

  it('upserts the protected local list', async () => {
    mockedLoad
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce(JSON.stringify({ version: 1, names: [record] }));
    mockedStore.mockResolvedValue();
    await expect(upsertMfwOwnedName(record)).resolves.toEqual([normalizedRecord]);
    expect(mockedStore).toHaveBeenCalledWith(
      expect.stringContaining('mfw-name-registrations'),
      expect.stringContaining('alice.mfw'),
    );
  });

  it('calculates block-based expiry and approximate remaining days', () => {
    expect(mfwNameRemainingBlocks(2_000, 1_000)).toBe(1_000);
    expect(mfwNameRemainingDays(2_000, 1_000)).toBe(2);
    expect(mfwNameRemainingDays(1_000, 1_000)).toBe(0);
    const observedAtMs = Date.UTC(2026, 7, 15, 12, 0, 0);
    expect(
      estimateMfwNameExpiryTimestampMs(1_030, 1_000, observedAtMs),
    ).toBe(observedAtMs + 30 * 2 * 60 * 1000);
    expect(
      estimateMfwNameExpiryTimestampMs(970, 1_000, observedAtMs),
    ).toBe(observedAtMs - 30 * 2 * 60 * 1000);
    expect(
      estimateMfwNameExpiryTimestampMs(0, 1_000, observedAtMs),
    ).toBeUndefined();
    expect(
      effectiveMfwOwnedNameStage({
        ...record,
        expiryHeight: 1_000,
        lastChainTipHeight: 1_000,
      }),
    ).toBe('expired');
  });

  it('binds the single broadcast txid and opens the reveal window only after maturity', () => {
    const committed = applyMfwNameBroadcast(
      {
        ...record,
        stage: 'commit-pending',
        sourceTxidHex: undefined,
      },
      {
        registrationId: record.id,
        kind: 'commit',
        years: 2,
        txIds: ['a'.repeat(64)],
      },
      '2026-07-27T00:00:00.000Z',
    );
    expect(committed.commitTxidHex).toBe('a'.repeat(64));
    const transaction = {
      hash: 'a'.repeat(64),
      paymentId: '',
      description: '',
      label: '',
      direction: 'out',
      pending: false,
      failed: false,
      coinbase: false,
      amountAtomic: '1',
      feeAtomic: '10',
      blockHeight: 3_727_100,
      confirmations: 15,
      unlockTime: 0,
      timestamp: 0,
      subaddrAccount: 0,
      subaddrIndices: [],
      transfers: [],
    };
    expect(
      reconcileMfwNameTransactionState(committed, [transaction], 15, 720).stage,
    ).toBe('reveal-ready');
    expect(
      reconcileMfwNameTransactionState(
        committed,
        [{ ...transaction, confirmations: 14 }],
        15,
        720,
      ).stage,
    ).toBe('commit-pending');
    expect(
      reconcileMfwNameTransactionState(
        committed,
        [{ ...transaction, confirmations: 721 }],
        15,
        720,
      ).stage,
    ).toBe('failed');
  });

  it('rejects ambiguous multi-transaction name broadcasts', () => {
    expect(() =>
      applyMfwNameBroadcast(record, {
        registrationId: record.id,
        kind: 'claim',
        years: 2,
        txIds: ['a'.repeat(64), 'b'.repeat(64)],
      }),
    ).toThrow('does not match');
  });

  it('tracks owner-signed address updates and revocations separately', () => {
    const updated = applyMfwNameBroadcast(
      {
        ...record,
        pendingAddress: '4'.repeat(95),
      },
      {
        registrationId: record.id,
        kind: 'update',
        years: record.termYears,
        txIds: ['b'.repeat(64)],
      },
    );
    expect(updated.stage).toBe('update-pending');
    expect(updated.pendingAddress).toBe('4'.repeat(95));
    expect(updated.sourceTxidHex).toBe('b'.repeat(64));

    const revoked = applyMfwNameBroadcast(record, {
      registrationId: record.id,
      kind: 'revoke',
      years: record.termYears,
      txIds: ['c'.repeat(64)],
    });
    expect(revoked.stage).toBe('revoke-pending');
    expect(revoked.sourceTxidHex).toBe('c'.repeat(64));

    expect(() =>
      applyMfwNameBroadcast(record, {
        registrationId: record.id,
        kind: 'update',
        years: record.termYears,
        txIds: ['d'.repeat(64)],
      }),
    ).toThrow('missing its destination');
  });
});
