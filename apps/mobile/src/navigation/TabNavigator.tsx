import React, { useEffect, useRef } from "react";
import { createBottomTabNavigator } from "@react-navigation/bottom-tabs";

import HomeScreen from "../screens/HomeScreen";
import SendScreen from "../screens/SendScreen";
import ReceiveScreen from "../screens/ReceiveScreen";
import MenuScreen from "../screens/MenuScreen";
import FindEnthusiastsScreen from "../screens/FindEnthusiastsScreen";
import EnthusiastChatScreen from "../screens/EnthusiastChatScreen";
import SettingsScreen from "../screens/SettingsScreen";
import Tex8AssistantScreen from "../screens/Tex8AssistantScreen";
import WelcomeScreen from "../screens/WelcomeScreen";
import WalletSetupScreen from "../screens/WalletSetupScreen";
import WalletsScreen from "../screens/WalletsScreen";
import MfwNamesScreen from "../screens/MfwNamesScreen";
import MoneroEnthusiastScreen from "../screens/MoneroEnthusiastScreen";
import TransactionsScreen from "../screens/TransactionsScreen";
import TransactionDetailScreen from "../screens/TransactionDetailScreen";
import CustomTabBar from "../components/CustomTabBar";
import { useWalletState } from "../services/WalletState";
import { useAppSecurity } from "../services/AppSecurity";
import { logWalletEvent } from "../services/WalletLogger";
import { v1ReleaseFeatures } from "../../../../packages/wallet-shared/src/v1ReleaseFeatures";

const Tab = createBottomTabNavigator();

export default function TabNavigator() {
  const { status } = useWalletState();
  const {
    consumeInitialProtectionSetup,
    initialProtectionSetupCompleted,
    initialProtectionTransitionStartedAtMs,
    locked: appSecurityLocked,
  } = useAppSecurity();
  const walletStateLoadStartedAtMsRef = useRef(Date.now());
  const walletStateReadyLoggedRef = useRef(false);

  useEffect(() => {
    if (status !== "loading" && !walletStateReadyLoggedRef.current) {
      walletStateReadyLoggedRef.current = true;
      logWalletEvent("AppNavigation", "walletState.ready", {
        elapsedMs:
          typeof initialProtectionTransitionStartedAtMs === "number"
            ? Date.now() - initialProtectionTransitionStartedAtMs
            : Date.now() - walletStateLoadStartedAtMsRef.current,
        status,
      });
    }
    if (
      !appSecurityLocked &&
      status !== "loading" &&
      typeof initialProtectionTransitionStartedAtMs === "number"
    ) {
      logWalletEvent("AppNavigation", "walletScreen.presented", {
        elapsedMs:
          Date.now() - initialProtectionTransitionStartedAtMs,
        initialSetup: initialProtectionSetupCompleted,
        status,
      });
      consumeInitialProtectionSetup();
    }
  }, [
    appSecurityLocked,
    consumeInitialProtectionSetup,
    initialProtectionSetupCompleted,
    initialProtectionTransitionStartedAtMs,
    status,
  ]);

  if (status === "loading") {
    return null;
  }

  const initialRouteName =
    status === "empty" || status === "error"
      ? "WalletSetup"
      : status === "locked" || status === "opening" || status === "syncing" || status === "open"
      ? "Home"
      : "Welcome";

  return (
    <Tab.Navigator
      initialRouteName={initialRouteName}
      tabBar={(props) => <CustomTabBar {...props} />}
      screenOptions={{ headerShown: false }}
    >
      {/* Visible tabs */}
      <Tab.Screen name="Home" component={HomeScreen} />
      <Tab.Screen name="Send" component={SendScreen} />
      <Tab.Screen name="Receive" component={ReceiveScreen} />
      {v1ReleaseFeatures.legacyCommunity ? (
        <Tab.Screen name="FindEnthusiasts" component={FindEnthusiastsScreen} />
      ) : null}
      <Tab.Screen name="MoneroEnthusiast" component={MoneroEnthusiastScreen} />
      <Tab.Screen name="Menu" component={MenuScreen} />
      {/* Hidden screens — accessible via Menu */}
      {v1ReleaseFeatures.legacyCommunity ? (
        <Tab.Screen name="EnthusiastChat" component={EnthusiastChatScreen} />
      ) : null}
      <Tab.Screen name="Settings" component={SettingsScreen} />
      {v1ReleaseFeatures.assistant ? (
        <Tab.Screen name="Tex8Assistant" component={Tex8AssistantScreen} />
      ) : null}
      <Tab.Screen name="Wallets" component={WalletsScreen} />
      {v1ReleaseFeatures.mfwNameRegistration ? (
        <Tab.Screen name="MfwNames" component={MfwNamesScreen} />
      ) : null}
      <Tab.Screen name="Transactions" component={TransactionsScreen} />
      <Tab.Screen name="TransactionDetail" component={TransactionDetailScreen} />
      <Tab.Screen name="Welcome" component={WelcomeScreen} />
      <Tab.Screen name="WalletSetup" component={WalletSetupScreen} />
    </Tab.Navigator>
  );
}
