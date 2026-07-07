import React from "react";
import { StatusBar, StyleSheet } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { NavigationContainer } from "@react-navigation/native";
import TabNavigator from "./src/navigation/TabNavigator";
import { WalletDiagnosticsController } from "./src/services/WalletDiagnosticsController";
import { WalletStateProvider } from "./src/services/WalletState";

function App() {
  return (
    <GestureHandlerRootView style={styles.root}>
      <StatusBar barStyle="light-content" backgroundColor="#0A0A14" />
      <WalletStateProvider>
        <WalletDiagnosticsController />
        <NavigationContainer>
          <TabNavigator />
        </NavigationContainer>
      </WalletStateProvider>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
});

export default App;
