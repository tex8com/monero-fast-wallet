import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  FlatList,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useI18n } from "../i18n";

import { Icon } from "../components/Icon";
import { colors, radius, spacing } from "../theme/colors";
import {
  MONERO_SHARED_ELEMENTS,
  createMoneroAssistantReply,
  createTex8SharedManifestSnapshot,
} from "../services/Tex8SharedAssistant";
import type { Tex8AssistantContext } from "../services/Tex8SharedAssistant";
import { loadFastReceiveIdentities } from "../services/FastReceiveRegistry";
import type { FastReceiveIdentityRecord } from "../services/FastReceiveRegistry";
import { getActiveNodeConnectionSettings } from "../services/NodeConnectionSettings";
import { formatAtomicXmr } from "../services/WalletFormat";
import { useWalletState } from "../services/WalletState";
import { walletDisplayName } from "../services/WalletRegistry";
import type { AppControlCommand } from "../../../../../tex8/products/mobile-platform/shared-app/src/core/chat/appControlCommands";

type ChatMessage = {
  id: string;
  sender: "assistant" | "user";
  text: string;
  commands?: AppControlCommand[];
};

const QUICK_PROMPTS = [
  "Ledger Nano status",
  "Hosted private view key",
  "Monero Fast Node sync",
  "Receive address",
  "Privacy model",
];

function messageId() {
  return `msg-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function commandRoute(command: AppControlCommand): string | undefined {
  const elementType = command.elementType;
  if (elementType) {
    return MONERO_SHARED_ELEMENTS.find(element => element.type === elementType)
      ?.route;
  }

  const target = (command.screen || command.target || "").toLowerCase();
  if (target.includes("send")) return "Send";
  if (target.includes("receive")) return "Receive";
  if (target.includes("setting")) return "Settings";
  if (target.includes("ledger")) return "WalletSetup";
  if (target.includes("wallet") || target.includes("home")) return "Home";
  return undefined;
}

function commandLabel(command: AppControlCommand): string {
  const route = commandRoute(command);
  if (route) {
    return `Open ${route}`;
  }
  return command.elementType
    ? `Open ${command.elementType.replace(/_/g, " ")}`
    : "Run command";
}

export default function Tex8AssistantScreen({ navigation }: any) {
  const { t } = useI18n();
  const insets = useSafeAreaInsets();
  const listRef = useRef<FlatList<ChatMessage>>(null);
  const {
    hardwareStatus,
    registeredWallet,
    session,
    snapshot,
    status,
  } = useWalletState();
  const [input, setInput] = useState("");
  const [fastReceiveIdentities, setFastReceiveIdentities] = useState<
    FastReceiveIdentityRecord[]
  >([]);
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: "welcome",
      sender: "assistant",
      text:
        "Tex8 shared assistant is connected to the Monero app-control contract. Ask about Ledger, hosted scan, Cuprate, sending, receiving, or privacy.",
    },
  ]);

  useEffect(() => {
    let mounted = true;
    loadFastReceiveIdentities()
      .then(identities => {
        if (mounted) {
          setFastReceiveIdentities(identities);
        }
      })
      .catch(() => undefined);

    return () => {
      mounted = false;
    };
  }, []);

  const assistantContext = useMemo<Tex8AssistantContext>(() => {
    const nodeSettings = getActiveNodeConnectionSettings(session?.network);
    return {
      walletStatus: status,
      walletName: registeredWallet
        ? walletDisplayName(registeredWallet)
        : undefined,
      network: session?.network ?? registeredWallet?.network,
      hasOpenWallet: Boolean(session && snapshot),
      primaryAddress: snapshot?.primaryAddress,
      balanceXmr: snapshot
        ? formatAtomicXmr(snapshot.balanceAtomic, { maxFractionDigits: 6 })
        : undefined,
      unlockedBalanceXmr: snapshot
        ? formatAtomicXmr(snapshot.unlockedBalanceAtomic, {
            maxFractionDigits: 6,
          })
        : undefined,
      hardwareDeviceName: session?.hardwareDevice?.name,
      hardwareConnected: hardwareStatus?.connected,
      fastReceiveCount: fastReceiveIdentities.length,
      enabledFastReceiveCount: fastReceiveIdentities.filter(
        identity => identity.status === "enabled",
      ).length,
      nodeMode: nodeSettings.mode,
      daemonAddress: nodeSettings.daemon.address,
      grpcEndpoint: nodeSettings.grpcEndpoint,
    };
  }, [
    fastReceiveIdentities,
    hardwareStatus,
    registeredWallet,
    session,
    snapshot,
    status,
  ]);

  const manifest = useMemo(() => createTex8SharedManifestSnapshot(), []);

  const sendMessage = (text: string) => {
    const trimmed = text.trim();
    if (!trimmed) {
      return;
    }

    const userMessage: ChatMessage = {
      id: messageId(),
      sender: "user",
      text: trimmed,
    };
    const reply = createMoneroAssistantReply(trimmed, assistantContext);
    const assistantMessage: ChatMessage = {
      id: messageId(),
      sender: "assistant",
      text: reply.text,
      commands: reply.commands,
    };

    setMessages(current => [...current, userMessage, assistantMessage]);
    setInput("");
    setTimeout(() => listRef.current?.scrollToEnd({ animated: true }), 80);
  };

  const runCommand = (command: AppControlCommand) => {
    const route = commandRoute(command);
    if (route) {
      navigation.navigate(route);
    }
  };

  return (
    <KeyboardAvoidingView
      style={s.container}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <StatusBar barStyle="light-content" backgroundColor={colors.bg} />
      <View style={[s.header, { paddingTop: insets.top + 16 }]}>
        <TouchableOpacity
          style={s.backButton}
          onPress={() => navigation.navigate("Menu")}
          activeOpacity={0.7}
        >
          <Icon name="arrow-left" size={20} color={colors.textSecondary} />
        </TouchableOpacity>
        <View style={s.headerText}>
          <Text style={s.kicker}>{t('assistant.kicker')}</Text>
          <Text style={s.title}>{t('assistant.title')}</Text>
        </View>
      </View>

      <View style={s.contractRow}>
        <Text style={s.contractText} numberOfLines={1}>
          {manifest.contractVersion} · {manifest.elements.length} Monero elements
        </Text>
      </View>

      <FlatList
        ref={listRef}
        data={messages}
        keyExtractor={item => item.id}
        contentContainerStyle={s.messages}
        renderItem={({ item }) => {
          const isUser = item.sender === "user";
          return (
            <View style={[s.messageRow, isUser && s.messageRowUser]}>
              <View style={[s.bubble, isUser ? s.userBubble : s.assistantBubble]}>
                <Text style={[s.messageText, isUser && s.userText]}>
                  {item.text}
                </Text>
                {!isUser && item.commands?.length ? (
                  <View style={s.commandRow}>
                    {item.commands.map((command, index) => (
                      <TouchableOpacity
                        key={`${item.id}-${index}`}
                        style={s.commandChip}
                        onPress={() => runCommand(command)}
                        activeOpacity={0.74}
                      >
                        <Text style={s.commandText}>
                          {commandLabel(command)}
                        </Text>
                      </TouchableOpacity>
                    ))}
                  </View>
                ) : null}
              </View>
            </View>
          );
        }}
      />

      <View style={[s.inputWrap, { paddingBottom: Math.max(insets.bottom, 12) }]}>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={s.quickRow}
          keyboardShouldPersistTaps="handled"
        >
          {QUICK_PROMPTS.map(prompt => (
            <TouchableOpacity
              key={prompt}
              style={s.quickChip}
              onPress={() => sendMessage(prompt)}
              activeOpacity={0.75}
            >
              <Text style={s.quickText}>{prompt}</Text>
            </TouchableOpacity>
          ))}
        </ScrollView>
        <View style={s.inputRow}>
          <TextInput
            value={input}
            onChangeText={setInput}
            placeholder={t('assistant.placeholder')}
            placeholderTextColor={colors.textMuted}
            style={s.input}
            multiline
          />
          <TouchableOpacity
            style={[s.sendButton, !input.trim() && s.sendButtonDisabled]}
            onPress={() => sendMessage(input)}
            disabled={!input.trim()}
            activeOpacity={0.82}
          >
            <Icon name="send" size={19} color="#FFF" strokeWidth={2} />
          </TouchableOpacity>
        </View>
      </View>
    </KeyboardAvoidingView>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: spacing.lg,
    paddingBottom: 14,
    gap: 12,
  },
  backButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.bgCard,
    borderWidth: 1,
    borderColor: colors.border,
  },
  headerText: { flex: 1 },
  kicker: {
    color: colors.orange,
    fontSize: 12,
    fontWeight: "700",
    textTransform: "uppercase",
  },
  title: { color: colors.textPrimary, fontSize: 28, fontWeight: "800" },
  contractRow: {
    marginHorizontal: spacing.lg,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: radius.md,
    backgroundColor: "rgba(255,255,255,0.035)",
    borderWidth: 1,
    borderColor: colors.border,
  },
  contractText: { color: colors.textSecondary, fontSize: 12 },
  messages: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    paddingBottom: 18,
  },
  messageRow: {
    flexDirection: "row",
    justifyContent: "flex-start",
    marginBottom: 10,
  },
  messageRowUser: { justifyContent: "flex-end" },
  bubble: {
    maxWidth: "86%",
    borderRadius: radius.lg,
    paddingHorizontal: 15,
    paddingVertical: 12,
  },
  assistantBubble: {
    backgroundColor: colors.bgCard,
    borderWidth: 1,
    borderColor: colors.border,
  },
  userBubble: { backgroundColor: colors.orange },
  messageText: { color: colors.textPrimary, fontSize: 15, lineHeight: 21 },
  userText: { color: "#FFF", fontWeight: "600" },
  commandRow: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 12 },
  commandChip: {
    paddingHorizontal: 10,
    paddingVertical: 7,
    borderRadius: radius.full,
    backgroundColor: colors.orangeMuted,
  },
  commandText: { color: colors.orangeLight, fontSize: 12, fontWeight: "700" },
  inputWrap: {
    borderTopWidth: 1,
    borderTopColor: colors.border,
    backgroundColor: colors.tabBar,
    paddingTop: 10,
  },
  quickRow: { paddingHorizontal: spacing.lg, gap: 8, paddingBottom: 10 },
  quickChip: {
    paddingHorizontal: 13,
    paddingVertical: 8,
    borderRadius: radius.full,
    backgroundColor: colors.bgCard,
    borderWidth: 1,
    borderColor: colors.border,
  },
  quickText: { color: colors.textSecondary, fontSize: 12, fontWeight: "700" },
  inputRow: {
    flexDirection: "row",
    alignItems: "flex-end",
    paddingHorizontal: spacing.lg,
    gap: 10,
  },
  input: {
    flex: 1,
    minHeight: 46,
    maxHeight: 110,
    borderRadius: radius.lg,
    paddingHorizontal: 14,
    paddingVertical: 12,
    color: colors.textPrimary,
    backgroundColor: colors.bgInput,
    borderWidth: 1,
    borderColor: colors.border,
    fontSize: 15,
  },
  sendButton: {
    width: 46,
    height: 46,
    borderRadius: 23,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.orange,
  },
  sendButtonDisabled: { opacity: 0.42 },
});
