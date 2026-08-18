import type { DaemonConfig } from '../NativeMoneroWallet';
import {
  daemonRequiresEmbeddedTor,
  prepareDaemonForConnection,
} from '../EmbeddedTor';

const onionDaemon: DaemonConfig = {
  address: 'exampleexampleexampleexampleexampleexampleexampleexample.onion:18089',
  trusted: true,
  proxyAddress: '127.0.0.1:9050',
};

describe('EmbeddedTor', () => {
  it('starts the Android runtime for an app-managed Onion proxy', async () => {
    const ensureReady = jest.fn(async () => '127.0.0.1:39123');

    await expect(
      prepareDaemonForConnection(onionDaemon, {
        platform: 'android',
        nativeModule: { ensureReady },
      }),
    ).resolves.toEqual({
      ...onionDaemon,
      proxyAddress: '127.0.0.1:39123',
    });
    expect(ensureReady).toHaveBeenCalledWith(120_000);
  });

  it('starts the iOS runtime for the same app-managed Onion proxy', async () => {
    const ensureReady = jest.fn(async () => '127.0.0.1:39124');

    await expect(
      prepareDaemonForConnection(onionDaemon, {
        platform: 'ios',
        nativeModule: { ensureReady },
      }),
    ).resolves.toEqual({
      ...onionDaemon,
      proxyAddress: '127.0.0.1:39124',
    });
    expect(ensureReady).toHaveBeenCalledWith(120_000);
  });

  it('does not touch the independent Clearnet daemon path', async () => {
    const clearnet = {
      ...onionDaemon,
      address: '199.30.65.42:18089',
      proxyAddress: '',
    };
    const ensureReady = jest.fn(async () => '127.0.0.1:39123');

    await expect(
      prepareDaemonForConnection(clearnet, {
        platform: 'android',
        nativeModule: { ensureReady },
      }),
    ).resolves.toEqual(clearnet);
    expect(ensureReady).not.toHaveBeenCalled();
  });

  it('recognizes every daemon route assigned to the app-managed Tor proxy', () => {
    expect(daemonRequiresEmbeddedTor(onionDaemon)).toBe(true);
    expect(
      daemonRequiresEmbeddedTor({
        ...onionDaemon,
        address: 'node.example.test:18089',
      }),
    ).toBe(true);
    expect(
      daemonRequiresEmbeddedTor({
        ...onionDaemon,
        proxyAddress: '192.0.2.5:9050',
      }),
    ).toBe(false);
  });

  it('fails closed when a mobile release omits its Tor runtime', async () => {
    await expect(
      prepareDaemonForConnection(onionDaemon, {
        platform: 'android',
      }),
    ).rejects.toThrow('embedded Tor runtime is missing');
  });
});
