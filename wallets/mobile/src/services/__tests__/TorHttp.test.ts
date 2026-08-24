import { NativeModules } from 'react-native';
import { torFetch } from '../TorHttp';

describe('Tor HTTP transport', () => {
  it('forwards the exact native timeout and response limit', async () => {
    const request = jest.fn(async () => ({ status: 200, body: '{}' }));
    NativeModules.EmbeddedTor = { request };

    await expect(
      torFetch('http://example.onion/v1/test', {
        headers: { Accept: 'application/json' },
        maximumResponseBytes: 16 * 1024,
        method: 'GET',
        timeoutMs: 25_000,
      }),
    ).resolves.toMatchObject({ ok: true, status: 200 });
    expect(request).toHaveBeenCalledWith(
      'http://example.onion/v1/test',
      'GET',
      { Accept: 'application/json' },
      null,
      25_000,
      16 * 1024,
    );
  });

  it('stops the React caller on abort while the native timeout remains bounded', async () => {
    let completeNativeRequest:
      | ((value: { status: number; body: string }) => void)
      | undefined;
    const request = jest.fn(
      (
        _url: string,
        _method: string,
        _headers: Record<string, string>,
        _body: string | null,
        _timeoutMs: number,
        _maximumResponseBytes: number,
      ) =>
        new Promise<{ status: number; body: string }>(resolve => {
          completeNativeRequest = resolve;
        }),
    );
    NativeModules.EmbeddedTor = { request };
    const controller = new AbortController();

    const pending = torFetch('http://example.onion/v1/test', {
      signal: controller.signal,
      timeoutMs: 25_000,
    });
    controller.abort();

    await expect(pending).rejects.toThrow('cancelled');
    expect(request.mock.calls[0][4]).toBe(25_000);
    completeNativeRequest?.({ status: 200, body: '{}' });
    await Promise.resolve();
  });

  it('does not start native work for an already aborted caller', async () => {
    const request = jest.fn(async () => ({ status: 200, body: '{}' }));
    NativeModules.EmbeddedTor = { request };
    const controller = new AbortController();
    controller.abort();

    await expect(
      torFetch('http://example.onion/v1/test', { signal: controller.signal }),
    ).rejects.toThrow('cancelled');
    expect(request).not.toHaveBeenCalled();
  });
});
