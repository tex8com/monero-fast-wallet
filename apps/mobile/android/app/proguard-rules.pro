# Add project specific ProGuard rules here.
# By default, the flags in this file are appended to flags specified
# in /usr/local/Cellar/android-sdk/24.3.3/tools/proguard/proguard-android.txt
# You can edit the include path and order by changing the proguardFiles
# directive in build.gradle.
#
# For more details, see
#   http://developer.android.com/guide/developing/tools/proguard.html

# Add any project specific keep options here:

# The native Monero bridge obtains these Ledger BLE callbacks by their exact
# JVM names via JNI GetStaticMethodID. R8 must not rename or strip them in a
# release APK, otherwise Android aborts the process during wallet-module
# initialization.
-keepclassmembers,allowoptimization class com.monerowallet.NativeMoneroWalletJni {
    public static boolean ledgerBleConnect();
    public static void ledgerBleDisconnect();
    public static boolean ledgerBleConnected();
    public static byte[] ledgerBleExchange(byte[], boolean);
}
