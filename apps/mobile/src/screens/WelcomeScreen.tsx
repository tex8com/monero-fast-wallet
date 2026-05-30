import React, { useEffect, useRef } from "react";
import {
  View, Text, StyleSheet, TouchableOpacity, StatusBar,
  Animated, Easing, Dimensions,
} from "react-native";
import LinearGradient from "react-native-linear-gradient";
import Svg, { Circle, G, Defs, LinearGradient as SvgGrad, Stop, Rect, Line, Ellipse } from "react-native-svg";
import { colors } from "../theme/colors";
import MoneroCoinGhost from "../components/MoneroCoinGhost";
import MoneroCoinSvg from "../../assets/monero_coin.svg";

const { width: SW, height: SH } = Dimensions.get("window");

/* ── Wallet SVG — tilted, premium ────────────────────────────────────── */
function WalletSvg() {
  return (
    <Svg width={250} height={160} viewBox="0 0 250 160">
      <Defs>
        <SvgGrad id="walletBg" x1="0" y1="0" x2="0.8" y2="1">
          <Stop offset="0%" stopColor="#322650" />
          <Stop offset="100%" stopColor="#1A1230" />
        </SvgGrad>
        <SvgGrad id="walletShine" x1="0" y1="0" x2="0" y2="1">
          <Stop offset="0%" stopColor="#FFF" stopOpacity="0.06" />
          <Stop offset="50%" stopColor="#FFF" stopOpacity="0" />
        </SvgGrad>
        <SvgGrad id="claspBg" x1="0" y1="0" x2="0" y2="1">
          <Stop offset="0%" stopColor="#2A1E42" />
          <Stop offset="100%" stopColor="#1A1230" />
        </SvgGrad>
      </Defs>
      <G transform="rotate(-6, 125, 85)">
        {/* Shadow */}
        <Ellipse cx="125" cy="148" rx="100" ry="9" fill="#000" opacity={0.25} />
        {/* Wallet body */}
        <Rect x="8" y="18" width="220" height="120" rx="22" fill="url(#walletBg)" />
        {/* Border glow */}
        <Rect x="8" y="18" width="220" height="120" rx="22" stroke="rgba(242,104,34,0.15)" strokeWidth={1.2} fill="none" />
        {/* Top shine */}
        <Rect x="8" y="18" width="220" height="60" rx="22" fill="url(#walletShine)" />
        {/* Card chip */}
        <Rect x="35" y="50" width="28" height="22" rx="4" fill="none" stroke="rgba(255,255,255,0.1)" strokeWidth={1.5} />
        <Line x1="35" y1="58" x2="63" y2="58" stroke="rgba(255,255,255,0.06)" strokeWidth={1} />
        <Line x1="35" y1="64" x2="63" y2="64" stroke="rgba(255,255,255,0.06)" strokeWidth={1} />
        <Line x1="49" y1="50" x2="49" y2="72" stroke="rgba(255,255,255,0.06)" strokeWidth={1} />
        {/* Card number dots */}
        <Circle cx="40" cy="92" r="2" fill="rgba(255,255,255,0.08)" />
        <Circle cx="48" cy="92" r="2" fill="rgba(255,255,255,0.08)" />
        <Circle cx="56" cy="92" r="2" fill="rgba(255,255,255,0.08)" />
        <Circle cx="64" cy="92" r="2" fill="rgba(255,255,255,0.08)" />
        <Circle cx="80" cy="92" r="2" fill="rgba(255,255,255,0.08)" />
        <Circle cx="88" cy="92" r="2" fill="rgba(255,255,255,0.08)" />
        <Circle cx="96" cy="92" r="2" fill="rgba(255,255,255,0.08)" />
        <Circle cx="104" cy="92" r="2" fill="rgba(255,255,255,0.08)" />
        {/* Line */}
        <Line x1="35" y1="108" x2="110" y2="108" stroke="rgba(255,255,255,0.06)" strokeWidth={2.5} strokeLinecap="round" />
        {/* Clasp */}
        <Rect x="193" y="52" width="32" height="42" rx="11" fill="url(#claspBg)" stroke="rgba(242,104,34,0.2)" strokeWidth={1} />
        <Circle cx="209" cy="73" r="6" fill={colors.orange} opacity={0.4} />
        <Circle cx="209" cy="73" r="3" fill={colors.orange} opacity={0.85} />
        {/* Wallet slot */}
        <Rect x="55" y="14" width="110" height="8" rx="4" fill="#0D0918" />
      </G>
    </Svg>
  );
}

function MoneroCoinAsset({ size }: { size: number }) {
  return <MoneroCoinSvg width={size} height={size} />;
}

/* ── Falling Coin — gentle fall, slight wobble ───────────────────────── */
function FallingCoin({ delay, startX, size, duration }: { delay: number; startX: number; size: number; duration: number }) {
  const y = useRef(new Animated.Value(-30)).current;
  const opacity = useRef(new Animated.Value(0)).current;
  const wobble = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const fall = () => {
      y.setValue(-30);
      opacity.setValue(0);
      wobble.setValue(0);

      Animated.sequence([
        Animated.delay(delay),
        Animated.parallel([
          Animated.timing(opacity, { toValue: 0.85, duration: 400, useNativeDriver: true }),
          Animated.timing(y, { toValue: 90, duration, easing: Easing.bezier(0.25, 0.1, 0.25, 1), useNativeDriver: true }),
          Animated.timing(wobble, { toValue: 1, duration, useNativeDriver: true }),
        ]),
        Animated.timing(opacity, { toValue: 0, duration: 300, useNativeDriver: true }),
        Animated.delay(400),
      ]).start(() => fall());
    };
    fall();
  }, []);

  const rot = wobble.interpolate({ inputRange: [0, 0.25, 0.5, 0.75, 1], outputRange: ["-6deg", "4deg", "-3deg", "2deg", "0deg"] });

  return (
    <Animated.View style={{ position: "absolute", left: startX, top: 10, opacity, transform: [{ translateY: y }, { rotate: rot }] }}>
      <MoneroCoinAsset size={size} />
    </Animated.View>
  );
}

/* ── Welcome Screen ──────────────────────────────────────────────────── */
export default function WelcomeScreen({ navigation }: any) {
  // Wallet: smooth loop (start=0, up, down, back to 0)
  const walletY = useRef(new Animated.Value(0)).current;
  const walletScale = useRef(new Animated.Value(0.9)).current;
  // Big coin
  const bigCoinY = useRef(new Animated.Value(-60)).current;
  const bigCoinScale = useRef(new Animated.Value(0.6)).current;
  const bigCoinPulse = useRef(new Animated.Value(1)).current;
  const bigCoinTilt = useRef(new Animated.Value(0)).current;
  // Text + bottom
  const textOp = useRef(new Animated.Value(0)).current;
  const textY = useRef(new Animated.Value(25)).current;
  const bottomOp = useRef(new Animated.Value(0)).current;
  // BG monero
  const bgOp = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    // Wallet entrance
    Animated.spring(walletScale, { toValue: 1, friction: 9, tension: 35, useNativeDriver: true }).start();

    // Wallet float loop: 0 → -6 → 0 → 6 → 0 (seamless)
    Animated.loop(
      Animated.sequence([
        Animated.timing(walletY, { toValue: -6, duration: 1500, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
        Animated.timing(walletY, { toValue: 0, duration: 1500, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
        Animated.timing(walletY, { toValue: 6, duration: 1500, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
        Animated.timing(walletY, { toValue: 0, duration: 1500, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
      ]),
    ).start();

    // Big coin entrance
    Animated.sequence([
      Animated.delay(350),
      Animated.parallel([
        Animated.spring(bigCoinY, { toValue: 0, friction: 7, tension: 45, useNativeDriver: true }),
        Animated.spring(bigCoinScale, { toValue: 1, friction: 7, tension: 45, useNativeDriver: true }),
      ]),
    ]).start();

    // Big coin gentle pulse
    Animated.loop(
      Animated.sequence([
        Animated.timing(bigCoinPulse, { toValue: 1.05, duration: 2500, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
        Animated.timing(bigCoinPulse, { toValue: 1, duration: 2500, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
      ]),
    ).start();

    // Big coin subtle tilt: 0 → left → 0 → right → 0
    Animated.loop(
      Animated.sequence([
        Animated.timing(bigCoinTilt, { toValue: -1, duration: 2000, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
        Animated.timing(bigCoinTilt, { toValue: 0, duration: 2000, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
        Animated.timing(bigCoinTilt, { toValue: 1, duration: 2000, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
        Animated.timing(bigCoinTilt, { toValue: 0, duration: 2000, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
      ]),
    ).start();

    // Background monero fade in
    Animated.timing(bgOp, { toValue: 1, duration: 2000, delay: 500, useNativeDriver: true }).start();

    // Text
    Animated.sequence([
      Animated.delay(700),
      Animated.parallel([
        Animated.timing(textOp, { toValue: 1, duration: 600, useNativeDriver: true }),
        Animated.spring(textY, { toValue: 0, friction: 9, tension: 40, useNativeDriver: true }),
      ]),
    ]).start();

    // Bottom
    Animated.sequence([
      Animated.delay(1100),
      Animated.timing(bottomOp, { toValue: 1, duration: 500, useNativeDriver: true }),
    ]).start();
  }, []);

  const tiltDeg = bigCoinTilt.interpolate({ inputRange: [-1, 0, 1], outputRange: ["-5deg", "0deg", "5deg"] });

  return (
    <LinearGradient colors={["#12082A", "#0A0A18", "#07071A"]} locations={[0, 0.5, 1]} style={s.container}>
      <StatusBar barStyle="light-content" backgroundColor="#12082A" />

      {/* Big background Monero — transparent */}
      <Animated.View style={[s.bgMonero, { opacity: bgOp, transform: [{ rotate: "10deg" }] }]}>
        <MoneroCoinGhost size={500} color="rgba(255,255,255,0.035)" />
      </Animated.View>

      {/* Skip removed — user must tap Get Started */}

      <View style={s.center}>
        {/* Glow */}
        <View style={s.glow} />

        {/* Illustration */}
        <View style={s.illu}>
          {/* Falling coins */}
          <FallingCoin delay={200}  startX={35}  size={20} duration={2800} />
          <FallingCoin delay={900}  startX={100} size={16} duration={2500} />
          <FallingCoin delay={1600} startX={165} size={18} duration={3000} />
          <FallingCoin delay={2300} startX={65}  size={14} duration={2600} />
          <FallingCoin delay={3000} startX={135} size={22} duration={2900} />

          {/* Big coin — uses project SVG asset directly */}
          <Animated.View style={[s.bigCoin, {
            transform: [
              { translateY: bigCoinY },
              { scale: Animated.multiply(bigCoinScale, bigCoinPulse) },
              { rotate: tiltDeg },
            ],
          }]}>
            <MoneroCoinAsset size={92} />
          </Animated.View>

          {/* Wallet — smooth looping float */}
          <Animated.View style={[s.wallet, { transform: [{ translateY: walletY }, { scale: walletScale }] }]}>
            <WalletSvg />
          </Animated.View>
        </View>

        {/* Text */}
        <Animated.View style={[s.textWrap, { opacity: textOp, transform: [{ translateY: textY }] }]}>
          <Text style={s.title}>
            <Text style={s.titleWhite}>Pay Anyone.</Text>{"\n"}
            <Text style={s.titleOrange}>Stay Invisible.</Text>
          </Text>
          <Text style={s.subtitle}>
            Send money worldwide{" "}
            <Text style={s.subtitleHighlight}>in seconds</Text>.{"\n"}
            No fees. No limits. No one watching.{"\n"}
            Just tap and go.
          </Text>
        </Animated.View>
      </View>

      {/* Bottom */}
      <Animated.View style={[s.bottom, { opacity: bottomOp }]}>
        <View style={s.dots}>
          <View style={[s.dot, s.dotActive]} />
          <View style={s.dot} />
          <View style={s.dot} />
        </View>
        <TouchableOpacity style={s.btn} activeOpacity={0.85} onPress={() => navigation.navigate("WalletSetup")}>
          <LinearGradient colors={["#F26822", "#D4551A"]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={s.btnGrad}>
            <Text style={s.btnText}>Get Started</Text>
          </LinearGradient>
        </TouchableOpacity>
      </Animated.View>
    </LinearGradient>
  );
}

const s = StyleSheet.create({
  container: { flex: 1 },
  bgMonero: {
    position: "absolute",
    top: (SH - 500) / 2,
    left: (SW - 500) / 2 + 150,
  },

  center: { flex: 1, justifyContent: "center", alignItems: "center" },

  glow: { position: "absolute", width: 300, height: 300, borderRadius: 150, backgroundColor: "rgba(242,104,34,0.05)", top: "18%" },

  illu: { width: 270, height: 220, marginBottom: 40 },
  bigCoin: { position: "absolute", top: 0, left: 15, zIndex: 2 },
  wallet: { position: "absolute", bottom: 0, left: 15, zIndex: 1 },

  textWrap: { alignItems: "center", paddingHorizontal: 32 },
  title: { fontSize: 38, fontWeight: "800", textAlign: "center", lineHeight: 48, letterSpacing: -0.5, marginBottom: 18 },
  titleWhite: { color: "#FFFFFF" },
  titleOrange: { color: "#F26822" },
  subtitle: { color: "rgba(255,255,255,0.45)", fontSize: 18, lineHeight: 28, textAlign: "center", fontWeight: "400" },
  subtitleHighlight: { color: "#F26822", fontWeight: "600" },

  bottom: { paddingHorizontal: 24, paddingBottom: 56, alignItems: "center" },
  dots: { flexDirection: "row", marginBottom: 28 },
  dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: "rgba(255,255,255,0.08)", marginHorizontal: 4 },
  dotActive: { backgroundColor: colors.orange, width: 24, borderRadius: 4 },
  btn: { width: "100%", borderRadius: 16, overflow: "hidden" },
  btnGrad: { height: 60, borderRadius: 16, alignItems: "center", justifyContent: "center" },
  btnText: { color: "#FFF", fontSize: 18, fontWeight: "700", letterSpacing: 0.3 },
});
