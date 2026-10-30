import fs from 'fs';
import path from 'path';
const root = path.resolve(__dirname, '../../..');
const android = fs.readFileSync(
  path.join(
    root,
    'android/app/src/main/java/com/monerowallet/NativeMoneroWalletModule.kt',
  ),
  'utf8',
);
const ios = fs.readFileSync(
  path.join(
    root,
    'ios/MoneroWallet/NativeMoneroWallet/RCTNativeMoneroWallet.mm',
  ),
  'utf8',
);
const spec = fs.readFileSync(
  path.join(root, 'specs/NativeMoneroWallet.ts'),
  'utf8',
);
const androidMethod = android.slice(
  android.indexOf('override fun sendFastWalletTestPush('),
  android.indexOf('override fun loadOfficialFastWalletWorkerDescriptor('),
);
const iosMethod = ios.slice(
  ios.indexOf('- (void)sendFastWalletTestPush:'),
  ios.indexOf('- (void)loadOfficialFastWalletWorkerDescriptor:'),
);
it('exposes the same scheduled receipt across Codegen and both native bridges', () => {
  expect(spec).toContain(
    'sendFastWalletTestPush(): Promise<FastWalletTestPushReceipt>',
  );
  expect(androidMethod).toContain('resolveNativeMap(');
  for (const field of ['accepted', 'eventId', 'scheduledAt', 'deliverAfter']) {
    expect(androidMethod).toContain('"' + field + '"');
    expect(iosMethod).toContain('@"' + field + '"');
  }
  expect(iosMethod).not.toContain('return [NSNull null]');
});
it('keeps tests on the authenticated existing installation, provider queue and server clock', () => {
  expect(androidMethod).toContain('executor = fastWalletProviderExecutor');
  expect(androidMethod).toContain('requireExisting = true');
  expect(iosMethod).toContain('fastWalletInstallationCredentials(YES)');
  expect(androidMethod).toContain('deliverAfter - scheduledAt == 10L');
  expect(iosMethod).toContain(
    'deliverAfter.doubleValue - scheduledAt.doubleValue != 10',
  );
  expect(androidMethod).toContain('body = JSONObject()');
  expect(iosMethod).toContain('@{}');
  expect(androidMethod).not.toContain('postDelayed');
  expect(iosMethod).not.toContain('UNTimeIntervalNotificationTrigger');
});
