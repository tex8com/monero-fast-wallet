import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useMemo, useState } from "react";

import DesktopIcon from "./DesktopIcon";
import { enableDesktopFastWalletSignals } from "./fastWalletNotifications";

const MONERO_BASE58 =
  "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const ORDER_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TERMINAL = new Set([
  "completed",
  "partially_completed",
  "expired",
  "failed",
]);

export type VanityWallet = {
  id: string;
  displayName?: string;
  walletName: string;
  network: string;
  kind: string;
  role?: string;
  accountIndex?: number;
  isOpen?: boolean;
};

type VanityCandidate = {
  id: string;
  prefix: string;
  status: string;
  result_address?: string | null;
};

type VanityGroup = {
  id: string;
  status: string;
  prefixes: string[];
  maximum_search_seconds: number;
  search_expires_at?: number | null;
  matched_prefix?: string | null;
  result_address?: string | null;
  candidates: VanityCandidate[];
};

export type VanityOrder = {
  id: string;
  status: string;
  prefixes: string[];
  price_atomic: string;
  price_xmr: string;
  payment_address: string;
  quote_expires_at: number;
  confirmations: number;
  required_confirmations: number;
  active_prefix_slots: number;
  maximum_prefix_slots: number;
  search_groups: VanityGroup[];
};

type QuoteEnvelope = {
  version: number;
  status_deep_link: string;
  order: VanityOrder;
};

type PrefixField = { id: number; value: string };

function walletName(wallet: VanityWallet) {
  return wallet.displayName?.trim() || wallet.walletName;
}

function validPrefix(value: string) {
  return (
    value.length >= 2 &&
    value.length <= 10 &&
    value.startsWith("4") &&
    [...value].every((character) => MONERO_BASE58.includes(character))
  );
}

function sanitizePrefix(value: string) {
  const filtered = [...value]
    .filter((character) => MONERO_BASE58.includes(character))
    .join("");
  return (filtered.startsWith("4") ? filtered : `4${filtered}`).slice(0, 10);
}

function parseEnvelope(raw: string): QuoteEnvelope {
  const value = JSON.parse(raw) as Partial<QuoteEnvelope>;
  const order = value.order as Partial<VanityOrder> | undefined;
  if (
    value.version !== 1 ||
    !order ||
    typeof order.id !== "string" ||
    !ORDER_ID.test(order.id) ||
    value.status_deep_link !== `mfw://vanity/order/${order.id}` ||
    typeof order.status !== "string" ||
    typeof order.price_xmr !== "string" ||
    typeof order.payment_address !== "string" ||
    !Array.isArray(order.prefixes) ||
    !Array.isArray(order.search_groups) ||
    order.maximum_prefix_slots !== 2_000
  )
    throw new Error("The Vanity service returned an invalid order.");
  return value as QuoteEnvelope;
}

function statusLabel(status: string) {
  switch (status) {
    case "awaiting_payment":
      return "Waiting for payment";
    case "payment_seen":
      return "Payment detected";
    case "paid":
      return "Payment confirmed";
    case "queued":
      return "Waiting for a GPU slot";
    case "searching":
      return "Searching";
    case "completed":
      return "Address found";
    case "partially_completed":
      return "Partially completed";
    case "expired":
      return "Search expired";
    default:
      return status.replaceAll("_", " ");
  }
}

export default function Vanity({
  wallets,
  activeWallet,
  initialOrderId,
  onSelectWallet,
  onPay,
  onOrderTracked,
}: {
  wallets: VanityWallet[];
  activeWallet: VanityWallet | null;
  initialOrderId?: string;
  onSelectWallet: (wallet: VanityWallet) => void;
  onPay: (order: VanityOrder) => void;
  onOrderTracked: (orderId: string) => void;
}) {
  const supportedWallets = useMemo(
    () =>
      wallets.filter(
        (wallet) =>
          wallet.network === "mainnet" &&
          wallet.kind !== "hardware" &&
          wallet.kind !== "view-only",
      ),
    [wallets],
  );
  const selectedWallet =
    supportedWallets.find((wallet) => wallet.id === activeWallet?.id) ?? null;
  const [prefixes, setPrefixes] = useState<PrefixField[]>([
    { id: 1, value: "4" },
  ]);
  const [publicAddress, setPublicAddress] = useState("");
  const [quote, setQuote] = useState<QuoteEnvelope>();
  const [trackedOrderId, setTrackedOrderId] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string>();

  const refreshStatus = useCallback(async (orderId: string) => {
    if (!ORDER_ID.test(orderId)) return;
    try {
      const raw = await invoke<string>("vanity_order_status", { orderId });
      setQuote(parseEnvelope(raw));
      setMessage(undefined);
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : String(reason));
    }
  }, []);

  useEffect(() => {
    let active = true;
    void (async () => {
      const orderId =
        initialOrderId && ORDER_ID.test(initialOrderId)
          ? initialOrderId
          : await invoke<string | null>("latest_vanity_order_id");
      if (!active || !orderId || !ORDER_ID.test(orderId)) return;
      setTrackedOrderId(orderId);
      await refreshStatus(orderId);
    })().catch((reason) => {
      if (active)
        setMessage(reason instanceof Error ? reason.message : String(reason));
    });
    return () => {
      active = false;
    };
  }, [initialOrderId, onOrderTracked, refreshStatus]);

  useEffect(() => {
    if (!selectedWallet) {
      setPublicAddress("");
      return;
    }
    let active = true;
    void invoke<string>("wallet_address", {
      input: {
        walletId: selectedWallet.id,
        accountIndex: selectedWallet.accountIndex ?? 0,
      },
    })
      .then((address) => {
        if (active) setPublicAddress(address);
      })
      .catch(() => {
        if (active) setPublicAddress("");
      });
    return () => {
      active = false;
    };
  }, [selectedWallet?.accountIndex, selectedWallet?.id]);

  useEffect(() => {
    const order = quote?.order;
    if (!trackedOrderId || !order || TERMINAL.has(order.status)) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible")
        void refreshStatus(trackedOrderId);
    }, 10_000);
    return () => window.clearInterval(timer);
  }, [quote?.order, refreshStatus, trackedOrderId]);

  const values = prefixes.map((field) => field.value);
  const valid =
    values.every(validPrefix) && new Set(values).size === values.length;
  const canQuote = Boolean(
    selectedWallet && publicAddress && valid && prefixes.length <= 100,
  );

  const updatePrefix = (id: number, value: string) => {
    setMessage(undefined);
    setPrefixes((current) =>
      current.map((field) =>
        field.id === id ? { ...field, value: sanitizePrefix(value) } : field,
      ),
    );
  };

  const createQuote = async () => {
    if (!selectedWallet || !canQuote || busy) return;
    setBusy(true);
    setMessage(undefined);
    try {
      const notifications = await enableDesktopFastWalletSignals();
      if (
        !notifications.installationId ||
        notifications.gatewayStatus !== "active"
      ) {
        throw new Error(
          "Notifications must be ready before the quote is created.",
        );
      }
      const raw = await invoke<string>("create_vanity_quote", {
        input: {
          sourceWalletRegistrationId: selectedWallet.id,
          publicAddress,
          accountIndex: selectedWallet.accountIndex ?? 0,
          addressIndex: 0,
          prefixes: values,
          notificationInstallationId: notifications.installationId,
        },
      });
      const created = parseEnvelope(raw);
      setQuote(created);
      setTrackedOrderId(created.order.id);
      onOrderTracked(created.order.id);
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const backupVanityRecovery = async (orderId: string) => {
    if (busy) return;
    setBusy(true);
    setMessage(undefined);
    try {
      await invoke("export_vanity_recovery", { orderId });
      setMessage(
        "Vanity recovery saved. Keep it with the original wallet seed.",
      );
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  if (quote && trackedOrderId) {
    const order = quote.order;
    return (
      <section className="vanity-page">
        <header className="vanity-title">
          <span>
            <DesktopIcon name="key" size={28} />
          </span>
          <div>
            <p className="eyebrow">MONERO VANITY</p>
            <h2>{statusLabel(order.status)}</h2>
            <small>{order.id}</small>
          </div>
        </header>
        <article className="vanity-payment-card">
          <div>
            <small>SERVICE PRICE</small>
            <strong>{order.price_xmr} XMR</strong>
          </div>
          <code>{order.payment_address}</code>
          <p>
            {order.confirmations}/{order.required_confirmations} confirmations
          </p>
          {order.status === "awaiting_payment" ||
          order.status === "underpaid" ||
          order.status === "payment_seen" ? (
            <button
              className="primary"
              onClick={() => onPay(order)}
              type="button"
            >
              Pay with selected wallet
            </button>
          ) : null}
        </article>
        <section className="vanity-groups">
          {order.search_groups.length ? (
            order.search_groups.map((group, index) => (
              <article key={group.id}>
                <header>
                  <strong>Search group {index + 1}</strong>
                  <b>{statusLabel(group.status)}</b>
                </header>
                <p>{group.prefixes.join(" · ")}</p>
                {group.search_expires_at ? (
                  <small>
                    Ends{" "}
                    {new Date(group.search_expires_at * 1_000).toLocaleString()}
                  </small>
                ) : null}
                {group.result_address ? (
                  <code>{group.result_address}</code>
                ) : null}
              </article>
            ))
          ) : (
            <article>
              <p>The GPU search starts after the payment is confirmed.</p>
            </article>
          )}
        </section>
        <div className="button-row">
          <button
            className="secondary"
            disabled={busy}
            onClick={() => void refreshStatus(order.id)}
            type="button"
          >
            Refresh status
          </button>
          {order.search_groups.some(
            (group) => group.status === "completed" && group.result_address,
          ) ? (
            <button
              className="secondary"
              disabled={busy}
              onClick={() => void backupVanityRecovery(order.id)}
              type="button"
            >
              Back up recovery data
            </button>
          ) : null}
          <button
            className="quiet-button"
            onClick={() => {
              setQuote(undefined);
              setTrackedOrderId(undefined);
            }}
            type="button"
          >
            New request
          </button>
        </div>
        {message ? (
          <p className="setup-message" role="alert">
            {message}
          </p>
        ) : null}
      </section>
    );
  }

  return (
    <section className="vanity-page">
      <header className="vanity-title">
        <span>
          <DesktopIcon name="key" size={28} />
        </span>
        <div>
          <h2>Vanity Address</h2>
          <p>
            Create a custom Monero primary address. Private keys never leave
            this device.
          </p>
        </div>
      </header>
      <article className="vanity-security">
        <DesktopIcon name="lock" size={20} />
        <div>
          <strong>Your keys stay on this device</strong>
          <p>
            Only the selected public primary address and desired prefixes are
            sent through Tor.
          </p>
        </div>
      </article>
      <section className="vanity-wallets">
        <header>
          <strong>Paying wallet</strong>
          <small>Software mainnet wallets only</small>
        </header>
        <div className="wallet-strip receive-wallet-strip">
          {supportedWallets.map((wallet) => (
            <button
              className={
                wallet.id === selectedWallet?.id
                  ? "wallet-mini-card active"
                  : "wallet-mini-card"
              }
              key={wallet.id}
              onClick={() => onSelectWallet(wallet)}
              type="button"
            >
              <span>{walletName(wallet)}</span>
              <small>MAINNET</small>
              <strong>
                {wallet.id === selectedWallet?.id
                  ? "Selected"
                  : wallet.isOpen
                    ? "Use wallet"
                    : "Open wallet"}
              </strong>
            </button>
          ))}
        </div>
      </section>
      <article className="vanity-prefix-card">
        <header>
          <div>
            <strong>Desired prefixes</strong>
            <p>
              Up to three equal-length alternatives cost the same as one search.
            </p>
          </div>
          <small>{prefixes.length}/100</small>
        </header>
        <div className="vanity-prefix-list">
          {prefixes.map((field, index) => {
            const duplicate = values.indexOf(field.value) !== index;
            return (
              <label key={field.id}>
                <span>
                  Prefix {index + 1}
                  {prefixes.length > 1 ? (
                    <button
                      onClick={() =>
                        setPrefixes((current) =>
                          current.filter((item) => item.id !== field.id),
                        )
                      }
                      type="button"
                    >
                      Remove
                    </button>
                  ) : null}
                </span>
                <input
                  className={
                    !validPrefix(field.value) || duplicate ? "invalid" : ""
                  }
                  maxLength={10}
                  spellCheck="false"
                  value={field.value}
                  onChange={(event) =>
                    updatePrefix(field.id, event.target.value)
                  }
                />
                <small>
                  {duplicate
                    ? "Every prefix must be different."
                    : "Monero Base58 · 2–10 characters · starts with 4"}
                </small>
              </label>
            );
          })}
        </div>
        <button
          className="quiet-button vanity-add-prefix"
          disabled={prefixes.length >= 100}
          onClick={() =>
            setPrefixes((current) => [
              ...current,
              {
                id: Math.max(...current.map((field) => field.id)) + 1,
                value: "4",
              },
            ])
          }
          type="button"
        >
          ＋ Add another prefix
        </button>
        <button
          aria-busy={busy}
          className="primary vanity-continue"
          disabled={!canQuote || busy}
          onClick={() => void createQuote()}
          type="button"
        >
          {busy ? (
            <>
              <span className="vanity-tor-spinner" />
              Connecting through Tor…
            </>
          ) : (
            "Continue to payment"
          )}
        </button>
        {!publicAddress && selectedWallet ? (
          <p className="setup-message">
            Open the selected wallet before creating the quote.
          </p>
        ) : null}
        {message ? (
          <p className="setup-message" role="alert">
            {message}
          </p>
        ) : null}
      </article>
      <p className="vanity-scope">
        Maximum 100 prefixes per order and 2,000 active service slots.
        Ten-character searches run for up to 60 days and are not guaranteed.
      </p>
    </section>
  );
}
