import {readFileSync} from 'fs';
import {resolve} from 'path';

const mobileRoot = resolve(__dirname, '..', '..', '..');
const sensitiveStores = [
  'EnthusiastDiscoveryService.ts',
  'FastReceiveRegistry.ts',
  'FastWalletPushService.ts',
  'NodeConnectionSettings.ts',
  'RecipientAddressBook.ts',
  'WalletAddressRegistry.ts',
  'WalletRegistry.ts',
  'WalletSnapshotCache.ts',
];

describe('protected metadata contract', () => {
  it.each(sensitiveStores)('%s uses the native protected store', file => {
    const contents = readFileSync(
      resolve(mobileRoot, 'src', 'services', file),
      'utf8',
    );
    expect(contents).toContain("from './ProtectedMetadataStorage'");
    expect(contents).not.toContain(
      "from '@react-native-async-storage/async-storage'",
    );
  });

  it('migrates then deletes legacy AsyncStorage values', () => {
    const contents = readFileSync(
      resolve(
        mobileRoot,
        'src',
        'services',
        'ProtectedMetadataStorage.ts',
      ),
      'utf8',
    );
    expect(contents).toContain('native.storeProtectedMetadata(key, legacyValue)');
    expect(contents).toContain('await AsyncStorage.removeItem(key)');
  });
});
