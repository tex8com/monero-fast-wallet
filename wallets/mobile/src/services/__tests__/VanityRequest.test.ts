import {
  createVanitySearchDraft,
  createVanityWorkerSearchInput,
  validateVanitySearchDraft,
} from '../VanityRequest';

const PUBLIC_ADDRESS = `4${'A'.repeat(94)}`;
const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const prefixAt = (index: number) =>
  `4A${BASE58[Math.floor(index / BASE58.length)]}${BASE58[index % BASE58.length]}`;

describe('VanityRequest', () => {
  it('binds the selected local wallet to up to 100 different prefixes', () => {
    const prefixes = Array.from({length: 100}, (_, index) => prefixAt(index));
    const draft = createVanitySearchDraft({
      sourceWalletRegistrationId: 'wallet-2',
      walletKind: 'software',
      network: 'mainnet',
      sourcePublicAddress: PUBLIC_ADDRESS,
      prefixes,
    });

    expect(validateVanitySearchDraft(draft)).toEqual(draft);
    expect(createVanityWorkerSearchInput(draft)).toEqual({
      version: 1,
      kind: 'monero',
      network: 'mainnet',
      public_address: PUBLIC_ADDRESS,
      prefixes,
    });
  });

  it('never includes the local wallet id or any private key in worker input', () => {
    const draft = createVanitySearchDraft({
      sourceWalletRegistrationId: 'local-wallet-id',
      walletKind: 'software',
      network: 'mainnet',
      sourcePublicAddress: PUBLIC_ADDRESS,
      prefixes: ['4A', '4B'],
    });
    const workerInput = createVanityWorkerSearchInput(draft) as Record<
      string,
      unknown
    >;

    expect(workerInput.sourceWalletRegistrationId).toBeUndefined();
    expect(
      Object.keys(workerInput).some(key => /private|secret|seed/i.test(key)),
    ).toBe(false);
  });

  it('rejects unsupported wallets, duplicate prefixes and lists over 100', () => {
    const input = {
      sourceWalletRegistrationId: 'wallet-1',
      walletKind: 'software',
      network: 'mainnet',
      sourcePublicAddress: PUBLIC_ADDRESS,
      prefixes: ['4A'],
    };

    expect(() =>
      createVanitySearchDraft({
        ...input,
        prefixes: Array.from({length: 101}, (_, index) => prefixAt(index)),
      }),
    ).toThrow();
    expect(() =>
      createVanitySearchDraft({...input, prefixes: ['4A', '4A']}),
    ).toThrow();
    expect(() =>
      createVanitySearchDraft({...input, walletKind: 'hardware'}),
    ).toThrow();
    expect(() =>
      createVanitySearchDraft({...input, network: 'stagenet'}),
    ).toThrow();
    expect(() =>
      createVanitySearchDraft({...input, prefixes: ['4ABCDEFGHJ']}),
    ).not.toThrow();
    expect(() =>
      createVanitySearchDraft({...input, prefixes: ['4ABCDEFGHJK']}),
    ).toThrow();
  });
});
