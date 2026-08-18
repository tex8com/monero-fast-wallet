import React, { useMemo, useState } from "react";
import {
  Modal,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";

import { useI18n, type TranslationKey } from "../i18n";
import type { WalletSnapshotCache } from "../services/WalletSnapshotCache";
import { colors, radius, spacing } from "../theme/colors";
import { Icon } from "./Icon";
import WalletSelector, {
  resolveWalletOption,
  type WalletOption,
  type WalletSelectorItem,
} from "./WalletSelector";

type WalletSwitcherPillProps = {
  activeWalletId?: string;
  detail?: string;
  snapshots: WalletSnapshotCache;
  titleKey: TranslationKey;
  wallets: WalletSelectorItem[];
  onManage?: () => void;
  onSelect: (wallet: WalletOption) => void | Promise<void>;
};

export default function WalletSwitcherPill({
  activeWalletId,
  detail,
  snapshots,
  titleKey,
  wallets,
  onManage,
  onSelect,
}: WalletSwitcherPillProps) {
  const [open, setOpen] = useState(false);
  const { t } = useI18n();
  const walletOptions = useMemo(
    () => wallets.map(wallet => resolveWalletOption(wallet, snapshots, key => t(key))),
    [snapshots, t, wallets],
  );
  const activeWallet = useMemo(
    () => walletOptions.find(wallet => wallet.id === activeWalletId),
    [activeWalletId, walletOptions],
  );
  const label =
    shortWalletAddress(activeWallet?.address) ??
    activeWallet?.label ??
    t("common.wallet");
  const meta = detail ?? activeWallet?.label ?? t("walletSelector.wallets");

  if (walletOptions.length === 0) {
    return null;
  }

  const handleSelect = async (wallet: WalletOption) => {
    if (wallet.disabled) {
      return;
    }

    setOpen(false);
    await onSelect(wallet);
  };

  return (
    <>
      <TouchableOpacity
        accessibilityLabel={t(titleKey)}
        activeOpacity={0.78}
        onPress={() => setOpen(true)}
        style={s.pill}
      >
        <Text style={s.addressText} numberOfLines={1}>
          {label}
        </Text>
        <View style={s.metaRow}>
          <Text style={s.metaText} numberOfLines={1}>
            {meta}
          </Text>
          <Icon name="chevron-right" size={13} color={colors.orange} strokeWidth={2.4} />
        </View>
      </TouchableOpacity>

      <Modal
        animationType="fade"
        transparent
        visible={open}
        onRequestClose={() => setOpen(false)}
      >
        <View style={s.modalRoot}>
          <TouchableOpacity
            activeOpacity={1}
            onPress={() => setOpen(false)}
            style={s.backdrop}
          />
          <View style={s.sheet}>
            <View style={s.sheetHandle} />
            <View style={s.sheetHeader}>
              <Text style={s.sheetTitle}>{t(titleKey)}</Text>
              <View style={s.sheetActions}>
                {onManage ? (
                  <TouchableOpacity
                    accessibilityLabel={t("wallets.title")}
                    activeOpacity={0.72}
                    onPress={() => {
                      setOpen(false);
                      onManage();
                    }}
                    style={s.closeButton}
                  >
                    <Icon name="settings" size={18} color={colors.orange} strokeWidth={2.2} />
                  </TouchableOpacity>
                ) : null}
                <TouchableOpacity
                  accessibilityLabel={t("action.cancel")}
                  activeOpacity={0.72}
                  onPress={() => setOpen(false)}
                  style={s.closeButton}
                >
                  <Icon name="close" size={18} color={colors.textSecondary} strokeWidth={2.2} />
                </TouchableOpacity>
              </View>
            </View>
            {onManage ? (
              <TouchableOpacity
                activeOpacity={0.78}
                onPress={() => {
                  setOpen(false);
                  onManage();
                }}
                style={s.manageButton}
              >
                <Icon name="plus" size={17} color={colors.orange} strokeWidth={2.4} />
                <Text style={s.manageText}>{t("wallets.manage")}</Text>
              </TouchableOpacity>
            ) : null}
            <WalletSelector
              activeWalletId={activeWalletId}
              snapshots={snapshots}
              showTitle={false}
              titleKey={titleKey}
              wallets={walletOptions}
              onSelect={handleSelect}
            />
          </View>
        </View>
      </Modal>
    </>
  );
}

function shortWalletAddress(address?: string): string | undefined {
  if (!address) {
    return undefined;
  }

  if (address.length <= 16) {
    return address;
  }

  return `${address.slice(0, 6)}...${address.slice(-5)}`;
}

const s = StyleSheet.create({
  pill: {
    minWidth: 118,
    maxWidth: 154,
    minHeight: 48,
    alignItems: "flex-end",
    justifyContent: "center",
    borderRadius: radius.full,
    borderWidth: 1,
    borderColor: "rgba(242,104,34,0.34)",
    backgroundColor: "rgba(242,104,34,0.11)",
    paddingHorizontal: 13,
    paddingVertical: 7,
  },
  addressText: {
    color: colors.textPrimary,
    fontFamily: "monospace",
    fontSize: 13,
    fontWeight: "900",
    maxWidth: "100%",
  },
  metaRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 2,
    marginTop: 2,
  },
  metaText: {
    color: colors.textSecondary,
    fontSize: 10,
    fontWeight: "800",
    maxWidth: 120,
  },
  modalRoot: {
    flex: 1,
    justifyContent: "flex-end",
  },
  backdrop: {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    backgroundColor: "rgba(0,0,0,0.58)",
  },
  sheet: {
    borderTopLeftRadius: 22,
    borderTopRightRadius: 22,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.bg,
    paddingHorizontal: spacing.lg,
    paddingTop: 10,
    paddingBottom: 34,
  },
  sheetHandle: {
    alignSelf: "center",
    width: 38,
    height: 4,
    borderRadius: 2,
    backgroundColor: "rgba(255,255,255,0.16)",
    marginBottom: 16,
  },
  sheetHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 14,
  },
  sheetTitle: {
    color: colors.textPrimary,
    fontSize: 19,
    fontWeight: "900",
  },
  sheetActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  closeButton: {
    width: 36,
    height: 36,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 18,
    backgroundColor: "rgba(255,255,255,0.06)",
  },
  manageButton: {
    minHeight: 44,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: "rgba(242,104,34,0.28)",
    backgroundColor: "rgba(242,104,34,0.1)",
    marginBottom: 14,
  },
  manageText: {
    color: colors.orange,
    fontSize: 14,
    fontWeight: "900",
  },
});
