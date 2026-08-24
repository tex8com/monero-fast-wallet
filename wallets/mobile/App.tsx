import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Linking, StatusBar, StyleSheet, View } from 'react-native';
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
import IncomingPaymentNotice from './src/components/IncomingPaymentNotice';
import AppTopBar from './src/components/AppTopBar';
import MfwNameTicker from './src/components/MfwNameTicker';
import { logStartupEvent } from './src/services/WalletLogger';
import { v1ReleaseFeatures } from '../../packages/wallet-shared/src/v1ReleaseFeatures';
import { ConnectivityProvider } from './src/services/ConnectivityState';
import {
  incomingPaymentIntentsEqual,
  parseIncomingPaymentIntent,
} from './src/services/IncomingPaymentLink';
import {
  incomingPaymentFlowId,
  IncomingPaymentLinkAcknowledgementProvider,
  IncomingPaymentLinkController,
  type PendingIncomingPayment,
} from './src/services/IncomingPaymentLinkController';
import { parseVanityOrderDeepLink } from './src/services/VanityServiceClient';

const navigationRef = createNavigationContainerRef<any>();
const jsModuleLoadedAtMs = Date.now();

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
  const incomingPaymentSequenceRef = useRef(0);
  const pendingIncomingPaymentRef = useRef<PendingIncomingPayment | undefined>(
    undefined,
  );
  const [pendingIncomingPayment, setPendingIncomingPayment] = useState<
    PendingIncomingPayment | undefined
  >(undefined);
  const [navigationReadyEpoch, setNavigationReadyEpoch] = useState(0);
  const [pendingVanityOrderId, setPendingVanityOrderId] = useState<
    string | undefined
  >();
  const [mfwTickerVisible, setMfwTickerVisible] = useState(
    v1ReleaseFeatures.mfwNameRegistration,
  );

  const queueIncomingPaymentUrl = useCallback((url: string | null) => {
    const vanityOrderId = v1ReleaseFeatures.vanityAddress
      ? parseVanityOrderDeepLink(url)
      : undefined;
    if (vanityOrderId) {
      setPendingVanityOrderId(vanityOrderId);
      return;
    }
    const intent = parseIncomingPaymentIntent(url);
    if (!intent) return;
    if (
      pendingIncomingPaymentRef.current &&
      incomingPaymentIntentsEqual(
        pendingIncomingPaymentRef.current.intent,
        intent,
      )
    ) {
      return;
    }
    incomingPaymentSequenceRef.current += 1;
    const pending = {
      sequence: incomingPaymentSequenceRef.current,
      intent,
    };
    pendingIncomingPaymentRef.current = pending;
    setPendingIncomingPayment(pending);
  }, []);

  useEffect(() => {
    let active = true;
    Linking.getInitialURL()
      .then(url => {
        if (active) queueIncomingPaymentUrl(url);
      })
      .catch(() => undefined);
    const subscription = Linking.addEventListener('url', event => {
      queueIncomingPaymentUrl(event.url);
    });
    return () => {
      active = false;
      subscription.remove();
    };
  }, [queueIncomingPaymentUrl]);

  useEffect(() => {
    if (
      !v1ReleaseFeatures.vanityAddress ||
      !pendingVanityOrderId ||
      navigationReadyEpoch < 1 ||
      !navigationRef.isReady()
    ) {
      return;
    }
    navigationRef.navigate('VanityOrderStatus', {
      orderId: pendingVanityOrderId,
    });
    setPendingVanityOrderId(undefined);
  }, [navigationReadyEpoch, pendingVanityOrderId]);

  const consumeIncomingPayment = useCallback((sequence: number) => {
    if (pendingIncomingPaymentRef.current?.sequence === sequence) {
      pendingIncomingPaymentRef.current = undefined;
    }
    setPendingIncomingPayment(current =>
      current?.sequence === sequence ? undefined : current,
    );
  }, []);
  const acknowledgeIncomingPayment = useCallback((flowId: string) => {
    if (
      pendingIncomingPaymentRef.current &&
      incomingPaymentFlowId(pendingIncomingPaymentRef.current.sequence) ===
        flowId
    ) {
      pendingIncomingPaymentRef.current = undefined;
    }
    setPendingIncomingPayment(current =>
      current && incomingPaymentFlowId(current.sequence) === flowId
        ? undefined
        : current,
    );
  }, []);

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
              <IncomingPaymentLinkAcknowledgementProvider
                onAcknowledged={acknowledgeIncomingPayment}
              >
                <WalletStateProvider>
                  <WalletDiagnosticsController />
                  <View style={styles.app}>
                    {v1ReleaseFeatures.mfwNameRegistration &&
                    mfwTickerVisible ? (
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
                          setNavigationReadyEpoch(current => current + 1);
                        }}
                        ref={navigationRef}
                      >
                        <TabNavigator />
                      </NavigationContainer>
                    </View>
                  </View>
                  <IncomingPaymentLinkController
                    navigation={navigationRef}
                    navigationReady={navigationReadyEpoch}
                    onConsumed={consumeIncomingPayment}
                    pending={pendingIncomingPayment}
                  />
                  <IncomingPaymentNotice />
                </WalletStateProvider>
              </IncomingPaymentLinkAcknowledgementProvider>
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
