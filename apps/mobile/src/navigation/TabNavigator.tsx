import React from "react";
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
import TransactionsScreen from "../screens/TransactionsScreen";
import TransactionDetailScreen from "../screens/TransactionDetailScreen";
import CustomTabBar from "../components/CustomTabBar";
import { useWalletState } from "../services/WalletState";

const Tab = createBottomTabNavigator();

export default function TabNavigator() {
  const { status } = useWalletState();

  if (status === "loading") {
    return null;
  }

  const initialRouteName =
    status === "locked" || status === "opening" || status === "syncing" || status === "open"
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
      <Tab.Screen name="FindEnthusiasts" component={FindEnthusiastsScreen} />
      <Tab.Screen name="Menu" component={MenuScreen} />
      {/* Hidden screens — accessible via Menu */}
      <Tab.Screen name="EnthusiastChat" component={EnthusiastChatScreen} />
      <Tab.Screen name="Settings" component={SettingsScreen} />
      <Tab.Screen name="Tex8Assistant" component={Tex8AssistantScreen} />
      <Tab.Screen name="Wallets" component={WalletsScreen} />
      <Tab.Screen name="Transactions" component={TransactionsScreen} />
      <Tab.Screen name="TransactionDetail" component={TransactionDetailScreen} />
      <Tab.Screen name="Welcome" component={WelcomeScreen} />
      <Tab.Screen name="WalletSetup" component={WalletSetupScreen} />
    </Tab.Navigator>
  );
}
