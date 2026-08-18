import React, { useEffect, useRef, useState } from 'react';
import { StatusBar, StyleSheet, View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
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
import AppTopBar from './src/components/AppTopBar';
import MfwNameTicker from './src/components/MfwNameTicker';
import { logStartupEvent } from './src/services/WalletLogger';
import { v1ReleaseFeatures } from '../../packages/wallet-shared/src/v1ReleaseFeatures';
import { ConnectivityProvider } from './src/services/ConnectivityState';

const navigationRef = createNavigationContainerRef<any>();
const jsModuleLoadedAtMs = Date.now();

function WalletUnlockRedirect({ ready }: { ready: boolean }) {
  const { registeredWallet, session, status, unlockRequestId } =
    useWalletState();
  const presentedUnlockKeyRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    if (!ready || !registeredWallet || session) {
      presentedUnlockKeyRef.current = undefined;
      return;
    }

    // A Ledger registration with an encrypted local view-only companion can
    // reopen after the one app-wide authorization without waking the device.
    // Only a hardware registration that has no such companion needs the
    // visible Ledger open flow.
    const hardwareNeedsVisibleUnlock =
      registeredWallet.kind === 'hardware' &&
      (!registeredWallet.viewOnlyPath ||
        !registeredWallet.viewOnlyCredentialKey);
    const softwareNeedsVisibleUnlock =
      registeredWallet.kind !== 'hardware' && !registeredWallet.credentialKey;
    const requiresVisibleUnlock =
      hardwareNeedsVisibleUnlock ||
      softwareNeedsVisibleUnlock ||
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
  useEffect(() => {
    const startedAt = Date.now();
    logStartupEvent('AppStartup', 'js.app.mounted', {
      elapsedMs: startedAt - jsModuleLoadedAtMs,
      platform: 'android',
    });
    try {
      const lifecycleResult = FastWalletPushService.startLifecycle();
      Promise.resolve(lifecycleResult).then(
        () => {
          logStartupEvent('AppStartup', 'pushLifecycle.complete', {
            elapsedMs: Date.now() - startedAt,
          });
        },
        error => {
          logStartupEvent('AppStartup', 'pushLifecycle.error', {
            elapsedMs: Date.now() - startedAt,
            error,
          });
        },
      );
    } catch (error) {
      logStartupEvent('AppStartup', 'pushLifecycle.throw', {
        elapsedMs: Date.now() - startedAt,
        error,
      });
    }
  }, []);
  const [navigationReady, setNavigationReady] = useState(false);
  const [mfwTickerVisible, setMfwTickerVisible] = useState(
    v1ReleaseFeatures.mfwNameRegistration,
  );

  const navigateWhenReady = (screen: 'Home' | 'MfwNames' | 'NodeStatus') => {
    if (navigationRef.isReady()) {
      navigationRef.navigate(screen);
    }
  };

  return (
    <GestureHandlerRootView style={styles.root}>
      <SafeAreaProvider>
        <StatusBar barStyle="light-content" backgroundColor="#0A0A14" />
        <LanguageProvider>
          <AppSecurityProvider>
            <ConnectivityProvider>
              <WalletStateProvider>
                <WalletDiagnosticsController />
                <View style={styles.app}>
                  {v1ReleaseFeatures.mfwNameRegistration && mfwTickerVisible ? (
                    <MfwNameTicker
                      onDismiss={() => setMfwTickerVisible(false)}
                      onPress={() => navigateWhenReady('MfwNames')}
                    />
                  ) : null}
                  <AppTopBar
                    safeAreaHandledByTicker={mfwTickerVisible}
                    onLogoPress={() => navigateWhenReady('Home')}
                    onStatusPress={() => navigateWhenReady('NodeStatus')}
                  />
                  <View style={styles.navigation}>
                    <NavigationContainer
                      onReady={() => {
                        logStartupEvent('AppStartup', 'navigation.ready', {
                          elapsedMs: Date.now() - jsModuleLoadedAtMs,
                        });
                        setNavigationReady(true);
                      }}
                      ref={navigationRef}
                    >
                      <TabNavigator />
                    </NavigationContainer>
                  </View>
                </View>
                <WalletUnlockRedirect ready={navigationReady} />
                <IncomingPaymentNotice />
              </WalletStateProvider>
            </ConnectivityProvider>
          </AppSecurityProvider>
        </LanguageProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  app: { flex: 1 },
  navigation: { flex: 1 },
});

export default App;
