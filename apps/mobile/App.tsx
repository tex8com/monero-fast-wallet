import React, { useEffect, useRef, useState } from 'react';
import { StatusBar, StyleSheet } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import {
  createNavigationContainerRef,
  NavigationContainer,
} from '@react-navigation/native';
import TabNavigator from './src/navigation/TabNavigator';
import { LanguageProvider } from './src/i18n';
import { WalletDiagnosticsController } from './src/services/WalletDiagnosticsController';
import { FastWalletPushService } from './src/services/FastWalletPushService';
import { AppSecurityProvider } from './src/services/AppSecurity';
import { WalletStateProvider } from './src/services/WalletState';
import { useWalletState } from './src/services/WalletState';
import IncomingPaymentNotice from './src/components/IncomingPaymentNotice';

const navigationRef = createNavigationContainerRef<any>();

function WalletUnlockRedirect({ ready }: { ready: boolean }) {
  const { registeredWallet, session, status, unlockRequestId } = useWalletState();
  const presentedUnlockKeyRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    if (!ready || !registeredWallet || session) {
      presentedUnlockKeyRef.current = undefined;
      return;
    }

    // Password-only and Ledger wallets have no safe automatic credential.
    // Bring their existing unlock sheet forward rather than leaving a locked
    // wallet behind an overview or a hidden menu action. A device credential
    // already prompts through the operating system's biometric sheet.
    const requiresVisibleUnlock =
      unlockRequestId !== undefined ||
      registeredWallet.kind === 'hardware' ||
      !registeredWallet.credentialKey ||
      status === 'error';
    const unlockKey = `${registeredWallet.id}:${unlockRequestId ?? 'initial'}`;
    if (
      !requiresVisibleUnlock ||
      presentedUnlockKeyRef.current === unlockKey ||
      !navigationRef.isReady()
    ) {
      return;
    }

    presentedUnlockKeyRef.current = unlockKey;
    navigationRef.navigate('WalletSetup', {
      mode: 'open',
      openRequestId: Date.now(),
    });
  }, [ready, registeredWallet, session, status, unlockRequestId]);

  return null;
}

function App() {
  useEffect(() => FastWalletPushService.startLifecycle(), []);
  const [navigationReady, setNavigationReady] = useState(false);

  return (
    <GestureHandlerRootView style={styles.root}>
      <StatusBar barStyle="light-content" backgroundColor="#0A0A14" />
      <LanguageProvider>
        <AppSecurityProvider>
          <WalletStateProvider>
            <WalletDiagnosticsController />
            <NavigationContainer
              onReady={() => setNavigationReady(true)}
              ref={navigationRef}
            >
              <TabNavigator />
            </NavigationContainer>
            <WalletUnlockRedirect ready={navigationReady} />
            <IncomingPaymentNotice />
          </WalletStateProvider>
        </AppSecurityProvider>
      </LanguageProvider>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
});

export default App;
