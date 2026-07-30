module.exports = {
  preset: '@react-native/jest-preset',
  setupFiles: ['<rootDir>/jest.setup.js'],
  // Shared workspace TypeScript is transformed outside this package. Resolve
  // Babel's injected runtime helpers from the mobile package explicitly.
  moduleDirectories: ['node_modules', '<rootDir>/node_modules'],
  transformIgnorePatterns: [
    'node_modules/(?!(react-native|@react-native|@react-native-async-storage|@react-native-clipboard|@react-navigation|react-native-.*)/)',
  ],
};
