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

const config = {
  watchFolders: [tex8SharedAppRoot, moneroSharedWalletRoot],
  transformer: {
    babelTransformerPath: require.resolve("react-native-svg-transformer/react-native"),
  },
  resolver: {
    assetExts: assetExts.filter((ext) => ext !== "svg"),
    extraNodeModules: {
      react: path.resolve(__dirname, "node_modules/react"),
      "react-native": path.resolve(__dirname, "node_modules/react-native"),
    },
    sourceExts: [...sourceExts, "svg"],
  },
};

module.exports = mergeConfig(defaultConfig, config);
