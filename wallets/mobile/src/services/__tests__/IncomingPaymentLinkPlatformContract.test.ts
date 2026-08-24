import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const mobileRoot = resolve(__dirname, '../../..');

function source(relativePath: string) {
  return readFileSync(resolve(mobileRoot, relativePath), 'utf8');
}

describe('incoming payment link platform contract', () => {
  it('registers the verified HTTPS route and standard monero scheme on Android', () => {
    const manifest = source('android/app/src/main/AndroidManifest.xml');
    expect(manifest).toContain('android:autoVerify="true"');
    expect(manifest).toContain('android:scheme="https"');
    expect(manifest).toContain('android:host="xmr.tex8.com"');
    expect(manifest).toContain('android:pathPrefix="/pay/"');
    expect(manifest).toContain('android:scheme="monero"');
    expect(manifest).toContain('android:scheme="tex8monero"');
  });

  it('registers Universal Links and forwards them to React Native on iOS', () => {
    const entitlements = source('ios/MoneroWallet/MoneroWallet.entitlements');
    const info = source('ios/MoneroWallet/Info.plist');
    const delegate = source('ios/MoneroWallet/AppDelegate.swift');
    const torTransport = source('ios/MoneroWallet/EmbeddedTorModule.m');
    expect(entitlements).toContain('applinks:xmr.tex8.com');
    expect(info).toContain('<string>monero</string>');
    expect(delegate).toContain('continue userActivity: NSUserActivity');
    expect(delegate).toContain('RCTLinkingManager.application(');
    expect(torTransport).toContain('MFWValidPaymentLinkURL(url, method)');
    expect(torTransport).toContain('if (url == nil)');
    expect(torTransport).toContain('componentsWithURL:url');
    expect(torTransport).toContain(
      'components.host.lowercaseString isEqualToString:@"xmr.tex8.com"',
    );
    expect(torTransport).toContain('components.user != nil');
    expect(torTransport).toContain('components.password != nil');
    expect(torTransport).toContain('components.query != nil');
    expect(torTransport).toContain('components.fragment != nil');
    expect(torTransport).toContain('components.port != nil');
    expect(torTransport).toContain('components.percentEncodedPath');
    expect(torTransport).toContain('isEqualToString:@"/v1/payment-requests"');
    expect(torTransport).toContain(
      'NSString *requestPrefix = @"/v1/payment-requests/"',
    );
    expect(torTransport).toContain('requestID.length != 22');
    expect(torTransport).toContain(
      'NSTimeInterval bootstrapTimeout = MAX(timeout / 1000.0, 10.0)',
    );
    expect(torTransport).toContain(
      'readySessionConfigurationWithTimeout:bootstrapTimeout',
    );
    expect(torTransport).not.toContain('waitUntilReady:120.0');
    expect(torTransport).not.toContain('MFWValidPublicHTTPSURL');
  });

  it('mounts resolver handling only inside the app-security protected tree', () => {
    const app = source('App.tsx');
    const securityStart = app.indexOf('<AppSecurityProvider>');
    const controller = app.indexOf('<IncomingPaymentLinkController');
    const securityEnd = app.indexOf('</AppSecurityProvider>');
    expect(securityStart).toBeGreaterThan(-1);
    expect(controller).toBeGreaterThan(securityStart);
    expect(controller).toBeLessThan(securityEnd);
    expect(app).toContain('incomingPaymentIntentsEqual(');
  });

  it('bounds Android Tor bootstrap by the request timeout', () => {
    const module = source(
      'android/app/src/main/java/com/monerowallet/EmbeddedTorModule.kt',
    );
    const connection = source(
      'android/app/src/main/java/com/monerowallet/TorHttpConnection.kt',
    );
    expect(module).toContain('target,\n          checkedTimeout,');
    expect(connection).toContain('bootstrapTimeoutMs: Long');
    expect(connection).toContain(
      'bootstrapTimeoutMs.coerceAtLeast(MIN_BOOTSTRAP_TIMEOUT_MS)',
    );
  });
});
