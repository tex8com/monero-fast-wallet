import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  loadDesktopWalletAddresses,
  upsertDesktopWalletAddress,
  type DesktopWalletAddressRecord,
} from "./walletAddressRegistry";

type Network = "mainnet" | "testnet" | "stagenet";
type WalletRef = {
  id: string;
  network: Network;
  kind?: string;
  role?: string;
  accountIndex?: number;
  addressIndex?: number;
};
type AppProtectionRef = {
  mode: "none" | "password" | "system" | null;
  systemAuth: { label: string };
};
type OwnedNameStage =
  | "commit-pending"
  | "reveal-ready"
  | "claim-pending"
  | "active"
  | "update-pending"
  | "renew-pending"
  | "revoke-pending"
  | "expired"
  | "revoked"
  | "failed";
type OwnedName = {
  version: 1;
  id: string;
  canonicalName: string;
  walletRegistrationId: string;
  walletAddressId: string;
  address: string;
  network: Network;
  stage: OwnedNameStage;
  termYears: number;
  sequence: number;
  ownerAuthority?: "local" | "recovery-required";
  ownerPublicKeyHex?: string;
  commitTxidHex?: string;
  commitHeight?: number;
  sourceTxidHex?: string;
  pendingAddress?: string;
  expiryHeight?: number;
  lastChainTipHeight?: number;
  recoveryExportedAt?: number;
  createdAt: number;
  updatedAt: number;
};
type PreparedTransaction = {
  id: string;
  status: string;
  error: string;
  amountAtomic: string;
  feeAtomic: string;
  txCount: string;
  txIds: string[];
};
type PreparedMfw = {
  nameId: string;
  canonicalName: string;
  kind: "commit" | "claim" | "update" | "renew" | "revoke";
  years: number;
  recoveryExportRequired: boolean;
  preparedTransaction: PreparedTransaction;
};
type Availability = {
  canonicalName: string;
  status: "available" | "available-again" | "taken" | "pending" | "reserved";
  chainTipHeight: number;
  expiryHeight?: number;
  checkedAtMs: number;
};
type NativeAvailability = Omit<Availability, "checkedAtMs" | "expiryHeight"> & {
  expiryHeight: number | null;
};
type NativeSubaddress = {
  accountIndex: number;
  addressIndex: number;
  address: string;
  label: string;
};
const MFW_NAME_MAX_TERM_YEARS = 1_000;
const MONERO_TARGET_BLOCK_TIME_MS = 2 * 60 * 1000;
const TERM_OPTIONS = [1, 3, 5, 10] as const;
function messageOf(reason: unknown, fallback: string) {
  if (reason instanceof Error && reason.message.trim()) return reason.message;
  if (typeof reason === "string" && reason.trim()) return reason;
  return fallback;
}

function short(value: string | undefined) {
  if (!value) return "Not available";
  return value.length > 24
    ? `${value.slice(0, 12)}…${value.slice(-10)}`
    : value;
}

function formatAtomic(value: string) {
  try {
    const atomic = BigInt(value);
    const whole = atomic / 1_000_000_000_000n;
    const fraction = (atomic % 1_000_000_000_000n)
      .toString()
      .padStart(12, "0")
      .replace(/0+$/, "");
    return `${whole}${fraction ? `.${fraction}` : ""}`;
  } catch {
    return value;
  }
}

function remainingDays(record: OwnedName) {
  if (
    record.expiryHeight === undefined ||
    record.lastChainTipHeight === undefined
  ) {
    return "Pending";
  }
  return String(
    Math.ceil(
      Math.max(0, record.expiryHeight - record.lastChainTipHeight) / 720,
    ),
  );
}

function estimatedExpiryTimestampMs(availability: Availability) {
  if (
    availability.expiryHeight === undefined ||
    !Number.isSafeInteger(availability.expiryHeight) ||
    !Number.isSafeInteger(availability.chainTipHeight)
  ) {
    return undefined;
  }
  const value =
    availability.checkedAtMs +
    (availability.expiryHeight - availability.chainTipHeight) *
      MONERO_TARGET_BLOCK_TIME_MS;
  return Number.isFinite(value) &&
    value >= -8_640_000_000_000_000 &&
    value <= 8_640_000_000_000_000
    ? value
    : undefined;
}

function formatTimestamp(timestampMs: number) {
  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(timestampMs));
}

export default function MfwNames({
  linked,
  walletId,
  wallet,
  appProtection,
}: {
  linked: boolean;
  walletId: string | null;
  wallet: WalletRef | null;
  appProtection: AppProtectionRef;
}) {
  const [names, setNames] = useState<OwnedName[]>([]);
  const [walletAddresses, setWalletAddresses] = useState<
    DesktopWalletAddressRecord[]
  >([]);
  const [selectedAddressId, setSelectedAddressId] = useState("");
  const [addressInputMode, setAddressInputMode] = useState<"wallet" | "manual">(
    "wallet",
  );
  const [manualAddress, setManualAddress] = useState("");
  const [newAddressLabel, setNewAddressLabel] = useState("");
  const [name, setName] = useState("");
  const [years, setYears] = useState(1);
  const [registrationStep, setRegistrationStep] = useState<1 | 2 | 3>(1);
  const [showAllNames, setShowAllNames] = useState(false);
  const [selectedNameId, setSelectedNameId] = useState<string | null>(null);
  const [nameActionMode, setNameActionMode] = useState<
    "renew" | "update" | "recovery" | null
  >(null);
  const [availability, setAvailability] = useState<Availability | null>(null);
  const [availabilityLoading, setAvailabilityLoading] = useState(false);
  const [prepared, setPrepared] = useState<PreparedMfw | null>(null);
  const [recoveryPassword, setRecoveryPassword] = useState("");
  const [authorizationPassword, setAuthorizationPassword] = useState("");
  const [updateAddresses, setUpdateAddresses] = useState<
    Record<string, string>
  >({});
  const [importName, setImportName] = useState("");
  const [importPassword, setImportPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [ledgerPreparationActive, setLedgerPreparationActive] = useState(false);

  const invokeMfwPreparation = async <T,>(
    command: string,
    input: Record<string, unknown>,
  ): Promise<T> => {
    const usesLedger =
      wallet?.kind === "hardware" && (wallet.role ?? "standard") === "standard";
    if (usesLedger) setLedgerPreparationActive(true);
    try {
      return await invoke<T>(command, { input });
    } finally {
      if (usesLedger) setLedgerPreparationActive(false);
    }
  };

  const load = useCallback(async () => {
    const result = await invoke<OwnedName[]>("list_mfw_names");
    setNames(result);
  }, []);

  useEffect(() => {
    if (!linked) return;
    void load().catch((reason) =>
      setMessage(messageOf(reason, "MFW names could not be loaded.")),
    );
  }, [linked, load]);

  useEffect(() => {
    let active = true;
    if (!walletId || !wallet) {
      setWalletAddresses([]);
      setSelectedAddressId("");
      return () => {
        active = false;
      };
    }
    const accountIndex = wallet.accountIndex ?? 0;
    const addressIndex = wallet.addressIndex ?? 0;
    const existing = loadDesktopWalletAddresses(walletId);
    setWalletAddresses(existing);
    if (existing.length > 0) {
      const preferred = `${walletId}:${accountIndex}:${addressIndex}`;
      setSelectedAddressId(
        existing.some((address) => address.id === preferred)
          ? preferred
          : existing[0].id,
      );
    }
    void invoke<string>("wallet_address", {
      input: { walletId, accountIndex, addressIndex },
    })
      .then(async (value) => {
        if (!active) return;
        const stored = upsertDesktopWalletAddress({
          walletId,
          accountIndex,
          addressIndex,
          address: value,
          label:
            addressIndex === 0
              ? "Primary address"
              : `Address ${accountIndex}/${addressIndex}`,
        });
        setWalletAddresses(stored);
        const preferred = `${walletId}:${accountIndex}:${addressIndex}`;
        setSelectedAddressId((current) =>
          stored.some((address) => address.id === current)
            ? current
            : preferred,
        );
        try {
          const discovered = await invoke<OwnedName[]>(
            "discover_mfw_names_for_wallet",
            {
              input: {
                walletId,
                walletRegistrationId: wallet.id,
                network: wallet.network,
                accountIndex,
                addressIndex,
              },
            },
          );
          if (active) setNames(discovered);
        } catch {
          // The wallet address remains usable when the optional public
          // discovery service is temporarily unavailable.
        }
      })
      .catch((reason) => {
        if (active)
          setMessage(messageOf(reason, "The wallet address is unavailable."));
      });
    return () => {
      active = false;
    };
  }, [wallet, walletId]);

  const selectedAddress = useMemo(
    () =>
      walletAddresses.find((address) => address.id === selectedAddressId) ??
      walletAddresses[0],
    [selectedAddressId, walletAddresses],
  );
  const receiveAddress =
    addressInputMode === "manual"
      ? manualAddress.trim()
      : (selectedAddress?.address ?? "");

  const fetchAvailability = useCallback(
    async (candidate: string, network: Network) => {
      const result = await invoke<NativeAvailability>(
        "check_mfw_name_availability",
        {
          input: { name: candidate, network },
        },
      );
      return {
        ...result,
        expiryHeight: result.expiryHeight ?? undefined,
        checkedAtMs: Date.now(),
      };
    },
    [],
  );

  const availabilityExpiryTimestampMs = availability
    ? estimatedExpiryTimestampMs(availability)
    : undefined;

  useEffect(() => {
    const candidate = name.trim();
    if (!candidate) {
      setAvailability(null);
      setAvailabilityLoading(false);
      return;
    }
    let active = true;
    const timer = window.setTimeout(() => {
      setAvailabilityLoading(true);
      void fetchAvailability(candidate, wallet?.network ?? "mainnet")
        .then((result) => {
          if (active) setAvailability(result);
        })
        .catch(() => {
          if (active) setAvailability(null);
        })
        .finally(() => {
          if (active) setAvailabilityLoading(false);
        });
    }, 450);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [fetchAvailability, name, wallet?.network]);

  const run = async (operation: () => Promise<void>, fallback: string) => {
    setBusy(true);
    setMessage(null);
    try {
      await operation();
    } catch (reason) {
      setMessage(messageOf(reason, fallback));
    } finally {
      setBusy(false);
    }
  };

  const prepareRegistration = () =>
    run(async () => {
      if (!walletId || !wallet)
        throw new Error("Open and synchronize the owner wallet first.");
      if (
        !Number.isSafeInteger(years) ||
        years < 1 ||
        years > MFW_NAME_MAX_TERM_YEARS
      )
        throw new Error(
          `Enter a whole registration term from 1 to ${MFW_NAME_MAX_TERM_YEARS.toLocaleString()} years.`,
        );
      if (!receiveAddress)
        throw new Error("Choose or enter a Monero receive address.");
      const validatedAddress = await invoke<string>(
        "validate_recipient_address",
        { input: { address: receiveAddress, network: wallet.network } },
      );
      const result = await invokeMfwPreparation<PreparedMfw>(
        "prepare_mfw_name_registration",
        {
          walletId,
          walletRegistrationId: wallet.id,
          name,
          address: validatedAddress,
          network: wallet.network,
          years,
          priority: "low",
          accountIndex:
            selectedAddress?.accountIndex ?? wallet.accountIndex ?? 0,
          addressIndex:
            selectedAddress?.addressIndex ?? wallet.addressIndex ?? 0,
        },
      );
      setPrepared(result);
      setRecoveryPassword("");
      setAuthorizationPassword("");
      await load();
      setMessage(
        "Commit prepared. Save the encrypted owner recovery before approval.",
      );
    }, "MFW registration could not be prepared.");

  const advanceRegistration = () => {
    setMessage(null);
    if (registrationStep === 1) {
      if (
        !availability ||
        !["available", "available-again"].includes(availability.status)
      ) {
        setMessage("Wait for an available name before continuing.");
        return;
      }
      setRegistrationStep(2);
      return;
    }
    if (registrationStep === 2) {
      if (
        !Number.isSafeInteger(years) ||
        years < 1 ||
        years > MFW_NAME_MAX_TERM_YEARS
      ) {
        setMessage("Enter a whole registration term from 1 to 1,000 years.");
        return;
      }
      if (!receiveAddress) {
        setMessage("Choose or enter a Monero receive address.");
        return;
      }
      setRegistrationStep(3);
      return;
    }
    void prepareRegistration();
  };

  const createDedicatedAddress = () =>
    run(async () => {
      if (!walletId || !wallet) throw new Error("Open the owner wallet first.");
      const raw = await invoke<string>("create_subaddress", {
        input: {
          walletId,
          accountIndex: wallet.accountIndex ?? 0,
          label: newAddressLabel.trim() || "Public MFW name",
        },
      });
      const created = JSON.parse(raw) as NativeSubaddress;
      if (
        !Number.isInteger(created.accountIndex) ||
        !Number.isInteger(created.addressIndex) ||
        !created.address
      ) {
        throw new Error("The native wallet returned an invalid subaddress.");
      }
      const stored = upsertDesktopWalletAddress({
        walletId,
        accountIndex: created.accountIndex,
        addressIndex: created.addressIndex,
        address: created.address,
        label: created.label || newAddressLabel.trim() || "Public MFW name",
      });
      setWalletAddresses(stored);
      setSelectedAddressId(
        `${walletId}:${created.accountIndex}:${created.addressIndex}`,
      );
      setNewAddressLabel("");
      setMessage(
        "Dedicated subaddress created and selected. The name-to-address link will still be public.",
      );
    }, "A dedicated MFW subaddress could not be created.");

  const exportRecovery = (nameId: string) =>
    run(async () => {
      if (recoveryPassword.length < 12)
        throw new Error("Use a recovery password with at least 12 characters.");
      await invoke<OwnedName>("export_mfw_name_recovery", {
        input: {
          nameId,
          recoveryPassword,
          appPassword: authorizationPassword,
        },
      });
      setRecoveryPassword("");
      setAuthorizationPassword("");
      setPrepared((current) =>
        current && current.nameId === nameId
          ? { ...current, recoveryExportRequired: false }
          : current,
      );
      await load();
      setMessage(
        "Encrypted owner recovery saved. Keep it offline and private.",
      );
    }, "MFW recovery could not be exported.");

  const commitPrepared = () =>
    run(async () => {
      if (!walletId || !wallet || !prepared) return;
      const result = await invoke<string>("commit_transaction", {
        input: {
          walletId,
          registrationId: wallet.id,
          pendingId: prepared.preparedTransaction.id,
          appPassword: authorizationPassword,
        },
      });
      const broadcast = JSON.parse(result) as PreparedTransaction;
      if (broadcast.status !== "ok")
        throw new Error(broadcast.error || "MFW transaction broadcast failed.");
      setPrepared(null);
      setAuthorizationPassword("");
      setRecoveryPassword("");
      await load();
      setMessage(
        `${prepared.kind} broadcast as ${short(
          broadcast.txIds[0],
        )}. Refresh after confirmation.`,
      );
    }, "MFW transaction could not be sent.");

  const prepareClaim = (record: OwnedName) =>
    run(async () => {
      if (!walletId || !wallet) throw new Error("Open the owner wallet first.");
      const result = await invokeMfwPreparation<PreparedMfw>(
        "prepare_mfw_name_claim",
        {
          walletId,
          walletRegistrationId: wallet.id,
          nameId: record.id,
          priority: "low",
          accountIndex: wallet.accountIndex ?? 0,
        },
      );
      setPrepared(result);
      setAuthorizationPassword("");
    }, "MFW claim could not be prepared.");

  const prepareTransition = (
    record: OwnedName,
    operation: "update" | "renew" | "revoke",
  ) =>
    run(async () => {
      if (!walletId || !wallet) throw new Error("Open the owner wallet first.");
      const result = await invokeMfwPreparation<PreparedMfw>(
        "prepare_mfw_name_transition",
        {
          walletId,
          walletRegistrationId: wallet.id,
          nameId: record.id,
          operation,
          address:
            operation === "update"
              ? updateAddresses[record.id]?.trim()
              : undefined,
          years: operation === "renew" ? years : record.termYears,
          priority: "low",
          accountIndex: wallet.accountIndex ?? 0,
        },
      );
      setPrepared(result);
      setAuthorizationPassword("");
    }, `MFW ${operation} could not be prepared.`);

  const refresh = (record: OwnedName) =>
    run(async () => {
      await invoke<OwnedName>("refresh_mfw_name", {
        input: { nameId: record.id, walletId },
      });
      await load();
      setMessage("MFW state refreshed from the wallet and resolver quorum.");
    }, "MFW state could not be refreshed.");

  const importRecovery = () =>
    run(async () => {
      if (!wallet)
        throw new Error("Open the wallet that should manage this name.");
      if (importPassword.length < 12)
        throw new Error("Enter the recovery password.");
      await invoke<OwnedName>("import_mfw_name_recovery", {
        input: {
          walletRegistrationId: wallet.id,
          name: importName,
          network: wallet.network,
          recoveryPassword: importPassword,
          appPassword: authorizationPassword,
        },
      });
      setImportName("");
      setImportPassword("");
      setAuthorizationPassword("");
      await load();
      setMessage(
        "MFW owner recovery authenticated against the finalized chain record.",
      );
    }, "MFW owner recovery could not be imported.");

  if (!linked || !walletId || !wallet) {
    return (
      <section className="empty-state">
        <img className="empty-mark" src="/monero-mark.png" alt="" />
        <h2>Monero names</h2>
        <p>Open a wallet before registering or managing a public .mfw name.</p>
      </section>
    );
  }

  const systemAuthorization = appProtection.mode === "system";
  const passwordAuthorization = appProtection.mode === "password";
  const recentNames = [...names].sort(
    (left, right) => right.updatedAt - left.updatedAt,
  );
  const visibleNames = showAllNames ? recentNames : recentNames.slice(0, 3);
  const selectedName = names.find((record) => record.id === selectedNameId);
  return (
    <section className="mfw-names-page">
      {ledgerPreparationActive && (
        <div
          className="seed-overlay ledger-view-key-overlay"
          role="dialog"
          aria-modal="true"
          aria-labelledby="mfw-ledger-title"
        >
          <section className="seed-dialog ledger-view-key-dialog">
            <img src="/monero-mark.png" alt="" />
            <p className="eyebrow">Ledger Nano</p>
            <h2 id="mfw-ledger-title">Connect your Ledger</h2>
            <p>
              Unlock it and open the Monero app. Keep it connected and confirm
              the name transaction when the request appears on the Ledger.
            </p>
            <div className="ledger-view-key-wait">
              <span aria-hidden="true" />
              <strong>Connecting and preparing the Ledger request…</strong>
            </div>
          </section>
        </div>
      )}
      {!selectedName && (
        <header>
          <p className="eyebrow">Monero names</p>
          <h2>Your Address Names</h2>
          <p>
            Claim a memorable public <b>.mfw</b> name for one of your Monero
            receive addresses.
          </p>
        </header>
      )}

      {selectedName && (
        <section className="mfw-name-detail">
          <button
            className="mfw-back-link"
            onClick={() => {
              setSelectedNameId(null);
              setNameActionMode(null);
              setMessage(null);
            }}
            type="button"
          >
            ← Back
          </button>
          <article className="mfw-name-card">
            <div className="mfw-name-heading">
              <div>
                <strong>{selectedName.canonicalName}</strong>
                <small>
                  {selectedName.network} · wallet{" "}
                  {short(selectedName.walletRegistrationId)}
                </small>
              </div>
              <span className={`mfw-stage ${selectedName.stage}`}>
                {selectedName.stage.replace("-", " ")}
              </span>
            </div>
            <code>{short(selectedName.address)}</code>
            <dl>
              <div>
                <dt>Registered term</dt>
                <dd>{selectedName.termYears.toLocaleString()} year(s)</dd>
              </div>
              <div>
                <dt>Expiry block</dt>
                <dd>
                  {selectedName.expiryHeight?.toLocaleString() ?? "Pending"}
                </dd>
              </div>
              <div>
                <dt>Days remaining</dt>
                <dd>{remainingDays(selectedName)}</dd>
              </div>
            </dl>
            <p className="transaction-note">
              Dates are estimates. The expiry block recorded on Monero is
              authoritative.
            </p>
            <div className="mfw-name-actions">
              <button
                className="quiet-button"
                disabled={
                  busy || selectedName.walletRegistrationId !== wallet.id
                }
                onClick={() => void refresh(selectedName)}
                type="button"
              >
                Refresh
              </button>
              {selectedName.stage === "reveal-ready" &&
                selectedName.walletRegistrationId === wallet.id && (
                  <button
                    className="primary"
                    disabled={busy}
                    onClick={() => void prepareClaim(selectedName)}
                    type="button"
                  >
                    Prepare claim
                  </button>
                )}
              {selectedName.stage === "active" &&
                selectedName.ownerAuthority !== "recovery-required" &&
                selectedName.walletRegistrationId === wallet.id && (
                  <>
                    <button
                      className="secondary"
                      disabled={busy}
                      onClick={() => {
                        const next = walletAddresses.find(
                          (entry) => entry.address !== selectedName.address,
                        );
                        if (next) {
                          setSelectedAddressId(next.id);
                          setUpdateAddresses((current) => ({
                            ...current,
                            [selectedName.id]: next.address,
                          }));
                        }
                        setNameActionMode("update");
                      }}
                      type="button"
                    >
                      Change address
                    </button>
                    <button
                      className="secondary"
                      disabled={busy}
                      onClick={() => {
                        setYears(selectedName.termYears);
                        setNameActionMode("renew");
                      }}
                      type="button"
                    >
                      Renew
                    </button>
                    <button
                      className="danger-button"
                      disabled={busy}
                      onClick={() =>
                        void prepareTransition(selectedName, "revoke")
                      }
                      type="button"
                    >
                      Revoke
                    </button>
                  </>
                )}
              {["expired", "revoked", "failed"].includes(selectedName.stage) &&
                selectedName.walletRegistrationId === wallet.id && (
                  <button
                    className="secondary"
                    disabled={busy}
                    onClick={() => {
                      setName(
                        selectedName.canonicalName.replace(/\.mfw$/i, ""),
                      );
                      setYears(selectedName.termYears);
                      setRegistrationStep(1);
                      setSelectedNameId(null);
                      setAvailability(null);
                      setMessage(null);
                    }}
                    type="button"
                  >
                    Register again
                  </button>
                )}
            </div>
          </article>

          {nameActionMode === "update" && (
            <section className="mfw-register-card mfw-action-card">
              <div className="mfw-inline-heading">
                <div>
                  <h3>Change address</h3>
                  <p>Enter the new Monero receive address.</p>
                </div>
                <button
                  className="quiet-button"
                  onClick={() => setNameActionMode(null)}
                  type="button"
                >
                  Cancel
                </button>
              </div>
              <div
                className="mfw-address-mode"
                role="radiogroup"
                aria-label="New receive address source"
              >
                <button
                  className={addressInputMode === "wallet" ? "selected" : ""}
                  onClick={() => setAddressInputMode("wallet")}
                  role="radio"
                  aria-checked={addressInputMode === "wallet"}
                  type="button"
                >
                  Choose from wallet
                </button>
                <button
                  className={addressInputMode === "manual" ? "selected" : ""}
                  onClick={() => setAddressInputMode("manual")}
                  role="radio"
                  aria-checked={addressInputMode === "manual"}
                  type="button"
                >
                  Enter manually
                </button>
              </div>
              {addressInputMode === "wallet" ? (
                <select
                  aria-label="New receive address"
                  value={selectedAddress?.id ?? ""}
                  onChange={(event) => {
                    setSelectedAddressId(event.target.value);
                    const next = walletAddresses.find(
                      (entry) => entry.id === event.target.value,
                    );
                    setUpdateAddresses((current) => ({
                      ...current,
                      [selectedName.id]: next?.address ?? "",
                    }));
                  }}
                >
                  {walletAddresses
                    .filter((entry) => entry.address !== selectedName.address)
                    .map((entry) => (
                      <option value={entry.id} key={entry.id}>
                        {entry.label} · {short(entry.address)}
                      </option>
                    ))}
                </select>
              ) : (
                <input
                  value={updateAddresses[selectedName.id] ?? ""}
                  onChange={(event) =>
                    setUpdateAddresses((current) => ({
                      ...current,
                      [selectedName.id]: event.target.value.trim(),
                    }))
                  }
                  placeholder="Paste or type a Monero address"
                  spellCheck="false"
                />
              )}
              <button
                className="primary"
                disabled={!updateAddresses[selectedName.id]?.trim() || busy}
                onClick={() => void prepareTransition(selectedName, "update")}
                type="button"
              >
                Prepare update
              </button>
            </section>
          )}

          {nameActionMode === "renew" && (
            <section className="mfw-register-card mfw-action-card">
              <div className="mfw-inline-heading">
                <div>
                  <h3>Renew name</h3>
                  <p>Choose how many additional years to register.</p>
                </div>
                <button
                  className="quiet-button"
                  onClick={() => setNameActionMode(null)}
                  type="button"
                >
                  Cancel
                </button>
              </div>
              <fieldset className="mfw-term-selector">
                <legend>Registration term</legend>
                <div className="mfw-term-options">
                  {TERM_OPTIONS.map((term) => (
                    <button
                      aria-checked={years === term}
                      className={years === term ? "selected" : ""}
                      key={term}
                      onClick={() => setYears(term)}
                      role="radio"
                      type="button"
                    >
                      <strong>{term}</strong>
                      <small>{term === 1 ? "year" : "years"}</small>
                    </button>
                  ))}
                </div>
                <label className="mfw-custom-term">
                  Other duration
                  <span>
                    <input
                      type="number"
                      inputMode="numeric"
                      min={1}
                      max={MFW_NAME_MAX_TERM_YEARS}
                      step={1}
                      value={Number.isFinite(years) ? years : ""}
                      onChange={(event) => setYears(Number(event.target.value))}
                    />
                    <b>years</b>
                  </span>
                </label>
              </fieldset>
              <button
                className="primary"
                disabled={
                  !Number.isSafeInteger(years) ||
                  years < 1 ||
                  years > MFW_NAME_MAX_TERM_YEARS ||
                  busy
                }
                onClick={() => void prepareTransition(selectedName, "renew")}
                type="button"
              >
                Prepare renewal
              </button>
            </section>
          )}

          {nameActionMode !== "recovery" && (
            <button
              className="mfw-recovery-link"
              onClick={() => {
                setImportName(
                  selectedName.canonicalName.replace(/\.mfw$/i, ""),
                );
                setNameActionMode("recovery");
              }}
              type="button"
            >
              ⌁ Restore owner recovery
            </button>
          )}
        </section>
      )}

      {!selectedName && (
        <section className="mfw-register-card">
          {registrationStep > 1 && <h3>Register a name</h3>}

          {registrationStep === 1 && (
            <>
              <div className="mfw-form-grid mfw-name-field-grid">
                <label>
                  Choose your name
                  <span className="mfw-name-input">
                    <input
                      autoFocus
                      value={name}
                      onChange={(event) => {
                        setName(event.target.value.replace(/\.mfw$/i, ""));
                        setAvailability(null);
                      }}
                      placeholder="alice"
                      maxLength={63}
                      spellCheck="false"
                    />
                    <b>.mfw</b>
                  </span>
                </label>
              </div>
              <p
                aria-live="polite"
                className={`mfw-availability ${availability?.status ?? ""}`}
              >
                {availabilityLoading ? (
                  <>
                    <span className="mfw-inline-spinner" />
                    Checking availability privately through Tor…
                  </>
                ) : availability ? (
                  `${availability.canonicalName} is ${availability.status}.`
                ) : (
                  "Enter a name. Availability is checked automatically."
                )}
              </p>
              {availability && (
                <div className="mfw-availability-details">
                  {availability.expiryHeight !== undefined && (
                    <div>
                      <span>Expiry block</span>
                      <strong>
                        {availability.expiryHeight.toLocaleString()}
                      </strong>
                    </div>
                  )}
                  {availabilityExpiryTimestampMs !== undefined && (
                    <div>
                      <span>
                        {availability.expiryHeight! <=
                        availability.chainTipHeight
                          ? "Estimated expired around"
                          : "Estimated valid until"}
                      </span>
                      <strong>
                        {formatTimestamp(availabilityExpiryTimestampMs)}
                      </strong>
                    </div>
                  )}
                  <div>
                    <span>Checked chain tip</span>
                    <strong>
                      {availability.chainTipHeight.toLocaleString()}
                    </strong>
                  </div>
                  <div>
                    <span>Checked at</span>
                    <strong>{formatTimestamp(availability.checkedAtMs)}</strong>
                  </div>
                  {availability.expiryHeight !== undefined && (
                    <small>
                      Times are estimates at the two-minute block target; the
                      expiry block is authoritative.
                    </small>
                  )}
                </div>
              )}
              <div className="mfw-name-actions mfw-registration-actions">
                <button
                  className="primary"
                  disabled={
                    !availability ||
                    !["available", "available-again"].includes(
                      availability.status,
                    ) ||
                    busy ||
                    availabilityLoading
                  }
                  onClick={advanceRegistration}
                  type="button"
                >
                  Continue
                </button>
              </div>
            </>
          )}

          {registrationStep === 2 && (
            <>
              <p className="mfw-step-summary">
                <b>{availability?.canonicalName}</b>
              </p>
              <div
                className="mfw-address-mode"
                role="radiogroup"
                aria-label="Receive address source"
              >
                <button
                  className={addressInputMode === "wallet" ? "selected" : ""}
                  onClick={() => setAddressInputMode("wallet")}
                  role="radio"
                  aria-checked={addressInputMode === "wallet"}
                  type="button"
                >
                  Choose from wallet
                </button>
                <button
                  className={addressInputMode === "manual" ? "selected" : ""}
                  onClick={() => setAddressInputMode("manual")}
                  role="radio"
                  aria-checked={addressInputMode === "manual"}
                  type="button"
                >
                  Enter manually
                </button>
              </div>
              {addressInputMode === "wallet" ? (
                <>
                  <label>
                    Receive address
                    <select
                      value={selectedAddress?.id ?? ""}
                      onChange={(event) =>
                        setSelectedAddressId(event.target.value)
                      }
                    >
                      {walletAddresses.map((address) => (
                        <option value={address.id} key={address.id}>
                          {address.label} · {short(address.address)}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Dedicated subaddress label
                    <input
                      value={newAddressLabel}
                      onChange={(event) =>
                        setNewAddressLabel(event.target.value)
                      }
                      placeholder="Public MFW name"
                      maxLength={80}
                    />
                  </label>
                  <button
                    className="quiet-button"
                    disabled={busy}
                    onClick={() => void createDedicatedAddress()}
                    type="button"
                  >
                    Create & select dedicated subaddress
                  </button>
                </>
              ) : (
                <label>
                  Any Monero receive address
                  <input
                    value={manualAddress}
                    onChange={(event) =>
                      setManualAddress(event.target.value.trim())
                    }
                    placeholder="Paste or type a Monero address"
                    spellCheck="false"
                    autoComplete="off"
                  />
                </label>
              )}
              <fieldset className="mfw-term-selector">
                <legend>Registration term</legend>
                <div className="mfw-term-options">
                  {TERM_OPTIONS.map((term) => (
                    <button
                      aria-checked={years === term}
                      className={years === term ? "selected" : ""}
                      key={term}
                      onClick={() => setYears(term)}
                      role="radio"
                      type="button"
                    >
                      <strong>{term}</strong>
                      <small>{term === 1 ? "year" : "years"}</small>
                    </button>
                  ))}
                </div>
                <label className="mfw-custom-term">
                  Other duration (maximum 1,000 years)
                  <span>
                    <input
                      aria-label="Other registration duration"
                      type="number"
                      inputMode="numeric"
                      min={1}
                      max={MFW_NAME_MAX_TERM_YEARS}
                      step={1}
                      value={Number.isFinite(years) ? years : ""}
                      onChange={(event) => setYears(Number(event.target.value))}
                    />
                    <b>years</b>
                  </span>
                </label>
              </fieldset>
              <div className="mfw-price-line">
                <span>Registry price</span>
                <strong>
                  {years >= 1 && years <= MFW_NAME_MAX_TERM_YEARS
                    ? (years * 0.01).toFixed(2)
                    : "—"}{" "}
                  XMR
                </strong>
              </div>
              <div className="mfw-name-actions mfw-registration-actions">
                <button
                  className="primary"
                  disabled={!receiveAddress || busy}
                  onClick={advanceRegistration}
                  type="button"
                >
                  Review
                </button>
                <button
                  className="quiet-button"
                  onClick={() => setRegistrationStep(1)}
                  type="button"
                >
                  Back
                </button>
              </div>
            </>
          )}

          {registrationStep === 3 && (
            <>
              <dl className="mfw-registration-review">
                <div>
                  <dt>Name</dt>
                  <dd>{availability?.canonicalName}</dd>
                </div>
                <div>
                  <dt>Term</dt>
                  <dd>{years.toLocaleString()} years</dd>
                </div>
                <div>
                  <dt>Registry price</dt>
                  <dd>{(years * 0.01).toFixed(2)} XMR</dd>
                </div>
                <div>
                  <dt>Receive address</dt>
                  <dd>
                    <code>{short(receiveAddress)}</code>
                  </dd>
                </div>
              </dl>
              <p className="transaction-note">
                The name and receive address are public. Registration uses two
                separately approved Monero transactions; normal network fees are
                additional.
              </p>
              <div className="mfw-name-actions mfw-registration-actions">
                <button
                  className="primary"
                  disabled={busy}
                  onClick={advanceRegistration}
                  type="button"
                >
                  Prepare first approval
                </button>
                <button
                  className="quiet-button"
                  onClick={() => setRegistrationStep(2)}
                  type="button"
                >
                  Back
                </button>
              </div>
            </>
          )}
        </section>
      )}

      {!selectedName && registrationStep === 1 && names.length > 0 && (
        <section className="mfw-recent-names">
          <div className="mfw-recent-heading">
            <div>
              <h3>Registered names</h3>
              <p>Select a name to view and manage it.</p>
            </div>
          </div>
          <div className="mfw-recent-track">
            {visibleNames.map((record) => (
              <button
                className="mfw-recent-card"
                key={record.id}
                onClick={() => {
                  setSelectedNameId(record.id);
                  setNameActionMode(null);
                  setMessage(null);
                }}
                type="button"
              >
                <span className="mfw-recent-card-top">
                  <b>⌁</b>
                  <span className={`mfw-stage ${record.stage}`}>
                    {record.stage.replace("-", " ")}
                  </span>
                </span>
                <strong>{record.canonicalName}</strong>
                <code>{short(record.address)}</code>
                <small>
                  {remainingDays(record) === "Pending"
                    ? record.network
                    : `${remainingDays(record)} days remaining`}
                </small>
              </button>
            ))}
          </div>
          {names.length > 3 && (
            <button
              className="mfw-show-more"
              onClick={() => setShowAllNames((current) => !current)}
              type="button"
            >
              {showAllNames ? "Show less" : "Show more"}
            </button>
          )}
        </section>
      )}

      {selectedName && nameActionMode === "recovery" && (
        <section className="mfw-register-card mfw-action-card">
          <div className="mfw-inline-heading">
            <div>
              <h3>Restore owner recovery</h3>
              <p>
                The desktop host opens the file picker and checks the decrypted
                owner key against the finalized resolver quorum before saving
                it.
              </p>
            </div>
            <button
              className="quiet-button"
              onClick={() => setNameActionMode(null)}
              type="button"
            >
              Cancel
            </button>
          </div>
          <div className="mfw-form-grid">
            <label>
              Name
              <input
                value={importName}
                onChange={(event) =>
                  setImportName(event.target.value.replace(/\.mfw$/i, ""))
                }
                placeholder="alice"
                spellCheck="false"
              />
            </label>
            <label>
              Recovery password
              <input
                value={importPassword}
                onChange={(event) => setImportPassword(event.target.value)}
                type="password"
                autoComplete="off"
              />
            </label>
          </div>
          {passwordAuthorization && (
            <label>
              App password
              <input
                value={authorizationPassword}
                onChange={(event) =>
                  setAuthorizationPassword(event.target.value)
                }
                type="password"
                autoComplete="current-password"
              />
            </label>
          )}
          <button
            className="secondary"
            disabled={
              !importName.trim() ||
              importPassword.length < 12 ||
              (passwordAuthorization && !authorizationPassword) ||
              busy
            }
            onClick={() => void importRecovery()}
            type="button"
          >
            Choose & authenticate recovery file
          </button>
        </section>
      )}

      {prepared && (
        <div
          className="seed-overlay"
          role="dialog"
          aria-modal="true"
          aria-labelledby="mfw-approval-title"
        >
          <section className="seed-dialog mfw-approval-dialog">
            <p className="eyebrow">MFW transaction review</p>
            <h2 id="mfw-approval-title">
              Approve {prepared.kind}: {prepared.canonicalName}
            </h2>
            <dl className="review-details">
              <div>
                <dt>Monero Fast Wallet Registry amount</dt>
                <dd>
                  {formatAtomic(prepared.preparedTransaction.amountAtomic)} XMR
                </dd>
              </div>
              <div>
                <dt>Network fee</dt>
                <dd>
                  {formatAtomic(prepared.preparedTransaction.feeAtomic)} XMR
                </dd>
              </div>
              <div>
                <dt>Transactions</dt>
                <dd>{prepared.preparedTransaction.txCount}</dd>
              </div>
            </dl>
            {prepared.recoveryExportRequired && (
              <label>
                Recovery password (12+ characters)
                <input
                  value={recoveryPassword}
                  onChange={(event) => setRecoveryPassword(event.target.value)}
                  type="password"
                  autoComplete="new-password"
                />
              </label>
            )}
            {passwordAuthorization && (
              <label>
                App password
                <input
                  value={authorizationPassword}
                  onChange={(event) =>
                    setAuthorizationPassword(event.target.value)
                  }
                  type="password"
                  autoComplete="current-password"
                />
              </label>
            )}
            {prepared.recoveryExportRequired && (
              <button
                className="secondary"
                disabled={
                  recoveryPassword.length < 12 ||
                  (passwordAuthorization && !authorizationPassword) ||
                  busy
                }
                onClick={() => void exportRecovery(prepared.nameId)}
                type="button"
              >
                Save encrypted owner recovery
              </button>
            )}
            <p className="transaction-note">
              A separate trusted operating-system confirmation displays the
              exact amount and network fee before broadcast.
            </p>
            <div className="dialog-actions">
              <button
                className="quiet-button"
                disabled={busy}
                onClick={() => {
                  setPrepared(null);
                  setAuthorizationPassword("");
                  setRecoveryPassword("");
                }}
                type="button"
              >
                Cancel
              </button>
              <button
                className="primary"
                disabled={
                  busy ||
                  prepared.recoveryExportRequired ||
                  (passwordAuthorization && !authorizationPassword)
                }
                onClick={() => void commitPrepared()}
                type="button"
              >
                {systemAuthorization
                  ? `Confirm with ${appProtection.systemAuth.label}`
                  : `Approve ${prepared.kind}`}
              </button>
            </div>
          </section>
        </div>
      )}

      {message && (
        <p className="setup-message" role="status">
          {message}
        </p>
      )}
    </section>
  );
}
