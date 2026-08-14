import { invoke } from '@tauri-apps/api/core';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  loadDesktopWalletAddresses,
  upsertDesktopWalletAddress,
  type DesktopWalletAddressRecord,
} from './walletAddressRegistry';

type Network = 'mainnet' | 'testnet' | 'stagenet';
type WalletRef = {
  id: string;
  network: Network;
  accountIndex?: number;
  addressIndex?: number;
};
type AppProtectionRef = {
  mode: 'none' | 'password' | 'system' | null;
  systemAuth: { label: string };
};
type OwnedNameStage =
  | 'commit-pending'
  | 'reveal-ready'
  | 'claim-pending'
  | 'active'
  | 'update-pending'
  | 'renew-pending'
  | 'revoke-pending'
  | 'expired'
  | 'revoked'
  | 'failed';
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
  kind: 'commit' | 'claim' | 'update' | 'renew' | 'revoke';
  years: number;
  recoveryExportRequired: boolean;
  preparedTransaction: PreparedTransaction;
};
type Availability = {
  canonicalName: string;
  status: 'available' | 'available-again' | 'taken' | 'pending' | 'reserved';
  chainTipHeight: number;
  expiryHeight?: number;
};
type NativeSubaddress = {
  accountIndex: number;
  addressIndex: number;
  address: string;
  label: string;
};
type NativeWalletSnapshot = {
  walletHeight: string;
  synchronized: boolean;
};

function messageOf(reason: unknown, fallback: string) {
  if (reason instanceof Error && reason.message.trim()) return reason.message;
  if (typeof reason === 'string' && reason.trim()) return reason;
  return fallback;
}

function short(value: string | undefined) {
  if (!value) return 'Not available';
  return value.length > 24 ? `${value.slice(0, 12)}…${value.slice(-10)}` : value;
}

function formatAtomic(value: string) {
  try {
    const atomic = BigInt(value);
    const whole = atomic / 1_000_000_000_000n;
    const fraction = (atomic % 1_000_000_000_000n)
      .toString()
      .padStart(12, '0')
      .replace(/0+$/, '');
    return `${whole}${fraction ? `.${fraction}` : ''}`;
  } catch {
    return value;
  }
}

function remainingDays(record: OwnedName) {
  if (
    record.expiryHeight === undefined ||
    record.lastChainTipHeight === undefined
  ) {
    return 'Pending';
  }
  return String(
    Math.ceil(
      Math.max(0, record.expiryHeight - record.lastChainTipHeight) / 720,
    ),
  );
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
  const [selectedAddressId, setSelectedAddressId] = useState('');
  const [newAddressLabel, setNewAddressLabel] = useState('');
  const [name, setName] = useState('');
  const [years, setYears] = useState(1);
  const [availability, setAvailability] = useState<Availability | null>(null);
  const [availabilityLoading, setAvailabilityLoading] = useState(false);
  const [prepared, setPrepared] = useState<PreparedMfw | null>(null);
  const [recoveryPassword, setRecoveryPassword] = useState('');
  const [authorizationPassword, setAuthorizationPassword] = useState('');
  const [updateAddresses, setUpdateAddresses] = useState<Record<string, string>>({});
  const [importName, setImportName] = useState('');
  const [importPassword, setImportPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    const result = await invoke<OwnedName[]>('list_mfw_names');
    setNames(result);
  }, []);

  useEffect(() => {
    if (!linked) return;
    void load().catch(reason =>
      setMessage(messageOf(reason, 'MFW names could not be loaded.')),
    );
  }, [linked, load]);

  useEffect(() => {
    let active = true;
    if (!walletId || !wallet) {
      setWalletAddresses([]);
      setSelectedAddressId('');
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
        existing.some(address => address.id === preferred)
          ? preferred
          : existing[0].id,
      );
    }
    void invoke<string>('wallet_address', {
      input: { walletId, accountIndex, addressIndex },
    })
      .then(value => {
        if (!active) return;
        const stored = upsertDesktopWalletAddress({
          walletId,
          accountIndex,
          addressIndex,
          address: value,
          label:
            addressIndex === 0
              ? 'Primary address'
              : `Address ${accountIndex}/${addressIndex}`,
        });
        setWalletAddresses(stored);
        const preferred = `${walletId}:${accountIndex}:${addressIndex}`;
        setSelectedAddressId(current =>
          stored.some(address => address.id === current)
            ? current
            : preferred,
        );
      })
      .catch(reason => {
        if (active)
          setMessage(messageOf(reason, 'The wallet address is unavailable.'));
      });
    return () => {
      active = false;
    };
  }, [wallet, walletId]);

  const selectedAddress = useMemo(
    () =>
      walletAddresses.find(address => address.id === selectedAddressId) ??
      walletAddresses[0],
    [selectedAddressId, walletAddresses],
  );

  const fetchAvailability = useCallback(
    async (candidate: string, activeWalletId: string, network: Network) => {
      const snapshotRaw = await invoke<string>('wallet_snapshot', {
        input: { walletId: activeWalletId },
      });
      const snapshot = JSON.parse(snapshotRaw) as NativeWalletSnapshot;
      if (!snapshot.synchronized)
        throw new Error('Synchronize the owner wallet before checking a name.');
      const walletChainHeight = Number(snapshot.walletHeight);
      if (!Number.isSafeInteger(walletChainHeight) || walletChainHeight < 1)
        throw new Error('The local wallet height is unavailable.');
      return invoke<Availability>('check_mfw_name_availability', {
        input: { name: candidate, network, walletChainHeight },
      });
    },
    [],
  );

  useEffect(() => {
    const candidate = name.trim();
    if (!candidate || !wallet || !walletId) {
      setAvailability(null);
      setAvailabilityLoading(false);
      return;
    }
    let active = true;
    const timer = window.setTimeout(() => {
      setAvailabilityLoading(true);
      void fetchAvailability(candidate, walletId, wallet.network)
        .then(result => {
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
  }, [fetchAvailability, name, wallet, walletId]);

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

  const checkAvailability = () =>
    run(async () => {
      if (!wallet) throw new Error('Open a wallet first.');
      if (!walletId) throw new Error('Open a wallet first.');
      const result = await fetchAvailability(name, walletId, wallet.network);
      setAvailability(result);
      setMessage(
        result.status === 'available' || result.status === 'available-again'
          ? `${result.canonicalName} is available.`
          : `${result.canonicalName} is ${result.status}.`,
      );
    }, 'Name availability could not be checked.');

  const prepareRegistration = () =>
    run(async () => {
      if (!walletId || !wallet || !selectedAddress)
        throw new Error('Open and synchronize the owner wallet first.');
      const result = await invoke<PreparedMfw>(
        'prepare_mfw_name_registration',
        {
          input: {
            walletId,
            walletRegistrationId: wallet.id,
            name,
            address: selectedAddress.address,
            network: wallet.network,
            years,
            priority: 'low',
            accountIndex: selectedAddress.accountIndex,
            addressIndex: selectedAddress.addressIndex,
          },
        },
      );
      setPrepared(result);
      setRecoveryPassword('');
      setAuthorizationPassword('');
      await load();
      setMessage(
        'Commit prepared. Export the encrypted owner recovery before approval.',
      );
    }, 'MFW registration could not be prepared.');

  const createDedicatedAddress = () =>
    run(async () => {
      if (!walletId || !wallet) throw new Error('Open the owner wallet first.');
      const raw = await invoke<string>('create_subaddress', {
        input: {
          walletId,
          accountIndex: wallet.accountIndex ?? 0,
          label: newAddressLabel.trim() || 'Public MFW name',
        },
      });
      const created = JSON.parse(raw) as NativeSubaddress;
      if (
        !Number.isInteger(created.accountIndex) ||
        !Number.isInteger(created.addressIndex) ||
        !created.address
      ) {
        throw new Error('The native wallet returned an invalid subaddress.');
      }
      const stored = upsertDesktopWalletAddress({
        walletId,
        accountIndex: created.accountIndex,
        addressIndex: created.addressIndex,
        address: created.address,
        label: created.label || newAddressLabel.trim() || 'Public MFW name',
      });
      setWalletAddresses(stored);
      setSelectedAddressId(
        `${walletId}:${created.accountIndex}:${created.addressIndex}`,
      );
      setNewAddressLabel('');
      setMessage(
        'Dedicated subaddress created and selected. The name-to-address link will still be public.',
      );
    }, 'A dedicated MFW subaddress could not be created.');

  const exportRecovery = (nameId: string) =>
    run(async () => {
      if (recoveryPassword.length < 12)
        throw new Error('Use a recovery password with at least 12 characters.');
      await invoke<OwnedName>('export_mfw_name_recovery', {
        input: {
          nameId,
          recoveryPassword,
          appPassword: authorizationPassword,
        },
      });
      setRecoveryPassword('');
      setAuthorizationPassword('');
      await load();
      setMessage('Encrypted owner recovery saved. Keep it offline and private.');
    }, 'MFW recovery could not be exported.');

  const commitPrepared = () =>
    run(async () => {
      if (!walletId || !prepared) return;
      const result = await invoke<string>('commit_transaction', {
        input: {
          walletId,
          pendingId: prepared.preparedTransaction.id,
          appPassword: authorizationPassword,
        },
      });
      const broadcast = JSON.parse(result) as PreparedTransaction;
      if (broadcast.status !== 'ok')
        throw new Error(broadcast.error || 'MFW transaction broadcast failed.');
      setPrepared(null);
      setAuthorizationPassword('');
      setRecoveryPassword('');
      await load();
      setMessage(
        `${prepared.kind} broadcast as ${short(broadcast.txIds[0])}. Refresh after confirmation.`,
      );
    }, 'MFW transaction could not be sent.');

  const prepareClaim = (record: OwnedName) =>
    run(async () => {
      if (!walletId || !wallet) throw new Error('Open the owner wallet first.');
      const result = await invoke<PreparedMfw>('prepare_mfw_name_claim', {
        input: {
          walletId,
          walletRegistrationId: wallet.id,
          nameId: record.id,
          priority: 'low',
          accountIndex: wallet.accountIndex ?? 0,
        },
      });
      setPrepared(result);
      setAuthorizationPassword('');
    }, 'MFW claim could not be prepared.');

  const prepareTransition = (
    record: OwnedName,
    operation: 'update' | 'renew' | 'revoke',
  ) =>
    run(async () => {
      if (!walletId || !wallet) throw new Error('Open the owner wallet first.');
      const result = await invoke<PreparedMfw>(
        'prepare_mfw_name_transition',
        {
          input: {
            walletId,
            walletRegistrationId: wallet.id,
            nameId: record.id,
            operation,
            address:
              operation === 'update'
                ? updateAddresses[record.id]?.trim()
                : undefined,
            years: operation === 'renew' ? years : record.termYears,
            priority: 'low',
            accountIndex: wallet.accountIndex ?? 0,
          },
        },
      );
      setPrepared(result);
      setAuthorizationPassword('');
    }, `MFW ${operation} could not be prepared.`);

  const refresh = (record: OwnedName) =>
    run(async () => {
      await invoke<OwnedName>('refresh_mfw_name', {
        input: { nameId: record.id, walletId },
      });
      await load();
      setMessage('MFW state refreshed from the wallet and resolver quorum.');
    }, 'MFW state could not be refreshed.');

  const importRecovery = () =>
    run(async () => {
      if (!wallet) throw new Error('Open the wallet that should manage this name.');
      if (importPassword.length < 12)
        throw new Error('Enter the recovery password.');
      await invoke<OwnedName>('import_mfw_name_recovery', {
        input: {
          walletRegistrationId: wallet.id,
          name: importName,
          network: wallet.network,
          recoveryPassword: importPassword,
          appPassword: authorizationPassword,
        },
      });
      setImportName('');
      setImportPassword('');
      setAuthorizationPassword('');
      await load();
      setMessage('MFW owner recovery authenticated against the finalized chain record.');
    }, 'MFW owner recovery could not be imported.');

  if (!linked || !walletId || !wallet) {
    return (
      <section className="empty-state">
        <img className="empty-mark" src="/monero-mark.png" alt="" />
        <h2>Monero names</h2>
        <p>Open a wallet before registering or managing a public .mfw name.</p>
      </section>
    );
  }

  const systemAuthorization = appProtection.mode === 'system';
  const passwordAuthorization = appProtection.mode === 'password';
  return (
    <section className="mfw-names-page">
      <header>
        <p className="eyebrow">Public recipient names</p>
        <h2>Monero names</h2>
        <p>
          Register a memorable <b>.mfw</b> name for a Monero address. Names and
          addresses are public; the owner key stays in this device’s protected
          credential store.
        </p>
      </header>

      {names.length > 0 && (
        <section className="mfw-name-list">
          <h3>My names</h3>
          {names.map(record => (
            <article className="mfw-name-card" key={record.id}>
              <div className="mfw-name-heading">
                <div>
                  <strong>{record.canonicalName}</strong>
                  <small>
                    {record.network} · sequence {record.sequence} · wallet{' '}
                    {short(record.walletRegistrationId)}
                  </small>
                </div>
                <span className={`mfw-stage ${record.stage}`}>
                  {record.stage.replace('-', ' ')}
                </span>
              </div>
              <code>{short(record.address)}</code>
              <dl>
                <div>
                  <dt>Term</dt>
                  <dd>{record.termYears} year(s)</dd>
                </div>
                <div>
                  <dt>Expiry block</dt>
                  <dd>{record.expiryHeight ?? 'Pending'}</dd>
                </div>
                <div>
                  <dt>Estimated days remaining</dt>
                  <dd>{remainingDays(record)}</dd>
                </div>
                <div>
                  <dt>Owner recovery</dt>
                  <dd>{record.recoveryExportedAt ? 'Exported' : 'Required'}</dd>
                </div>
              </dl>
              <div className="mfw-name-actions">
                <button
                  className="quiet-button"
                  disabled={
                    busy || record.walletRegistrationId !== wallet.id
                  }
                  onClick={() => void refresh(record)}
                  type="button"
                >
                  Refresh
                </button>
                {record.stage === 'reveal-ready' &&
                  record.walletRegistrationId === wallet.id && (
                  <button
                    className="primary"
                    disabled={busy}
                    onClick={() => void prepareClaim(record)}
                    type="button"
                  >
                    Prepare claim
                  </button>
                )}
                {record.stage === 'active' &&
                  record.walletRegistrationId === wallet.id && (
                  <>
                    <button
                      className="secondary"
                      disabled={busy}
                      onClick={() => void prepareTransition(record, 'renew')}
                      type="button"
                    >
                      Renew
                    </button>
                    <button
                      className="danger-button"
                      disabled={busy}
                      onClick={() => void prepareTransition(record, 'revoke')}
                      type="button"
                    >
                      Revoke
                    </button>
                  </>
                )}
                {['expired', 'revoked', 'failed'].includes(record.stage) &&
                  record.walletRegistrationId === wallet.id && (
                    <button
                      className="secondary"
                      disabled={busy}
                      onClick={() => {
                        setName(record.canonicalName);
                        setYears(record.termYears);
                        setAvailability(null);
                        setMessage(
                          'Name copied into a fresh availability check. A new registration always starts with COMMIT.',
                        );
                      }}
                      type="button"
                    >
                      Register again
                    </button>
                  )}
              </div>
              {record.stage === 'active' &&
                record.walletRegistrationId === wallet.id && (
                <div className="mfw-update-row">
                  <input
                    value={updateAddresses[record.id] ?? ''}
                    onChange={event =>
                      setUpdateAddresses(current => ({
                        ...current,
                        [record.id]: event.target.value,
                      }))
                    }
                    placeholder="New Monero address"
                    spellCheck="false"
                  />
                  <button
                    className="secondary"
                    disabled={!updateAddresses[record.id]?.trim() || busy}
                    onClick={() => void prepareTransition(record, 'update')}
                    type="button"
                  >
                    Change address
                  </button>
                </div>
              )}
            </article>
          ))}
        </section>
      )}

      <section className="mfw-register-card">
        <h3>Register a name</h3>
        <div className="mfw-form-grid">
          <label>
            Name
            <input
              value={name}
              onChange={event => {
                setName(event.target.value);
                setAvailability(null);
              }}
              placeholder="alice.mfw"
              maxLength={67}
              spellCheck="false"
            />
          </label>
          <label>
            Term
            <select
              value={years}
              onChange={event => setYears(Number(event.target.value))}
            >
              {Array.from({ length: 10 }, (_, index) => index + 1).map(value => (
                <option value={value} key={value}>
                  {value} year{value === 1 ? '' : 's'}
                </option>
              ))}
            </select>
          </label>
          <label>
            Receive address
            <select
              value={selectedAddress?.id ?? ''}
              onChange={event => setSelectedAddressId(event.target.value)}
            >
              {walletAddresses.map(address => (
                <option value={address.id} key={address.id}>
                  {address.label} · {short(address.address)}
                </option>
              ))}
            </select>
          </label>
          <label>
            New dedicated subaddress label
            <input
              value={newAddressLabel}
              onChange={event => setNewAddressLabel(event.target.value)}
              placeholder="Public MFW name"
              maxLength={80}
            />
          </label>
        </div>
        {selectedAddress && (
          <code className="mfw-selected-address">
            {selectedAddress.address}
          </code>
        )}
        <button
          className="quiet-button"
          disabled={busy}
          onClick={() => void createDedicatedAddress()}
          type="button"
        >
          Create & select dedicated subaddress
        </button>
        <p className="transaction-note">
          The selected name and receive address remain publicly linked in
          Monero history. A dedicated subaddress reduces address reuse.{' '}
          Registry fee: {years * 0.01} XMR plus normal Monero network fees.
          Registration uses two separately approved transactions.
        </p>
        <div className="mfw-name-actions">
          <button
            className="secondary"
            disabled={!name.trim() || busy || availabilityLoading}
            onClick={() => void checkAvailability()}
            type="button"
          >
            {availabilityLoading ? 'Checking…' : 'Check availability'}
          </button>
          <button
            className="primary"
            disabled={
              !availability ||
              !['available', 'available-again'].includes(availability.status) ||
              !selectedAddress ||
              busy
            }
            onClick={() => void prepareRegistration()}
            type="button"
          >
            Prepare commit
          </button>
        </div>
      </section>

      <section className="mfw-register-card">
        <h3>Restore owner recovery</h3>
        <p>
          The desktop host opens the file picker and checks the decrypted owner
          key against the finalized resolver quorum before saving it.
        </p>
        <div className="mfw-form-grid">
          <label>
            Name
            <input
              value={importName}
              onChange={event => setImportName(event.target.value)}
              placeholder="alice.mfw"
              spellCheck="false"
            />
          </label>
          <label>
            Recovery password
            <input
              value={importPassword}
              onChange={event => setImportPassword(event.target.value)}
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
              onChange={event => setAuthorizationPassword(event.target.value)}
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
                <dt>Registry amount</dt>
                <dd>
                  {formatAtomic(prepared.preparedTransaction.amountAtomic)} XMR
                </dd>
              </div>
              <div>
                <dt>Network fee</dt>
                <dd>{formatAtomic(prepared.preparedTransaction.feeAtomic)} XMR</dd>
              </div>
              <div>
                <dt>Transactions</dt>
                <dd>{prepared.preparedTransaction.txCount}</dd>
              </div>
            </dl>
            {prepared.recoveryExportRequired && (
              <label>
                New recovery password (12+ characters)
                <input
                  value={recoveryPassword}
                  onChange={event => setRecoveryPassword(event.target.value)}
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
                  onChange={event =>
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
                Export encrypted recovery first
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
                  setAuthorizationPassword('');
                  setRecoveryPassword('');
                }}
                type="button"
              >
                Cancel
              </button>
              <button
                className="primary"
                disabled={
                  busy ||
                  (prepared.recoveryExportRequired &&
                    !names.find(record => record.id === prepared.nameId)
                      ?.recoveryExportedAt) ||
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
