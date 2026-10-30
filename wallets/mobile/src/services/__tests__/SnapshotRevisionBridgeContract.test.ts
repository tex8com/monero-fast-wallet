import fs from 'fs';
import path from 'path';
const root = path.resolve(__dirname, '../../..');
const android = fs.readFileSync(path.join(root,'android/app/src/main/java/com/monerowallet/NativeMoneroWalletModule.kt'),'utf8');
const jni = fs.readFileSync(path.join(root,'android/app/src/main/cpp/NativeMoneroWalletJni.cpp'),'utf8');
const ios = fs.readFileSync(path.join(root,'ios/MoneroWallet/NativeMoneroWallet/RCTNativeMoneroWallet.mm'),'utf8');
it('preserves the Core revision through JNI, Kotlin and the iOS snapshot dictionary', () => {
  expect(jni).toMatch(/"snapshotRevision",\s*snapshot.snapshotRevision/);
  const snapshot = android.slice(android.indexOf('private fun snapshotToWritableMap('),android.indexOf('private fun ledgerKeyImageSyncResultToWritableMap('));
  expect(snapshot).toContain('putDouble("snapshotRevision", snapshot.numberValue("snapshotRevision"))');
  const iosSnapshot = ios.slice(ios.indexOf('NSDictionary *toDictionary(const WalletSnapshot &snapshot)'),ios.indexOf('NSDictionary *toDictionary(const LedgerKeyImageSyncResult &result)'));
  expect(iosSnapshot).toContain('@"snapshotRevision": toNSNumber(snapshot.snapshotRevision)');
});
it('distinguishes actual native balance reads from cached snapshots without logging amounts', () => {
  const balance = android.slice(android.indexOf('override fun getBalance('),android.indexOf('override fun getUnlockedBalance('));
  expect(balance).toContain('NativeMoneroWalletJni.getBalance(walletId, accountIndex)');
  expect(balance).toContain('"getBalance.balanceState"');
  expect(balance).toContain('"balancePositive" to');
  expect(balance).not.toContain('"balanceAtomic" to');
});
