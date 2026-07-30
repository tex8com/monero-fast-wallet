import {
  MFW_NAME_ANNUAL_FEE_ATOMIC,
  canonicalMfwName,
  createMfwNameRegistrationDraft,
  mfwNameRegistrationFeeAtomic,
  validateMfwNameSendPreset,
} from '../MfwNameRegistration';

describe('MFW name registration UI boundary', () => {
  it('canonicalizes the application suffix without allowing Unicode lookalikes', () => {
    expect(canonicalMfwName(' Alice.MFW ')).toBe('alice.mfw');
    expect(canonicalMfwName('alice-2')).toBe('alice-2.mfw');
    expect(() => canonicalMfwName('аlice')).toThrow();
    expect(() => canonicalMfwName('-alice')).toThrow();
    expect(() => canonicalMfwName('alice_2')).toThrow();
  });

  it('prices only identical whole protocol years', () => {
    expect(mfwNameRegistrationFeeAtomic(1)).toBe(MFW_NAME_ANNUAL_FEE_ATOMIC);
    expect(mfwNameRegistrationFeeAtomic(5)).toBe(50_000_000_000n);
    expect(() => mfwNameRegistrationFeeAtomic(0)).toThrow();
    expect(() => mfwNameRegistrationFeeAtomic(1.5)).toThrow();
  });

  it('creates a public draft without owner secret, salt or tx_extra', () => {
    const draft = createMfwNameRegistrationDraft({
      walletRegistrationId: 'wallet-1',
      walletAddressId: 'wallet-1:0:4',
      address: '4'.repeat(95),
      network: 'mainnet',
      name: 'Alice',
      years: 3,
      maximumTermYears: 5,
      now: '2026-07-26T00:00:00.000Z',
    });

    expect(draft.name).toBe('alice.mfw');
    expect(draft.registrationFeeAtomic).toBe('30000000000');
    expect(JSON.stringify(draft)).not.toMatch(
      /ownerSecret|privateKey|commitSalt|txExtra/i,
    );
  });

  it('accepts only native-prepared, locked registration approvals', () => {
    const preset = validateMfwNameSendPreset({
      version: 1,
      flowId: 'flow-1',
      registrationId: 'registration-1',
      walletRegistrationId: 'wallet-1',
      name: 'alice.mfw',
      years: 2,
      kind: 'claim',
      destinationAddress: '4'.repeat(95),
      preparedTransaction: {
        id: 'native-pending-1',
        status: 'ok',
        error: '',
        amountAtomic: '20000000000',
        dustAtomic: '0',
        feeAtomic: '1234',
        txCount: 1,
        txIds: [],
        subaddrAccounts: [],
        subaddrIndices: [],
      },
    });
    expect(preset?.kind).toBe('claim');
    expect(
      validateMfwNameSendPreset({
        ...preset,
        preparedTransaction: { ...preset?.preparedTransaction, id: '' },
      }),
    ).toBeUndefined();
  });

  it('accepts a native-prepared renewal as the same locked approval type', () => {
    const preset = validateMfwNameSendPreset({
      version: 1,
      flowId: 'renew-flow-1',
      registrationId: 'registration-1',
      walletRegistrationId: 'wallet-1',
      name: 'alice.mfw',
      years: 3,
      kind: 'renew',
      destinationAddress: '4'.repeat(95),
      preparedTransaction: {
        id: 'native-renewal-1',
        status: 'ok',
        error: '',
        amountAtomic: '30000000000',
        dustAtomic: '0',
        feeAtomic: '1234',
        txCount: 1,
        txIds: [],
        subaddrAccounts: [],
        subaddrIndices: [],
      },
    });
    expect(preset?.kind).toBe('renew');
  });

  it.each(['update', 'revoke'] as const)(
    'accepts a native-prepared %s transition as a locked approval',
    kind => {
      const preset = validateMfwNameSendPreset({
        version: 1,
        flowId: `${kind}-flow-1`,
        registrationId: 'registration-1',
        walletRegistrationId: 'wallet-1',
        name: 'alice.mfw',
        years: 2,
        kind,
        destinationAddress: '4'.repeat(95),
        preparedTransaction: {
          id: `native-${kind}-1`,
          status: 'ok',
          error: '',
          amountAtomic: '1',
          dustAtomic: '0',
          feeAtomic: '1234',
          txCount: 1,
          txIds: [],
          subaddrAccounts: [],
          subaddrIndices: [],
        },
      });
      expect(preset?.kind).toBe(kind);
    },
  );
});
