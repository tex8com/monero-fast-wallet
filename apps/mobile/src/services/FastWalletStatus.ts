import type { TranslationKey } from "../i18n";
import type { FastReceiveIdentityRecord } from "./FastReceiveRegistry";

export type FastWalletStatusTone = "danger" | "muted" | "success" | "warning";

export type FastWalletStatusPresentation = {
  canRetry: boolean;
  description: string;
  label: string;
  ready: boolean;
  tone: FastWalletStatusTone;
};

type Translator = (key: TranslationKey) => string;

export function fastWalletStatusPresentation(
  identity: FastReceiveIdentityRecord,
  tex8Node: boolean,
  t: Translator,
): FastWalletStatusPresentation {
  if (!tex8Node) {
    return {
      canRetry: false,
      description: t("fastWallet.status.nodeRequiredDescription"),
      label: t("fastWallet.status.paused"),
      ready: false,
      tone: "warning",
    };
  }

  switch (identity.status) {
    case "enabled":
      return {
        canRetry: false,
        description: t(
          identity.notificationsEnabled
            ? "fastWallet.status.activeDescription"
            : "fastWallet.status.activeNoPushDescription",
        ),
        label: t("walletSelector.pushReady"),
        ready: true,
        tone: "success",
      };
    case "disabled":
      return {
        canRetry: true,
        description: t("fastWallet.status.offDescription"),
        label: t("walletSelector.pushOff"),
        ready: false,
        tone: "muted",
      };
    case "registration-error":
      return {
        canRetry: true,
        description: t("fastWallet.status.errorDescription"),
        label: t("fastWallet.status.actionNeeded"),
        ready: false,
        tone: "danger",
      };
    case "server-mismatch":
      return {
        canRetry: true,
        description: t("fastWallet.status.serverChangedDescription"),
        label: t("fastWallet.status.actionNeeded"),
        ready: false,
        tone: "warning",
      };
    case "local-only":
    default:
      return {
        canRetry: true,
        description: t("fastWallet.status.localOnlyDescription"),
        label: t("fastWallet.status.localOnly"),
        ready: false,
        tone: "muted",
      };
  }
}

export function fastWalletSelectorTone(
  status: FastWalletStatusPresentation,
): "balance" | "muted" | "success" | "warning" {
  if (status.tone === "success") {
    return "success";
  }
  if (status.tone === "danger" || status.tone === "warning") {
    return "warning";
  }
  return "muted";
}
