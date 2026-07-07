/* global jest */

require('react-native-gesture-handler/jestSetup');

jest.mock('@react-native-clipboard/clipboard', () => ({
  __esModule: true,
  default: {
    setString: jest.fn(),
  },
}));
