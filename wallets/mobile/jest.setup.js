/* global jest */

require('react-native-gesture-handler/jestSetup');

jest.mock('@react-native-clipboard/clipboard', () => ({
  __esModule: true,
  default: {
    getString: jest.fn(() => Promise.resolve('')),
    setString: jest.fn(),
  },
}));

// QR scanning is a native camera view. Rendering a lightweight stand-in keeps
// screen tests focused on the wallet flow rather than device camera codegen.
jest.mock('react-native-camera-kit', () => {
  const React = require('react');
  const { View } = require('react-native');
  return {
    Camera: props => React.createElement(View, props),
    CameraType: { Back: 'back', Front: 'front' },
  };
});

jest.mock('react-native-permissions', () => ({
  check: jest.fn(() => Promise.resolve('granted')),
  request: jest.fn(() => Promise.resolve('granted')),
  openSettings: jest.fn(() => Promise.resolve()),
  PERMISSIONS: {
    IOS: { CAMERA: 'ios.camera' },
    ANDROID: { CAMERA: 'android.camera' },
  },
  RESULTS: {
    GRANTED: 'granted',
    UNAVAILABLE: 'unavailable',
    BLOCKED: 'blocked',
  },
}));

// Wallet tests use the production Onion daemon preset. Model the native Tor
// bootstrap that exists in signed Android and iOS builds so those tests do not
// silently fall back to a Clearnet daemon.
const { NativeModules } = require('react-native');
NativeModules.EmbeddedTor = {
  ensureReady: jest.fn(() => Promise.resolve('127.0.0.1:19050')),
  probeTcp: jest.fn(() => Promise.resolve({ connected: true, elapsedMs: 1 })),
  request: jest.fn(() => Promise.reject(new Error('No Tor HTTP fixture configured.'))),
};
