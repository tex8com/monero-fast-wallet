import React, { useEffect, useRef, useState } from "react";
import {
  View, Text, StyleSheet, TouchableOpacity, StatusBar,
  Animated, Easing, Dimensions, Modal,
} from "react-native";
import LinearGradient from "react-native-linear-gradient";
import Svg, { Path, Rect, Circle, Line } from "react-native-svg";
import { colors } from "../theme/colors";
import MoneroCoinGhost from "../components/MoneroCoinGhost";
import MoneroCoin from "../components/MoneroCoin";

const { width: SW, height: SH } = Dimensions.get("window");
const CREATE_STEPS = ["Generating entropy", "Encrypting seed", "Deriving keys", "Starting wallet"];
const HEX = "0123456789ABCDEF";

function makeCipherLine() {
  return Array.from({ length: 3 }, () =>
    Array.from({ length: 8 }, () => HEX[Math.floor(Math.random() * HEX.length)]).join(""),
  ).join("  ");
}

/* ── Icons ──────────────────────────────────────────────────────────── */
function IcoPlus({ c }: { c: string }) {
  return (<Svg width={28} height={28} viewBox="0 0 24 24" fill="none"><Circle cx="12" cy="12" r="10" stroke={c} strokeWidth={1.8} /><Line x1="12" y1="8" x2="12" y2="16" stroke={c} strokeWidth={2} strokeLinecap="round" /><Line x1="8" y1="12" x2="16" y2="12" stroke={c} strokeWidth={2} strokeLinecap="round" /></Svg>);
}
function IcoUsb({ c }: { c: string }) {
  return (<Svg width={28} height={28} viewBox="0 0 24 24" fill="none"><Rect x="7" y="2" width="10" height="8" rx="2" stroke={c} strokeWidth={1.8} /><Line x1="12" y1="10" x2="12" y2="18" stroke={c} strokeWidth={1.8} /><Circle cx="12" cy="20" r="2" stroke={c} strokeWidth={1.8} /><Line x1="8" y1="14" x2="12" y2="18" stroke={c} strokeWidth={1.8} /><Line x1="16" y1="14" x2="12" y2="18" stroke={c} strokeWidth={1.8} /></Svg>);
}
function IcoImport({ c }: { c: string }) {
  return (<Svg width={28} height={28} viewBox="0 0 24 24" fill="none"><Path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" stroke={c} strokeWidth={1.8} strokeLinecap="round" /><Path d="M7 10l5 5 5-5" stroke={c} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" /><Line x1="12" y1="15" x2="12" y2="3" stroke={c} strokeWidth={1.8} strokeLinecap="round" /></Svg>);
}

/* ── Setup Option ───────────────────────────────────────────────────── */
function SetupOption({
  icon,
  title,
  desc,
  onPress,
  disabled = false,
}: {
  icon: React.ReactNode;
  title: string;
  desc: string;
  onPress: () => void;
  disabled?: boolean;
}) {
  return (
    <TouchableOpacity style={[s.option, disabled && s.optionDisabled]} activeOpacity={0.7} onPress={onPress} disabled={disabled}>
      <View style={s.optionIcon}>{icon}</View>
      <View style={s.optionText}>
        <Text style={s.optionTitle}>{title}</Text>
        <Text style={s.optionDesc}>{desc}</Text>
      </View>
      <Text style={s.optionArrow}>›</Text>
    </TouchableOpacity>
  );
}

/* ── Screen ─────────────────────────────────────────────────────────── */
export default function WalletSetupScreen({ navigation }: any) {
  const fadeIn = useRef(new Animated.Value(0)).current;
  const slideUp = useRef(new Animated.Value(30)).current;
  const bgOp = useRef(new Animated.Value(0)).current;
  const createOp = useRef(new Animated.Value(0)).current;
  const createScale = useRef(new Animated.Value(0.96)).current;
  const createProgress = useRef(new Animated.Value(0)).current;
  const scanY = useRef(new Animated.Value(0)).current;
  const scanLoop = useRef<Animated.CompositeAnimation | null>(null);
  const timers = useRef<Array<ReturnType<typeof setTimeout>>>([]);
  const cipherInterval = useRef<ReturnType<typeof setInterval> | null>(null);
  const [creating, setCreating] = useState(false);
  const [createStep, setCreateStep] = useState(CREATE_STEPS[0]);
  const [cipherLines, setCipherLines] = useState(() => Array.from({ length: 8 }, makeCipherLine));

  useEffect(() => {
    Animated.timing(bgOp, { toValue: 1, duration: 1000, useNativeDriver: true }).start();
    Animated.parallel([
      Animated.timing(fadeIn, { toValue: 1, duration: 600, delay: 200, useNativeDriver: true }),
      Animated.spring(slideUp, { toValue: 0, friction: 9, tension: 40, delay: 200, useNativeDriver: true }),
    ]).start();
  }, [bgOp, fadeIn, slideUp]);

  useEffect(() => () => {
    scanLoop.current?.stop();
    timers.current.forEach(clearTimeout);
    if (cipherInterval.current) {
      clearInterval(cipherInterval.current);
    }
  }, []);

  const startCreateWallet = () => {
    if (creating) {
      return;
    }

    setCreating(true);
    setCreateStep(CREATE_STEPS[0]);
    setCipherLines(Array.from({ length: 8 }, makeCipherLine));
    createOp.setValue(0);
    createScale.setValue(0.96);
    createProgress.setValue(0);
    scanY.setValue(0);

    cipherInterval.current = setInterval(() => {
      setCipherLines(Array.from({ length: 8 }, makeCipherLine));
    }, 80);

    scanLoop.current = Animated.loop(
      Animated.sequence([
        Animated.timing(scanY, { toValue: 1, duration: 900, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
        Animated.timing(scanY, { toValue: 0, duration: 0, useNativeDriver: true }),
      ]),
    );
    scanLoop.current.start();

    Animated.parallel([
      Animated.timing(createOp, { toValue: 1, duration: 260, useNativeDriver: true }),
      Animated.spring(createScale, { toValue: 1, friction: 8, tension: 80, useNativeDriver: true }),
      Animated.timing(createProgress, { toValue: 1, duration: 2300, easing: Easing.out(Easing.cubic), useNativeDriver: false }),
    ]).start();

    CREATE_STEPS.slice(1).forEach((step, index) => {
      timers.current.push(setTimeout(() => setCreateStep(step), 520 + index * 520));
    });

    timers.current.push(setTimeout(() => {
      scanLoop.current?.stop();
      if (cipherInterval.current) {
        clearInterval(cipherInterval.current);
        cipherInterval.current = null;
      }
      navigation.navigate("Home");
      setCreating(false);
    }, 2500));
  };

  const progressWidth = createProgress.interpolate({
    inputRange: [0, 1],
    outputRange: ["0%", "100%"],
  });
  const scanTranslateY = scanY.interpolate({
    inputRange: [0, 1],
    outputRange: [0, 154],
  });

  return (
    <LinearGradient colors={["#12082A", "#0A0A18", "#07071A"]} locations={[0, 0.5, 1]} style={s.container}>
      <StatusBar barStyle="light-content" backgroundColor="#12082A" />

      {/* Background ghost M */}
      <Animated.View style={[s.bgMonero, { opacity: bgOp, transform: [{ rotate: "10deg" }] }]}>
        <MoneroCoinGhost size={500} color="rgba(255,255,255,0.035)" />
      </Animated.View>

      <Animated.View style={[s.content, { opacity: fadeIn, transform: [{ translateY: slideUp }] }]}>
        {/* Logo */}
        <View style={s.logoWrap}>
          <MoneroCoin size={64} />
        </View>

        <Text style={s.title}>Set Up Your Wallet</Text>
        <Text style={s.subtitle}>Choose how you want to get started</Text>

        {/* Options */}
        <View style={s.options}>
          <SetupOption
            icon={<IcoPlus c={colors.orange} />}
            title="Create New Wallet"
            desc="Start fresh with a new Monero wallet"
            onPress={startCreateWallet}
            disabled={creating}
          />
          <SetupOption
            icon={<IcoUsb c={colors.orange} />}
            title="Hardware Wallet"
            desc="Connect your Ledger or Trezor"
            onPress={() => navigation.navigate("Home")}
            disabled={creating}
          />
          <SetupOption
            icon={<IcoImport c={colors.orange} />}
            title="Import Wallet"
            desc="Restore from seed phrase or keys"
            onPress={() => navigation.navigate("Home")}
            disabled={creating}
          />
        </View>
      </Animated.View>

      {/* Footer */}
      <Text style={s.footer}>Your keys never leave this device.</Text>

      <Modal
        visible={creating}
        transparent={false}
        animationType="none"
        presentationStyle="fullScreen"
      >
        <View style={s.createModal}>
          <StatusBar barStyle="light-content" backgroundColor="#12082A" />
          <Animated.View style={[s.createOverlay, { opacity: createOp }]}>
            <LinearGradient colors={["#12082A", "#0A0A18", "#07071A"]} locations={[0, 0.5, 1]} style={s.createOverlayFill}>
              <Animated.View style={[s.createCard, { transform: [{ scale: createScale }] }]}>
                <MoneroCoin size={70} />
                <Text style={s.createTitle}>Creating Wallet</Text>
                <Text style={s.createStep}>{createStep}</Text>

                <View style={s.cipherBox}>
                  {cipherLines.map((line, index) => (
                    <Text
                      key={`${index}-${line}`}
                      style={[s.cipherLine, index % 2 === 0 && s.cipherLineDim]}
                      numberOfLines={1}
                      adjustsFontSizeToFit
                      minimumFontScale={0.82}
                    >
                      {line}
                    </Text>
                  ))}
                  <Animated.View style={[s.scanLine, { transform: [{ translateY: scanTranslateY }] }]} />
                </View>

                <View style={s.progressTrack}>
                  <Animated.View style={[s.progressFill, { width: progressWidth }]} />
                </View>
              </Animated.View>
            </LinearGradient>
          </Animated.View>
        </View>
      </Modal>
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

  content: { flex: 1, justifyContent: "center", paddingHorizontal: 24 },

  logoWrap: { alignSelf: "center", marginBottom: 28 },

  title: { color: "#FFF", fontSize: 30, fontWeight: "800", textAlign: "center", marginBottom: 10 },
  subtitle: { color: "rgba(255,255,255,0.45)", fontSize: 16, textAlign: "center", marginBottom: 40 },

  options: { gap: 12 },
  option: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "rgba(255,255,255,0.04)",
    borderRadius: 18,
    padding: 20,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.06)",
  },
  optionDisabled: { opacity: 0.55 },
  optionIcon: {
    width: 52,
    height: 52,
    borderRadius: 26,
    backgroundColor: "rgba(242,104,34,0.1)",
    alignItems: "center",
    justifyContent: "center",
    marginRight: 16,
  },
  optionText: { flex: 1 },
  optionTitle: { color: "#FFF", fontSize: 17, fontWeight: "700", marginBottom: 3 },
  optionDesc: { color: "rgba(255,255,255,0.4)", fontSize: 13, fontWeight: "400" },
  optionArrow: { color: "rgba(255,255,255,0.2)", fontSize: 24, fontWeight: "300", marginLeft: 8 },

  footer: { color: "rgba(255,255,255,0.25)", fontSize: 13, textAlign: "center", paddingBottom: 50, fontWeight: "500" },

  createModal: { flex: 1, backgroundColor: "#0A0A18" },
  createOverlay: { flex: 1, overflow: "hidden", backgroundColor: "#0A0A18" },
  createOverlayFill: { flex: 1, alignItems: "center", justifyContent: "center", paddingHorizontal: 24 },
  createCard: {
    width: "100%",
    maxWidth: 345,
    borderRadius: 24,
    padding: 24,
    alignItems: "center",
    backgroundColor: "rgba(255,255,255,0.055)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.1)",
  },
  createTitle: { color: "#FFF", fontSize: 28, fontWeight: "800", marginTop: 18, marginBottom: 8 },
  createStep: { color: colors.orange, fontSize: 15, fontWeight: "700", marginBottom: 18 },
  cipherBox: {
    width: "100%",
    height: 176,
    overflow: "hidden",
    borderRadius: 16,
    paddingVertical: 16,
    paddingHorizontal: 18,
    backgroundColor: "rgba(0,0,0,0.26)",
    borderWidth: 1,
    borderColor: "rgba(242,104,34,0.18)",
  },
  cipherLine: {
    color: "rgba(255,255,255,0.62)",
    fontSize: 12,
    lineHeight: 18,
    fontWeight: "700",
    letterSpacing: 0.6,
    textAlign: "center",
  },
  cipherLineDim: { color: "rgba(242,104,34,0.58)" },
  scanLine: {
    position: "absolute",
    left: 18,
    right: 18,
    top: 12,
    height: 2,
    backgroundColor: "rgba(242,104,34,0.9)",
    shadowColor: colors.orange,
    shadowOpacity: 0.75,
    shadowRadius: 12,
  },
  progressTrack: {
    width: "100%",
    height: 6,
    borderRadius: 3,
    backgroundColor: "rgba(255,255,255,0.09)",
    marginTop: 18,
    overflow: "hidden",
  },
  progressFill: { height: "100%", borderRadius: 3, backgroundColor: colors.orange },
});
