/**
 * @format
 */

import { AppRegistry } from 'react-native';
import App from './App';
import { name as appName } from './app.json';
import { FastWalletPushService } from './src/backend/FastWalletPushService';

FastWalletPushService.installBackgroundHandler();

if (__DEV__) {
  const { LogBox } = require('react-native');
  LogBox.ignoreAllLogs(true);
}

AppRegistry.registerComponent(appName, () => App);
