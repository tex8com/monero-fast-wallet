const path = require("path");
const { getDefaultConfig, mergeConfig } = require("@react-native/metro-config");

/**
 * Metro configuration
 * https://reactnative.dev/docs/metro
 *
 * @type {import('@react-native/metro-config').MetroConfig}
 */
const defaultConfig = getDefaultConfig(__dirname);
const { assetExts, sourceExts } = defaultConfig.resolver;
const tex8SharedAppRoot = path.resolve(
  __dirname,
  "../../../tex8/products/mobile-platform/shared-app",
);
const moneroSharedWalletRoot = path.resolve(__dirname, '../../packages/wallet-shared');
const moneroAppUpdateRoot = path.resolve(__dirname, '../../packages/app-update-core');
const moneroReleaseConfigRoot = path.resolve(__dirname, '../../config');
const appNodeModules = path.resolve(__dirname, 'node_modules');

const config = {
  watchFolders: [
    tex8SharedAppRoot,
    moneroSharedWalletRoot,
    moneroAppUpdateRoot,
    moneroReleaseConfigRoot,
  ],
  transformer: {
    babelTransformerPath: require.resolve("react-native-svg-transformer/react-native"),
  },
  resolver: {
    assetExts: assetExts.filter((ext) => ext !== "svg"),
    extraNodeModules: {
      '@babel/runtime': path.resolve(appNodeModules, '@babel/runtime'),
      react: path.resolve(__dirname, "node_modules/react"),
      "react-native": path.resolve(__dirname, "node_modules/react-native"),
    },
    // Shared monorepo sources live above the React Native app. Without an
    // explicit app dependency root Metro walks upward from those files and
    // never reaches wallets/mobile/node_modules.
    nodeModulesPaths: [appNodeModules],
    sourceExts: [...sourceExts, "svg"],
  },
};

module.exports = mergeConfig(defaultConfig, config);
