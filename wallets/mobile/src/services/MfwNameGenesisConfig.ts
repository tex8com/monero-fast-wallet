import manifest from '../../../../config/v1-release-features.json';
import type { MoneroNetwork } from './NativeMoneroWallet';
import {
  validateMfwNameGenesisParameters,
  type MfwNameGenesisParameters,
} from './MfwNameRegistration';

/**
 * Mainnet registration is fail-closed until the immutable public protocol
 * parameters are populated in the signed release manifest.
 */
export function configuredMfwNameGenesis(
  network: MoneroNetwork,
): MfwNameGenesisParameters | undefined {
  const value: unknown = manifest.parameters.mfwNameGenesis;
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  try {
    const parameters = validateMfwNameGenesisParameters(
      value as MfwNameGenesisParameters,
    );
    return parameters.network === network ? parameters : undefined;
  } catch {
    return undefined;
  }
}
