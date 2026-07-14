import React, { useEffect } from 'react';
import { StatusBar, StyleSheet } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { NavigationContainer } from '@react-navigation/native';
import TabNavigator from './src/navigation/TabNavigator';
import { LanguageProvider } from './src/i18n';
import { WalletDiagnosticsController } from './src/services/WalletDiagnosticsController';
import { FastWalletPushService } from './src/services/FastWalletPushService';
import { WalletStateProvider } from './src/services/WalletState';
import IncomingPaymentNotice from './src/components/IncomingPaymentNotice';

function App() {
  useEffect(() => FastWalletPushService.startLifecycle(), []);

  return (
    <GestureHandlerRootView style={styles.root}>
      <StatusBar barStyle="light-content" backgroundColor="#0A0A14" />
      <LanguageProvider>
        <WalletStateProvider>
          <WalletDiagnosticsController />
          <NavigationContainer>
            <TabNavigator />
          </NavigationContainer>
          <IncomingPaymentNotice />
        </WalletStateProvider>
      </LanguageProvider>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
});

export default App;
