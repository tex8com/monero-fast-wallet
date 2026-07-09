import React, { useEffect, useRef } from "react";
import {
  Animated,
  StatusBar,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import LinearGradient from "react-native-linear-gradient";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import MoneroCoinGhost from "../components/MoneroCoinGhost";
import MoneroCoin from "../components/MoneroCoin";

const IS_TEST = typeof jest !== "undefined";

export default function WelcomeScreen({ navigation }: any) {
  const insets = useSafeAreaInsets();
  const contentOp = useRef(new Animated.Value(IS_TEST ? 1 : 0)).current;
  const contentY = useRef(new Animated.Value(IS_TEST ? 0 : 10)).current;

  useEffect(() => {
    if (IS_TEST) {
      return;
    }

    Animated.parallel([
      Animated.timing(contentOp, {
        toValue: 1,
        duration: 180,
        useNativeDriver: true,
      }),
      Animated.timing(contentY, {
        toValue: 0,
        duration: 220,
        useNativeDriver: true,
      }),
    ]).start();
  }, [contentOp, contentY]);

  return (
    <LinearGradient
      colors={["#12082A", "#0A0A18", "#07071A"]}
      locations={[0, 0.52, 1]}
      style={s.container}
    >
      <StatusBar barStyle="light-content" backgroundColor="#12082A" />

      <View style={s.bgMonero} pointerEvents="none">
        <MoneroCoinGhost size={340} color="rgba(255,255,255,0.026)" />
      </View>

      <Animated.View
        style={[
          s.center,
          {
            opacity: contentOp,
            transform: [{ translateY: contentY }],
          },
        ]}
      >
        <View style={s.logoWrap}>
          <MoneroCoin size={116} />
        </View>

        <View style={s.textWrap}>
          <View style={s.titleRow}>
            <Text style={[s.titleWord, s.titleWhite]}>Monero</Text>
            <Text style={[s.titleWord, s.titleOrange]}> Wallet</Text>
          </View>
          <Text style={s.subtitle}>Private, fast, and in your control.</Text>
        </View>
      </Animated.View>

      <View
        style={[
          s.bottom,
          { paddingBottom: Math.max(insets.bottom + 88, 106) },
        ]}
      >
        <TouchableOpacity
          style={s.btn}
          activeOpacity={0.85}
          onPress={() => navigation.navigate("WalletSetup")}
        >
          <LinearGradient
            colors={["#F26822", "#D4551A"]}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 0 }}
            style={s.btnGrad}
          >
            <Text style={s.btnText}>Continue</Text>
          </LinearGradient>
        </TouchableOpacity>
      </View>
    </LinearGradient>
  );
}

const s = StyleSheet.create({
  container: {
    flex: 1,
  },
  bgMonero: {
    position: "absolute",
    top: "30%",
    left: 0,
    right: 0,
    alignItems: "center",
  },
  center: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    paddingHorizontal: 24,
  },
  logoWrap: {
    width: 144,
    height: 144,
    borderRadius: 72,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 30,
  },
  textWrap: {
    alignItems: "center",
    alignSelf: "stretch",
    paddingHorizontal: 16,
  },
  titleRow: {
    alignSelf: "stretch",
    flexDirection: "row",
    justifyContent: "center",
    alignItems: "center",
    width: "100%",
    marginBottom: 12,
  },
  titleWord: {
    fontSize: 30,
    fontWeight: "800",
    lineHeight: 38,
    letterSpacing: 0,
  },
  titleWhite: {
    color: "#FFFFFF",
  },
  titleOrange: {
    color: "#F26822",
  },
  subtitle: {
    color: "rgba(255,255,255,0.45)",
    fontSize: 17,
    lineHeight: 25,
    textAlign: "center",
    fontWeight: "400",
  },
  bottom: {
    paddingHorizontal: 24,
    alignItems: "center",
  },
  btn: {
    width: "100%",
    borderRadius: 16,
    overflow: "hidden",
  },
  btnGrad: {
    height: 60,
    borderRadius: 16,
    alignItems: "center",
    justifyContent: "center",
  },
  btnText: {
    color: "#FFF",
    fontSize: 18,
    fontWeight: "700",
    letterSpacing: 0.3,
  },
});
