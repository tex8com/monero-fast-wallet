const MONERO_BASE58 =
  '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const MAINNET_PRIMARY_ADDRESS_PATTERN = new RegExp(
  `^4[${MONERO_BASE58}]{94}$`,
);

export const VANITY_MAX_PREFIXES = 100;
export const VANITY_MAX_PREFIX_LENGTH = 10;

export type VanitySearchDraft = Readonly<{
  version: 1;
  /** Local-only link back to the wallet chosen by the user. */
  sourceWalletRegistrationId: string;
  network: 'mainnet';
  sourcePublicAddress: string;
  prefixes: readonly string[];
}>;

/** Exact public payload the future service may receive. */
export type VanityWorkerSearchInput = Readonly<{
  version: 1;
  kind: 'monero';
  network: 'mainnet';
  public_address: string;
  prefixes: readonly string[];
}>;

export function createVanitySearchDraft(input: {
  sourceWalletRegistrationId: string;
  walletKind: string;
  network: string;
  sourcePublicAddress: string;
  prefixes: readonly string[];
}): VanitySearchDraft {
  const sourceWalletRegistrationId = input.sourceWalletRegistrationId.trim();
  const sourcePublicAddress = input.sourcePublicAddress.trim();
  const prefixes = input.prefixes.map(prefix => prefix.trim());

  if (
    !sourceWalletRegistrationId ||
    input.walletKind !== 'software' ||
    input.network !== 'mainnet' ||
    !MAINNET_PRIMARY_ADDRESS_PATTERN.test(sourcePublicAddress) ||
    prefixes.length < 1 ||
    prefixes.length > VANITY_MAX_PREFIXES ||
    prefixes.some(
      prefix =>
        prefix.length < 2 ||
        prefix.length > VANITY_MAX_PREFIX_LENGTH ||
        !prefix.startsWith('4') ||
        [...prefix].some(character => !MONERO_BASE58.includes(character)),
    ) ||
    new Set(prefixes).size !== prefixes.length
  ) {
    throw new Error('Vanity search request is invalid.');
  }

  return Object.freeze({
    version: 1,
    sourceWalletRegistrationId,
    network: 'mainnet',
    sourcePublicAddress,
    prefixes: Object.freeze([...prefixes]),
  });
}

export function validateVanitySearchDraft(
  value: unknown,
): VanitySearchDraft | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (record.version !== 1) return undefined;
  if (
    !Array.isArray(record.prefixes) ||
    !record.prefixes.every(prefix => typeof prefix === 'string')
  ) {
    return undefined;
  }
  try {
    return createVanitySearchDraft({
      sourceWalletRegistrationId:
        typeof record.sourceWalletRegistrationId === 'string'
          ? record.sourceWalletRegistrationId
          : '',
      walletKind: 'software',
      network: typeof record.network === 'string' ? record.network : '',
      sourcePublicAddress:
        typeof record.sourcePublicAddress === 'string'
          ? record.sourcePublicAddress
          : '',
      prefixes: record.prefixes,
    });
  } catch {
    return undefined;
  }
}

export function createVanityWorkerSearchInput(
  draft: VanitySearchDraft,
): VanityWorkerSearchInput {
  const validated = validateVanitySearchDraft(draft);
  if (!validated) throw new Error('Vanity search request is invalid.');
  return Object.freeze({
    version: 1,
    kind: 'monero',
    network: validated.network,
    public_address: validated.sourcePublicAddress,
    prefixes: Object.freeze([...validated.prefixes]),
  });
}
