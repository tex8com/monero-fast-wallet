import {
  normalizeScannerUrl,
  parseWatchStatusResponse,
  verifyFastReceiveScannerCapability,
  type ScannerFetch,
} from '../FastReceiveScannerClient';

describe('FastReceiveScannerClient', () => {
  it('verifies only the public scanner capability from JavaScript', async () => {
    const fetchImpl = jest.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ok: true}),
    })) as ScannerFetch & jest.Mock;

    await expect(
      verifyFastReceiveScannerCapability('https://xmr.tex8.com/', fetchImpl),
    ).resolves.toBeUndefined();

    expect(fetchImpl).toHaveBeenCalledWith('https://xmr.tex8.com/healthz', {
      method: 'GET',
      headers: {accept: 'application/json'},
    });
  });

  it('does not accept an unrelated server as a Fast Receive scanner', async () => {
    const fetchImpl = jest.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ok: false}),
    })) as ScannerFetch & jest.Mock;

    await expect(
      verifyFastReceiveScannerCapability('https://example.invalid', fetchImpl),
    ).rejects.toThrow('not a Fast Receive scanner');
  });

  it('rejects cleartext and non-origin scanner URLs before network access', async () => {
    const fetchImpl = jest.fn() as ScannerFetch & jest.Mock;

    await expect(
      verifyFastReceiveScannerCapability('http://xmr.tex8.com', fetchImpl),
    ).rejects.toThrow('HTTPS origin');
    await expect(
      verifyFastReceiveScannerCapability(
        'https://xmr.tex8.com/scanner?tenant=wallet',
        fetchImpl,
      ),
    ).rejects.toThrow('HTTPS origin');

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('normalizes only clean HTTPS scanner origins', () => {
    expect(normalizeScannerUrl('https://xmr.tex8.com/')).toBe(
      'https://xmr.tex8.com',
    );
    expect(() => normalizeScannerUrl('https://user@xmr.tex8.com')).toThrow(
      'HTTPS origin',
    );
  });

  it('parses authenticated native watch responses', () => {
    expect(
      parseWatchStatusResponse(
        JSON.stringify({
          identity_id: 'fast-receive-v2-0',
          status: 'enabled',
          scanner_status: 'enabled',
          network: 'mainnet',
          restore_height: 42,
          last_scanned_height: 100,
          notifications_enabled: true,
        }),
        'fast-receive-v2-0',
      ),
    ).toEqual({
      identityId: 'fast-receive-v2-0',
      registered: true,
      scannerStatus: 'enabled',
      notificationsEnabled: true,
      network: 'mainnet',
      restoreHeight: 42,
      lastScannedHeight: 100,
    });
  });

  it('rejects mismatched authenticated scanner responses', () => {
    expect(() =>
      parseWatchStatusResponse(
        JSON.stringify({
          identity_id: 'other',
          status: 'enabled',
        }),
        'fast-receive-v2-0',
      ),
    ).toThrow('mismatched watch identity');
  });
});
