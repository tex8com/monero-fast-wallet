import { readFileSync } from 'fs';
import { resolve } from 'path';

const mobileRoot = resolve(__dirname, '..', '..', '..');
const receiveScreen = readFileSync(
  resolve(mobileRoot, 'src', 'screens', 'ReceiveScreen.tsx'),
  'utf8',
);

describe('payment link UI contract', () => {
  it('keeps the interoperable Monero URI in the QR code only', () => {
    expect(receiveScreen).toContain('<QrCode value={paymentUri}');
    expect(receiveScreen).not.toContain('Clipboard.setString(paymentUri)');
    expect(receiveScreen).not.toContain('message: paymentUri');
  });

  it('copies and shares only a resolver-validated HTTPS response', () => {
    expect(receiveScreen).toContain('paymentLinkClient.createPaymentLink(');
    expect(receiveScreen).toContain('Clipboard.setString(record.url)');
    expect(receiveScreen).toContain('message: record.url');
    expect(receiveScreen).toContain('paymentLinkOperation.current');
    expect(receiveScreen).toContain('paymentLinkCache.current');
    expect(receiveScreen).toContain('cached.record.expiresAt > Date.now()');
    expect(receiveScreen).toContain('operation.controller.abort()');
    expect(receiveScreen).toContain('disabled={Boolean(paymentLinkBusy)}');
    expect(receiveScreen).toContain("t('receive.paymentLinkError')");
  });
});
