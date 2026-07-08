import React from "react";
import { createBottomTabNavigator } from "@react-navigation/bottom-tabs";

import HomeScreen from "../screens/HomeScreen";
import SendScreen from "../screens/SendScreen";
import ReceiveScreen from "../screens/ReceiveScreen";
import MarketplaceScreen from "../screens/MarketplaceScreen";
import MenuScreen from "../screens/MenuScreen";
import LocalMoneroScreen from "../screens/LocalMoneroScreen";
import SettingsScreen from "../screens/SettingsScreen";
import SharedModulesScreen from "../screens/SharedModulesScreen";
import Tex8AssistantScreen from "../screens/Tex8AssistantScreen";
import WelcomeScreen from "../screens/WelcomeScreen";
import WalletSetupScreen from "../screens/WalletSetupScreen";
import CustomTabBar from "../components/CustomTabBar";
import { useWalletState } from "../services/WalletState";

const Tab = createBottomTabNavigator();

export default function TabNavigator() {
  const { status } = useWalletState();
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
      <Tab.Screen name="Marketplace" component={MarketplaceScreen} />
      <Tab.Screen name="Menu" component={MenuScreen} />
      {/* Hidden screens — accessible via Menu */}
      <Tab.Screen name="LocalMonero" component={LocalMoneroScreen} />
      <Tab.Screen name="Settings" component={SettingsScreen} />
      <Tab.Screen name="Tex8Assistant" component={Tex8AssistantScreen} />
      <Tab.Screen name="SharedModules" component={SharedModulesScreen} />
      <Tab.Screen name="Welcome" component={WelcomeScreen} />
      <Tab.Screen name="WalletSetup" component={WalletSetupScreen} />
    </Tab.Navigator>
  );
}
