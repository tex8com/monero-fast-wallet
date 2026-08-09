const skipFirebaseNative =
  process.env.MONERO_WALLET_SKIP_FIREBASE_NATIVE === '1';

module.exports = skipFirebaseNative
  ? {
      // A separate simulator application ID has no production Firebase
      // registration. Excluding only the native packages keeps that local
      // diagnostics build from initializing production push/App Check while
      // leaving the production dependency graph unchanged.
      dependencies: {
        '@react-native-firebase/app': {
          platforms: {android: null},
        },
        '@react-native-firebase/app-check': {
          platforms: {android: null},
        },
        '@react-native-firebase/messaging': {
          platforms: {android: null},
        },
      },
    }
  : {};
