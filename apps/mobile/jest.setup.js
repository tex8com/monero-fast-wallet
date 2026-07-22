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
