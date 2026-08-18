import {
  diagnoseConnectionRoutes,
  parseConnectionEndpoint,
} from '../ConnectionDiagnostics';
import {createDefaultNodeConnectionSettings} from '../NodeConnectionSettings';

describe('ConnectionDiagnostics', () => {
  it('checks the daemon through Tor and gRPC directly over Clearnet', async () => {
    const settings = createDefaultNodeConnectionSettings('mainnet');
    const probeTcp = jest
      .fn()
      .mockResolvedValueOnce({connected: true, elapsedMs: 41.4})
      .mockResolvedValueOnce({connected: true, elapsedMs: 8.6});

    await expect(
      diagnoseConnectionRoutes(settings, {probeTcp}),
    ).resolves.toEqual({
      tor: {
        status: 'connected',
        endpoint: settings.daemon.address,
        elapsedMs: 41,
      },
      clearnet: {
        status: 'connected',
        endpoint: settings.grpcEndpoint,
        elapsedMs: 9,
      },
    });
    expect(probeTcp).toHaveBeenNthCalledWith(
      1,
      settings.daemon.address.split(':')[0],
      18089,
      true,
      8_000,
    );
    expect(probeTcp).toHaveBeenNthCalledWith(
      2,
      'xmr.tex8.com',
      18091,
      false,
      8_000,
    );
  });

  it('reports each route error independently', async () => {
    const settings = createDefaultNodeConnectionSettings('mainnet');
    const probeTcp = jest
      .fn()
      .mockRejectedValueOnce(new Error('Tor bootstrap failed'))
      .mockResolvedValueOnce({connected: true, elapsedMs: 5});

    const result = await diagnoseConnectionRoutes(settings, {probeTcp});

    expect(result.tor).toEqual({
      status: 'error',
      endpoint: settings.daemon.address,
      error: 'Tor bootstrap failed',
    });
    expect(result.clearnet.status).toBe('connected');
  });

  it('validates endpoints before probing them', async () => {
    expect(parseConnectionEndpoint('https://xmr.tex8.com:18091/path')).toEqual({
      host: 'xmr.tex8.com',
      port: 18091,
      label: 'https://xmr.tex8.com:18091/path',
    });
    expect(() => parseConnectionEndpoint('missing-port.example')).toThrow(
      'must include a port',
    );
  });
});
