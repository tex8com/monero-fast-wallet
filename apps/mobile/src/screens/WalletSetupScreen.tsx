import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  View, Text, StyleSheet, TouchableOpacity, StatusBar,
  Animated, Easing, Dimensions, Modal, TextInput,
  KeyboardAvoidingView, Platform, ScrollView, Switch, ActivityIndicator,
} from "react-native";
import LinearGradient from "react-native-linear-gradient";
import Svg, { Path, Rect, Circle, Line } from "react-native-svg";
import { colors } from "../theme/colors";
import MoneroCoinGhost from "../components/MoneroCoinGhost";
import MoneroCoin from "../components/MoneroCoin";
import { walletService } from "../services/WalletService";
import { useWalletState } from "../services/WalletState";
import type {
  BiometricAuthStatus,
  LedgerTransportStatus,
} from "../services/NativeMoneroWallet";

const { width: SW, height: SH } = Dimensions.get("window");
const CREATE_STEPS = [
  "Preparing storage",
  "Generating entropy",
  "Encrypting seed",
  "Deriving keys",
  "Preparing backup",
];
const HARDWARE_STEPS = [
  "Preparing wallet file",
  "Waiting for Ledger Nano",
  "Opening Monero app",
  "Reading public keys",
  "Saving wallet",
];
const RESTORE_STEPS = [
  "Preparing storage",
  "Restoring seed",
  "Deriving keys",
  "Preparing scan",
  "Starting scan",
];
const DEFAULT_WALLET_NAME = "primary";
const DEFAULT_HARDWARE_WALLET_NAME = "ledger";
const MONERO_SEED_WORD_COUNT = 25;
const HEX = "0123456789ABCDEF";
type PasswordPromptMode = "create" | "open" | "restore";
type CreationKind = "software" | "hardware" | "restore";
type CreateCredentialMode = "device" | "password";

function makeCipherLine() {
  return Array.from({ length: 3 }, () =>
    Array.from({ length: 8 }, () => HEX[Math.floor(Math.random() * HEX.length)]).join(""),
  ).join("  ");
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function normalizeSeed(seed: string): string {
  return seed.trim().replace(/\s+/g, " ");
}

function ledgerTransportReady(
  status: LedgerTransportStatus | undefined,
): boolean {
  return Boolean(status?.supported && status.available && status.permissionGranted);
}

function ledgerStatusTitle(status: LedgerTransportStatus | undefined): string {
  if (!status) {
    return "Searching for Ledger Nano";
  }
  if (status.transport === "ble" && status.available && !status.supported) {
    return "Ledger BLE found";
  }
  if (!status.supported) {
    return "Ledger transport unavailable";
  }
  if (!status.available) {
    return "Waiting for Ledger Nano";
  }
  if (status.requiresUserAction || !status.permissionGranted) {
    return "Permission required";
  }
  return status.deviceName || "Ledger Nano found";
}

function biometricReady(status: BiometricAuthStatus | undefined): boolean {
  return Boolean(status?.supported && status.available && status.enrolled);
}

function biometricLabel(status: BiometricAuthStatus | undefined): string {
  if (status?.biometryType === "face") {
    return "Face ID";
  }
  if (status?.biometryType === "fingerprint") {
    return Platform.OS === "ios" ? "Touch ID" : "Fingerprint";
  }
  if (Platform.OS === "android") {
    return "Fingerprint or Face Unlock";
  }
  return "Biometrics";
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
export default function WalletSetupScreen({ navigation, route }: any) {
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
  const initialModeHandled = useRef(false);
  const [creating, setCreating] = useState(false);
  const [creatingKind, setCreatingKind] =
    useState<CreationKind>("software");
  const [passwordPromptMode, setPasswordPromptMode] =
    useState<PasswordPromptMode | undefined>();
  const [createCredentialMode, setCreateCredentialMode] =
    useState<CreateCredentialMode>("device");
  const [ledgerPromptVisible, setLedgerPromptVisible] = useState(false);
  const [ledgerBusy, setLedgerBusy] = useState(false);
  const [ledgerStatus, setLedgerStatus] =
    useState<LedgerTransportStatus | undefined>();
  const [ledgerError, setLedgerError] = useState<string | undefined>();
  const [biometricStatus, setBiometricStatus] =
    useState<BiometricAuthStatus | undefined>();
  const [biometricError, setBiometricError] = useState<string | undefined>();
  const [walletPassword, setWalletPassword] = useState("");
  const [walletPasswordConfirm, setWalletPasswordConfirm] = useState("");
  const [restoreSeed, setRestoreSeed] = useState("");
  const [restoreHeight, setRestoreHeight] = useState("");
  const [createStep, setCreateStep] = useState(CREATE_STEPS[0]);
  const [cipherLines, setCipherLines] = useState(() => Array.from({ length: 8 }, makeCipherLine));
  const [createError, setCreateError] = useState<string | undefined>();
  const [createdSeed, setCreatedSeed] = useState("");
  const [createdSeedWalletId, setCreatedSeedWalletId] =
    useState<string | undefined>();
  const [seedConfirmed, setSeedConfirmed] = useState(false);
  const [createFastReceiveOnSetup, setCreateFastReceiveOnSetup] =
    useState(false);
  const {
    registeredWallet,
    registeredWallets,
    registerOpenedSession,
    reloadRegisteredWallet,
  } = useWalletState();
  const normalizedRestoreSeed = normalizeSeed(restoreSeed);
  const restoreSeedWordCount = normalizedRestoreSeed
    ? normalizedRestoreSeed.split(" ").length
    : 0;
  const restoreHeightNumber =
    restoreHeight.trim().length > 0 ? Number(restoreHeight.trim()) : 0;
  const restoreHeightReady =
    Number.isFinite(restoreHeightNumber) && restoreHeightNumber >= 0;
  const canUseBiometric = biometricReady(biometricStatus);
  const currentBiometricLabel = biometricLabel(biometricStatus);
  const createUsesBiometric =
    passwordPromptMode === "create" &&
    createCredentialMode === "device" &&
    canUseBiometric;
  const openUsesStoredSecret =
    passwordPromptMode === "open" &&
    registeredWallet?.kind !== "hardware" &&
    Boolean(registeredWallet?.credentialKey);
  const openUsesHardwareWallet =
    passwordPromptMode === "open" && registeredWallet?.kind === "hardware";
  const waitingForBiometricStatus =
    biometricStatus === undefined && biometricError === undefined;
  const createBiometricPending =
    passwordPromptMode === "create" &&
    createCredentialMode === "device" &&
    waitingForBiometricStatus;
  const showCreateMethodChoices =
    passwordPromptMode === "create" &&
    (canUseBiometric || createBiometricPending);
  const showBiometricCard =
    createUsesBiometric || createBiometricPending || openUsesStoredSecret;
  const showPasswordFields =
    passwordPromptMode === "restore" ||
    (passwordPromptMode === "create" &&
      (createCredentialMode === "password" || !canUseBiometric) &&
      !createBiometricPending) ||
    (passwordPromptMode === "open" &&
      !openUsesStoredSecret &&
      !openUsesHardwareWallet);
  const passwordReady =
    passwordPromptMode === "open"
      ? openUsesStoredSecret
        ? canUseBiometric
        : openUsesHardwareWallet
          ? true
          : walletPassword.length > 0
        : passwordPromptMode === "restore"
          ? walletPassword.length >= 8 &&
            walletPassword === walletPasswordConfirm &&
          restoreSeedWordCount === MONERO_SEED_WORD_COUNT &&
          restoreHeightReady
        : createUsesBiometric
          ? canUseBiometric
          : walletPassword.length >= 8 &&
            walletPassword === walletPasswordConfirm;
  const passwordPromptTitle =
    passwordPromptMode === "open"
      ? "Open Wallet"
      : passwordPromptMode === "restore"
          ? "Import Wallet"
          : "Create Wallet";
  const passwordPromptSubtitle =
    passwordPromptMode === "open"
      ? openUsesStoredSecret
        ? `Confirm ${currentBiometricLabel} to unlock the local wallet file.`
        : openUsesHardwareWallet
          ? "Connect Ledger Nano, unlock it, and open the Monero app on the device."
          : "Enter the password for the local wallet file."
      : passwordPromptMode === "restore"
          ? "Paste your 25-word Monero seed and choose a local password."
          : createUsesBiometric
            ? `Use ${currentBiometricLabel}. You will back up a 25-word seed.`
            : "Choose a local password. You will back up a 25-word seed.";
  const passwordPromptAction =
    passwordPromptMode === "open"
      ? openUsesStoredSecret
        ? "Unlock"
        : "Open"
      : passwordPromptMode === "restore"
          ? "Import"
          : "Create";
  const seedWords = createdSeed.trim().split(/\s+/).filter(Boolean);
  const seedSubtitle =
    seedWords.length === MONERO_SEED_WORD_COUNT
      ? "Write down all 25 words before using the wallet."
      : `Write down all ${seedWords.length} words exactly as shown.`;
  const openWalletDescription =
    registeredWallets.length > 1
      ? `${registeredWallet?.walletName ?? "Wallet"} on ${registeredWallet?.network ?? "mainnet"} (${registeredWallets.length} wallets)`
      : `${registeredWallet?.walletName ?? "Wallet"} on ${registeredWallet?.network ?? "mainnet"}`;

  useEffect(() => {
    Animated.timing(bgOp, { toValue: 1, duration: 1000, useNativeDriver: true }).start();
    Animated.parallel([
      Animated.timing(fadeIn, { toValue: 1, duration: 600, delay: 200, useNativeDriver: true }),
      Animated.spring(slideUp, { toValue: 0, friction: 9, tension: 40, delay: 200, useNativeDriver: true }),
    ]).start();
  }, [bgOp, fadeIn, slideUp]);

  useEffect(() => {
    reloadRegisteredWallet().catch(() => undefined);
  }, [reloadRegisteredWallet]);

  const refreshBiometricStatus = useCallback(async () => {
    setBiometricError(undefined);
    try {
      const status = await walletService.getBiometricAuthStatus();
      setBiometricStatus(status);
      return status;
    } catch (error) {
      setBiometricError(errorMessage(error));
      return undefined;
    }
  }, []);

  useEffect(() => {
    refreshBiometricStatus().catch(() => undefined);
  }, [refreshBiometricStatus]);

  useEffect(() => {
    if (
      passwordPromptMode === "create" &&
      createCredentialMode === "device" &&
      (biometricError || (biometricStatus && !canUseBiometric))
    ) {
      setCreateCredentialMode("password");
    }
  }, [
    biometricError,
    biometricStatus,
    canUseBiometric,
    createCredentialMode,
    passwordPromptMode,
  ]);

  const stopCreateEffects = () => {
    scanLoop.current?.stop();
    scanLoop.current = null;
    timers.current.forEach(clearTimeout);
    timers.current = [];
    if (cipherInterval.current) {
      clearInterval(cipherInterval.current);
      cipherInterval.current = null;
    }
  };

  useEffect(() => () => {
    stopCreateEffects();
  }, []);

  const openPasswordPrompt = useCallback((mode: PasswordPromptMode) => {
    if (creating) {
      return;
    }

    setCreateError(undefined);
    setWalletPassword("");
    setWalletPasswordConfirm("");
    if (mode === "restore") {
      setRestoreSeed("");
      setRestoreHeight("");
    }
    if (mode === "create") {
      setCreateCredentialMode(
        biometricStatus === undefined || biometricReady(biometricStatus)
          ? "device"
          : "password",
      );
    }
    if (mode === "create" || mode === "open") {
      refreshBiometricStatus().catch(() => undefined);
    }
    setPasswordPromptMode(mode);
  }, [biometricStatus, creating, refreshBiometricStatus]);

  const refreshLedgerTransport = async (requestAccess = false) => {
    setLedgerBusy(true);
    setLedgerError(undefined);
    try {
      const nextStatus = requestAccess
        ? await walletService.requestLedgerTransportAccess()
        : await walletService.getLedgerTransportStatus();
      setLedgerStatus(nextStatus);
      return nextStatus;
    } catch (error) {
      setLedgerError(errorMessage(error));
      return undefined;
    } finally {
      setLedgerBusy(false);
    }
  };

  const openLedgerPrompt = () => {
    if (creating) {
      return;
    }

    setLedgerPromptVisible(true);
    setLedgerStatus(undefined);
    setLedgerError(undefined);
    refreshLedgerTransport(true).catch(() => undefined);
  };

  useEffect(() => {
    if (initialModeHandled.current) {
      return;
    }

    const requestedMode = route?.params?.mode;
    if (requestedMode === "create" || requestedMode === "restore") {
      initialModeHandled.current = true;
      openPasswordPrompt(requestedMode);
    }
  }, [openPasswordPrompt, route?.params?.mode]);

  const beginCreateAnimation = (steps = CREATE_STEPS) => {
    stopCreateEffects();
    setCreateStep(steps[0]);
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

    steps.slice(1).forEach((step, index) => {
      timers.current.push(setTimeout(() => setCreateStep(step), 520 + index * 520));
    });
  };

  const finishCreateAnimation = () => {
    stopCreateEffects();
    createProgress.setValue(1);
  };

  const startCreateWallet = async () => {
    if (creating || !passwordReady) {
      return;
    }

    const password = walletPassword;
    setCreating(true);
    setCreatingKind("software");
    setPasswordPromptMode(undefined);
    setCreateError(undefined);
    setCreatedSeed("");
    setCreatedSeedWalletId(undefined);
    setSeedConfirmed(false);
    beginCreateAnimation(CREATE_STEPS);

    try {
      const result = await walletService.createNamedWallet({
        walletName: DEFAULT_WALLET_NAME,
        password,
        language: "English",
      });
      if (createFastReceiveOnSetup) {
        setCreateStep("Creating fast receive");
        await walletService.createFastReceiveIdentity({
          password,
        });
      }
      const seed = await walletService.getSeed(result.session);
      await walletService.startRefresh(result.session).catch(() => undefined);
      await registerOpenedSession(result.session, result.registration);

      finishCreateAnimation();
      setCreatedSeedWalletId(result.registration.id);
      setCreatedSeed(seed);
      setWalletPassword("");
      setWalletPasswordConfirm("");
    } catch (error) {
      finishCreateAnimation();
      setCreateError(errorMessage(error));
      setPasswordPromptMode("create");
    } finally {
      setCreating(false);
    }
  };

  const startCreateWalletWithBiometric = async () => {
    if (creating || !canUseBiometric) {
      return;
    }

    setCreating(true);
    setCreatingKind("software");
    setPasswordPromptMode(undefined);
    setCreateError(undefined);
    setCreatedSeed("");
    setCreatedSeedWalletId(undefined);
    setSeedConfirmed(false);
    beginCreateAnimation(CREATE_STEPS);

    try {
      const result = await walletService.createNamedWalletWithStoredSecret({
        walletName: DEFAULT_WALLET_NAME,
        language: "English",
      });
      if (createFastReceiveOnSetup) {
        setCreateStep("Creating fast receive");
        await walletService.createFastReceiveIdentity({});
      }
      const seed = await walletService.getSeed(result.session);
      await walletService.startRefresh(result.session).catch(() => undefined);
      await registerOpenedSession(result.session, result.registration);

      finishCreateAnimation();
      setCreatedSeedWalletId(result.registration.id);
      setCreatedSeed(seed);
    } catch (error) {
      finishCreateAnimation();
      setCreateError(errorMessage(error));
      setPasswordPromptMode("create");
      refreshBiometricStatus().catch(() => undefined);
    } finally {
      setCreating(false);
    }
  };

  const startRestoreWallet = async () => {
    if (creating || !passwordReady) {
      return;
    }

    const password = walletPassword;
    setCreating(true);
    setCreatingKind("restore");
    setPasswordPromptMode(undefined);
    setCreateError(undefined);
    setCreatedSeed("");
    setCreatedSeedWalletId(undefined);
    setSeedConfirmed(false);
    beginCreateAnimation(RESTORE_STEPS);

    try {
      const result = await walletService.restoreNamedWallet({
        walletName: DEFAULT_WALLET_NAME,
        password,
        mnemonic: normalizedRestoreSeed,
        restoreHeight: Math.floor(restoreHeightNumber),
      });
      await walletService.startRefresh(result.session).catch(() => undefined);
      await registerOpenedSession(result.session, result.registration);

      finishCreateAnimation();
      setWalletPassword("");
      setWalletPasswordConfirm("");
      setRestoreSeed("");
      setRestoreHeight("");
      navigation.navigate("Home");
    } catch (error) {
      finishCreateAnimation();
      setCreateError(errorMessage(error));
      setPasswordPromptMode("restore");
    } finally {
      setCreating(false);
    }
  };

  const startCreateHardwareWallet = async () => {
    if (creating) {
      return;
    }

    setCreating(true);
    setCreatingKind("hardware");
    setPasswordPromptMode(undefined);
    setCreateError(undefined);
    setCreatedSeed("");
    setCreatedSeedWalletId(undefined);
    setSeedConfirmed(false);
    beginCreateAnimation(HARDWARE_STEPS);

    try {
      const transportStatus =
        await walletService.requestLedgerTransportAccess();
      setLedgerStatus(transportStatus);
      if (
        !transportStatus.supported ||
        !transportStatus.available ||
        !transportStatus.permissionGranted
      ) {
        throw new Error(transportStatus.message);
      }

      const result = await walletService.createNamedWalletFromDevice({
        walletName: DEFAULT_HARDWARE_WALLET_NAME,
        deviceName: "Ledger",
      });
      await walletService.startRefresh(result.session).catch(() => undefined);
      await registerOpenedSession(result.session, result.registration);

      finishCreateAnimation();
      setLedgerPromptVisible(false);
      navigation.navigate("Home");
    } catch (error) {
      finishCreateAnimation();
      setCreateError(errorMessage(error));
      setLedgerError(errorMessage(error));
      setLedgerPromptVisible(true);
    } finally {
      setCreating(false);
    }
  };

  const openExistingWallet = async () => {
    if (creating || !passwordReady) {
      return;
    }

    setCreating(true);
    setCreatingKind(
      registeredWallet?.kind === "hardware" ? "hardware" : "software",
    );
    setPasswordPromptMode(undefined);
    setCreateError(undefined);
    setCreatedSeed("");
    setCreatedSeedWalletId(undefined);
    setSeedConfirmed(false);
    beginCreateAnimation(
      registeredWallet?.kind === "hardware" ? HARDWARE_STEPS : CREATE_STEPS,
    );
    setCreateStep("Opening wallet");

    try {
      const session = await walletService.openRegisteredWallet(walletPassword);
      await walletService.startRefresh(session).catch(() => undefined);
      const wallet = await walletService.loadRegisteredWallet();
      await registerOpenedSession(session, wallet);
      finishCreateAnimation();
      setWalletPassword("");
      navigation.navigate("Home");
    } catch (error) {
      finishCreateAnimation();
      setCreateError(errorMessage(error));
      setPasswordPromptMode("open");
      refreshBiometricStatus().catch(() => undefined);
    } finally {
      setCreating(false);
    }
  };

  const submitPasswordPrompt = () => {
    if (passwordPromptMode === "open") {
      openExistingWallet();
      return;
    }

    if (passwordPromptMode === "restore") {
      startRestoreWallet();
      return;
    }

    if (createUsesBiometric) {
      startCreateWalletWithBiometric();
      return;
    }

    startCreateWallet();
  };

  const finishSeedBackup = async () => {
    if (!seedConfirmed) {
      return;
    }

    try {
      if (createdSeedWalletId) {
        await walletService.markRegisteredWalletSeedBackedUp(createdSeedWalletId);
        await reloadRegisteredWallet();
      }
      setCreatedSeed("");
      setCreatedSeedWalletId(undefined);
      navigation.navigate("Home");
    } catch (error) {
      setCreateError(errorMessage(error));
    }
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

        <Text style={s.title}>Wallet Setup</Text>
        <Text style={s.subtitle}>Create, import, or connect Ledger Nano.</Text>

        {/* Options */}
        <View style={s.options}>
          {registeredWallet ? (
            <SetupOption
              icon={<IcoImport c={colors.orange} />}
              title="Open Wallet"
              desc={openWalletDescription}
              onPress={() => openPasswordPrompt("open")}
              disabled={creating}
            />
          ) : null}
          <SetupOption
            icon={<IcoPlus c={colors.orange} />}
            title="Create Wallet"
            desc={canUseBiometric ? `Use ${currentBiometricLabel}` : "Generate a new Monero wallet"}
            onPress={() => openPasswordPrompt("create")}
            disabled={creating}
          />
          <SetupOption
            icon={<IcoUsb c={colors.orange} />}
            title="Ledger Nano"
            desc="Create a hardware-backed Monero wallet"
            onPress={openLedgerPrompt}
            disabled={creating}
          />
          <SetupOption
            icon={<IcoImport c={colors.orange} />}
            title="Import Wallet"
            desc="Restore from Monero seed"
            onPress={() => openPasswordPrompt("restore")}
            disabled={creating}
          />
        </View>
      </Animated.View>

      {/* Footer */}
      <Text style={s.footer}>Your keys never leave this device.</Text>

      <Modal
        visible={passwordPromptMode !== undefined}
        transparent
        animationType="fade"
        onRequestClose={() => setPasswordPromptMode(undefined)}
      >
        <KeyboardAvoidingView
          behavior={Platform.OS === "ios" ? "padding" : undefined}
          style={s.promptKeyboard}
        >
          <View style={s.promptBackdrop}>
            <ScrollView
              style={s.promptScroller}
              keyboardShouldPersistTaps="handled"
              showsVerticalScrollIndicator={false}
              contentContainerStyle={s.promptScroll}
            >
              <View style={s.promptCard}>
                <Text style={s.promptTitle}>
                  {passwordPromptTitle}
                </Text>
                <Text style={s.promptSubtitle}>
                  {passwordPromptSubtitle}
                </Text>
                {passwordPromptMode === "restore" ? (
                  <>
                    <TextInput
                      value={restoreSeed}
                      onChangeText={setRestoreSeed}
                      placeholder="Seed phrase"
                      placeholderTextColor="rgba(255,255,255,0.28)"
                      multiline
                      autoCapitalize="none"
                      autoCorrect={false}
                      style={[s.input, s.seedInput]}
                    />
                    <TextInput
                      value={restoreHeight}
                      onChangeText={setRestoreHeight}
                      placeholder="Restore height (optional)"
                      placeholderTextColor="rgba(255,255,255,0.28)"
                      keyboardType="number-pad"
                      style={s.input}
                    />
                  </>
                ) : null}
                {showCreateMethodChoices ? (
                  <View style={s.createMethodRow}>
                    <TouchableOpacity
                      style={[
                        s.createMethodButton,
                        createCredentialMode === "device" &&
                          s.createMethodButtonActive,
                      ]}
                      activeOpacity={0.75}
                      onPress={() => setCreateCredentialMode("device")}
                    >
                      <Text
                        style={[
                          s.createMethodText,
                          createCredentialMode === "device" &&
                            s.createMethodTextActive,
                        ]}
                      >
                        Device unlock
                      </Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={[
                        s.createMethodButton,
                        createCredentialMode === "password" &&
                          s.createMethodButtonActive,
                      ]}
                      activeOpacity={0.75}
                      onPress={() => setCreateCredentialMode("password")}
                    >
                      <Text
                        style={[
                          s.createMethodText,
                          createCredentialMode === "password" &&
                            s.createMethodTextActive,
                        ]}
                      >
                        Password
                      </Text>
                    </TouchableOpacity>
                  </View>
                ) : null}
                {showBiometricCard ? (
                  <View style={s.biometricBox}>
                    <View style={s.biometricHeader}>
                      <View style={[
                        s.biometricDot,
                        canUseBiometric && s.biometricDotReady,
                      ]} />
                      <Text style={s.biometricTitle}>
                        {waitingForBiometricStatus
                          ? "Checking biometric unlock"
                          : currentBiometricLabel}
                      </Text>
                      {waitingForBiometricStatus ? (
                        <ActivityIndicator color={colors.orange} />
                      ) : null}
                    </View>
                    <Text style={s.biometricText}>
                      {biometricError ??
                        biometricStatus?.message ??
                        "Waiting for device security status."}
                    </Text>
                  </View>
                ) : null}
                {openUsesHardwareWallet ? (
                  <View style={s.biometricBox}>
                    <View style={s.biometricHeader}>
                      <View style={[s.biometricDot, s.biometricDotReady]} />
                      <Text style={s.biometricTitle}>Ledger Nano</Text>
                    </View>
                    <Text style={s.biometricText}>
                      Ready to open with the connected hardware wallet.
                    </Text>
                  </View>
                ) : null}
                {showPasswordFields ? (
                  <>
                    <TextInput
                      value={walletPassword}
                      onChangeText={setWalletPassword}
                      placeholder="Password"
                      placeholderTextColor="rgba(255,255,255,0.28)"
                      secureTextEntry
                      style={s.input}
                    />
                    {passwordPromptMode !== "open" ? (
                      <TextInput
                        value={walletPasswordConfirm}
                        onChangeText={setWalletPasswordConfirm}
                        placeholder="Confirm password"
                        placeholderTextColor="rgba(255,255,255,0.28)"
                        secureTextEntry
                        style={s.input}
                      />
                    ) : null}
                  </>
                ) : null}
                {createError ? <Text style={s.errorText}>{createError}</Text> : null}
                {showPasswordFields && passwordPromptMode !== "open" && walletPasswordConfirm.length > 0 && walletPassword !== walletPasswordConfirm ? (
                  <Text style={s.errorText}>Passwords do not match.</Text>
                ) : null}
                {passwordPromptMode === "restore" && restoreSeed.length > 0 && restoreSeedWordCount !== MONERO_SEED_WORD_COUNT ? (
                  <Text style={s.errorText}>Enter the full 25-word Monero seed.</Text>
                ) : null}
                {passwordPromptMode === "restore" && !restoreHeightReady ? (
                  <Text style={s.errorText}>Restore height must be a number.</Text>
                ) : null}
                {passwordPromptMode === "create" ? (
                  <View style={s.fastReceiveRow}>
                    <View style={s.fastReceiveText}>
                      <Text style={s.fastReceiveTitle}>Fast Receive</Text>
                      <Text style={s.fastReceiveValue}>
                        {createFastReceiveOnSetup ? "On" : "Off"}
                      </Text>
                    </View>
                    <Switch
                      value={createFastReceiveOnSetup}
                      onValueChange={setCreateFastReceiveOnSetup}
                      trackColor={{ false: "rgba(255,255,255,0.12)", true: colors.orange }}
                      thumbColor="#FFF"
                    />
                  </View>
                ) : null}
                <View style={s.promptActions}>
                  <TouchableOpacity
                    style={s.secondaryButton}
                    onPress={() => setPasswordPromptMode(undefined)}
                    disabled={creating}
                  >
                    <Text style={s.secondaryButtonText}>Cancel</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[s.primaryButton, !passwordReady && s.primaryButtonDisabled]}
                    onPress={submitPasswordPrompt}
                    disabled={!passwordReady || creating}
                  >
                    <Text
                      style={s.primaryButtonText}
                      numberOfLines={1}
                      adjustsFontSizeToFit
                      minimumFontScale={0.78}
                    >
                      {passwordPromptAction}
                    </Text>
                  </TouchableOpacity>
                </View>
              </View>
            </ScrollView>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      <Modal
        visible={ledgerPromptVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setLedgerPromptVisible(false)}
      >
        <View style={s.promptBackdrop}>
          <ScrollView
            style={s.promptScroller}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
            contentContainerStyle={s.promptScroll}
          >
            <View style={s.promptCard}>
              <Text style={s.promptTitle}>Ledger Nano</Text>
              <Text style={s.promptSubtitle}>
                Connect Ledger Nano with Bluetooth or USB, unlock it, and open the Monero app on the device.
              </Text>

              <View style={s.ledgerStatusBox}>
                <View style={s.ledgerStatusHeader}>
                  <View style={[
                    s.ledgerStatusDot,
                    ledgerTransportReady(ledgerStatus) && s.ledgerStatusDotReady,
                  ]} />
                  <Text style={s.ledgerStatusTitle}>
                    {ledgerBusy ? "Searching..." : ledgerStatusTitle(ledgerStatus)}
                  </Text>
                  {ledgerBusy ? <ActivityIndicator color={colors.orange} /> : null}
                </View>
                <Text style={s.ledgerStatusText}>
                  {ledgerError ?? ledgerStatus?.message ?? "Looking for an available Ledger transport."}
                </Text>
                {ledgerStatus ? (
                  <View style={s.ledgerMetaRow}>
                    <Text style={s.ledgerMetaText}>
                      {ledgerStatus.platform} · {ledgerStatus.transport}
                    </Text>
                    <Text style={s.ledgerMetaText}>
                      {ledgerStatus.deviceCount} device{ledgerStatus.deviceCount === 1 ? "" : "s"}
                    </Text>
                  </View>
                ) : null}
              </View>

              <View style={s.promptActions}>
                <TouchableOpacity
                  style={s.secondaryButton}
                  onPress={() => setLedgerPromptVisible(false)}
                  disabled={ledgerBusy || creating}
                >
                  <Text style={s.secondaryButtonText}>Cancel</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[
                    s.primaryButton,
                    (ledgerBusy || creating) && s.primaryButtonDisabled,
                  ]}
                  onPress={() => {
                    if (ledgerTransportReady(ledgerStatus)) {
                      startCreateHardwareWallet();
                      return;
                    }
                    refreshLedgerTransport(true).catch(() => undefined);
                  }}
                  disabled={ledgerBusy || creating}
                >
                  <Text style={s.primaryButtonText}>
                    {ledgerTransportReady(ledgerStatus) ? "Create Wallet" : "Search"}
                  </Text>
                </TouchableOpacity>
              </View>
            </View>
          </ScrollView>
        </View>
      </Modal>

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
                <Text style={s.createTitle}>
                  {creatingKind === "hardware"
                    ? "Connecting Ledger"
                    : creatingKind === "restore"
                      ? "Importing Wallet"
                      : "Creating Wallet"}
                </Text>
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

      <Modal
        visible={createdSeed.length > 0}
        transparent={false}
        animationType="fade"
        presentationStyle="fullScreen"
      >
        <LinearGradient colors={["#12082A", "#0A0A18", "#07071A"]} locations={[0, 0.5, 1]} style={s.seedModal}>
          <StatusBar barStyle="light-content" backgroundColor="#12082A" />
          <ScrollView contentContainerStyle={s.seedContent}>
            <MoneroCoin size={62} />
            <Text style={s.seedTitle}>Recovery Seed</Text>
            <Text style={s.seedSubtitle}>{seedSubtitle}</Text>

            <View style={s.seedGrid}>
              {seedWords.map((word, index) => (
                <View key={`${index}-${word}`} style={s.seedWord}>
                  <Text style={s.seedIndex}>{index + 1}</Text>
                  <Text style={s.seedWordText}>{word}</Text>
                </View>
              ))}
            </View>

            <TouchableOpacity
              style={s.seedConfirmRow}
              activeOpacity={0.75}
              onPress={() => setSeedConfirmed(value => !value)}
            >
              <View style={[s.seedCheckBox, seedConfirmed && s.seedCheckBoxOn]}>
                {seedConfirmed ? <Text style={s.seedCheckText}>OK</Text> : null}
              </View>
              <Text style={s.seedConfirmText}>I saved these 25 words offline.</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={[s.seedContinueButton, !seedConfirmed && s.primaryButtonDisabled]}
              onPress={finishSeedBackup}
              disabled={!seedConfirmed}
            >
              <Text style={s.primaryButtonText}>Continue</Text>
            </TouchableOpacity>
          </ScrollView>
        </LinearGradient>
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

  promptKeyboard: { flex: 1 },
  promptBackdrop: {
    flex: 1,
    paddingHorizontal: 24,
    backgroundColor: "rgba(0,0,0,0.72)",
  },
  promptScroller: { flex: 1, width: "100%" },
  promptScroll: {
    flexGrow: 1,
    justifyContent: "center",
    paddingVertical: SH < 720 ? 24 : 42,
  },
  promptCard: {
    width: "100%",
    maxWidth: 520,
    alignSelf: "center",
    borderRadius: 22,
    paddingTop: 22,
    paddingHorizontal: 22,
    paddingBottom: 22,
    backgroundColor: "#151227",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.1)",
  },
  promptTitle: { color: "#FFF", fontSize: 22, fontWeight: "800", marginBottom: 8 },
  promptSubtitle: { color: "rgba(255,255,255,0.48)", fontSize: 13, lineHeight: 18, marginBottom: 18 },
  input: {
    height: 52,
    borderRadius: 14,
    paddingHorizontal: 16,
    marginBottom: 10,
    color: "#FFF",
    backgroundColor: "rgba(255,255,255,0.06)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.1)",
  },
  seedInput: {
    height: 118,
    paddingTop: 14,
    textAlignVertical: "top",
  },
  errorText: { color: "#FF8A80", fontSize: 13, lineHeight: 18, marginBottom: 10 },
  fastReceiveRow: {
    minHeight: 52,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    borderRadius: 14,
    paddingHorizontal: 14,
    marginBottom: 12,
    backgroundColor: "rgba(255,255,255,0.06)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.1)",
  },
  fastReceiveText: { flex: 1, paddingRight: 12 },
  fastReceiveTitle: { color: "#FFF", fontSize: 14, fontWeight: "700" },
  fastReceiveValue: { color: "rgba(255,255,255,0.42)", fontSize: 12, marginTop: 2 },
  createMethodRow: {
    minHeight: 48,
    flexDirection: "row",
    gap: 8,
    marginBottom: 12,
    padding: 4,
    borderRadius: 14,
    backgroundColor: "rgba(255,255,255,0.055)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.1)",
  },
  createMethodButton: {
    flex: 1,
    minHeight: 38,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 10,
    paddingHorizontal: 8,
  },
  createMethodButtonActive: {
    backgroundColor: "rgba(242,104,34,0.92)",
  },
  createMethodText: {
    color: "rgba(255,255,255,0.55)",
    fontSize: 13,
    fontWeight: "800",
    textAlign: "center",
  },
  createMethodTextActive: { color: "#FFF" },
  biometricBox: {
    minHeight: 92,
    borderRadius: 16,
    padding: 16,
    marginBottom: 12,
    backgroundColor: "rgba(255,255,255,0.055)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.1)",
  },
  biometricHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    marginBottom: 8,
  },
  biometricDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: colors.warning,
  },
  biometricDotReady: { backgroundColor: colors.success },
  biometricTitle: {
    flex: 1,
    color: "#FFF",
    fontSize: 15,
    fontWeight: "800",
  },
  biometricText: {
    color: "rgba(255,255,255,0.55)",
    fontSize: 13,
    lineHeight: 19,
  },
  ledgerStatusBox: {
    minHeight: 118,
    borderRadius: 16,
    padding: 16,
    marginBottom: 14,
    backgroundColor: "rgba(255,255,255,0.055)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.1)",
  },
  ledgerStatusHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    marginBottom: 10,
  },
  ledgerStatusDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: colors.warning,
  },
  ledgerStatusDotReady: { backgroundColor: colors.success },
  ledgerStatusTitle: {
    flex: 1,
    color: "#FFF",
    fontSize: 15,
    fontWeight: "800",
  },
  ledgerStatusText: {
    color: "rgba(255,255,255,0.55)",
    fontSize: 13,
    lineHeight: 19,
  },
  ledgerMetaRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    gap: 12,
    marginTop: 14,
  },
  ledgerMetaText: {
    color: "rgba(255,255,255,0.34)",
    fontSize: 12,
    fontWeight: "700",
    textTransform: "uppercase",
  },
  promptActions: { flexDirection: "row", gap: 12, marginTop: 10 },
  secondaryButton: {
    flex: 1,
    height: 48,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 14,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.12)",
  },
  secondaryButtonText: { color: "rgba(255,255,255,0.75)", fontSize: 15, fontWeight: "700" },
  primaryButton: {
    flex: 1,
    height: 48,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 14,
    backgroundColor: colors.orange,
  },
  primaryButtonDisabled: { opacity: 0.45 },
  primaryButtonText: { color: "#FFF", fontSize: 15, fontWeight: "800" },

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

  seedModal: { flex: 1 },
  seedContent: {
    minHeight: SH,
    paddingHorizontal: 20,
    paddingTop: 72,
    paddingBottom: 42,
    alignItems: "center",
  },
  seedTitle: { color: "#FFF", fontSize: 28, fontWeight: "800", marginTop: 18, marginBottom: 8 },
  seedSubtitle: { color: "rgba(255,255,255,0.5)", fontSize: 14, lineHeight: 20, textAlign: "center", marginBottom: 22 },
  seedGrid: {
    width: "100%",
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
    marginBottom: 22,
  },
  seedWord: {
    width: "48.5%",
    minHeight: 42,
    flexDirection: "row",
    alignItems: "center",
    borderRadius: 12,
    paddingHorizontal: 10,
    backgroundColor: "rgba(255,255,255,0.055)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.08)",
  },
  seedIndex: { width: 24, color: colors.orange, fontSize: 12, fontWeight: "800" },
  seedWordText: { flex: 1, color: "#FFF", fontSize: 14, fontWeight: "700" },
  seedConfirmRow: {
    width: "100%",
    flexDirection: "row",
    alignItems: "center",
    marginBottom: 16,
  },
  seedCheckBox: {
    width: 28,
    height: 28,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
    marginRight: 12,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.24)",
  },
  seedCheckBoxOn: {
    backgroundColor: colors.orange,
    borderColor: colors.orange,
  },
  seedCheckText: { color: "#FFF", fontSize: 10, fontWeight: "900" },
  seedConfirmText: { flex: 1, color: "rgba(255,255,255,0.72)", fontSize: 14, fontWeight: "600" },
  seedContinueButton: {
    width: "100%",
    height: 52,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 15,
    backgroundColor: colors.orange,
  },
});
