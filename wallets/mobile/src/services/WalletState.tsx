import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { AppState } from 'react-native';

import type {
  HardwareWalletStatus,
  NetworkSyncStatus,
  WalletTransaction,
  WalletSnapshot,
} from './NativeMoneroWallet';
import {
  walletIsSpendReady,
  walletSnapshotIsSynchronized,
} from './WalletSynchronization';
import {
  ledgerInitialVerificationCanStart,
  saveRegisteredWallet,
  walletDisplayName,
  type RegisteredWallet,
} from './WalletRegistry';
import {
  isLedgerNodeVerificationError,
  isWalletSessionStaleError,
  walletService,
  type LedgerReconciliationProgress,
  type RegisteredWalletSessionRecovery,
  type WalletSession,
} from './WalletService';
import {
  LedgerSigningCancelledError,
  isLedgerSigningCancelledError,
  waitForLedgerSigningSpendReadyWithSingleRebuild,
  waitForLedgerTransport,
  waitForWalletSnapshotAtHeight,
  type LedgerSigningControl,
} from './LedgerSigningFlow';
import { activeSystemUiInterruptionDeadlineMs } from './SystemUiInterruption';
import {
  FastWalletPushService,
  type FastWalletPushEvent,
} from './FastWalletPushService';
import { logStartupEvent, logWalletEvent } from './WalletLogger';
import { networkSyncFailureCode } from './NetworkSyncFailure';
import {
  loadWalletSnapshotCache,
  pruneWalletSnapshotCache,
  saveWalletSnapshot,
  type WalletSnapshotCache,
} from './WalletSnapshotCache';
import {
  IncomingTransactionObserver,
  type IncomingTransactionNotice,
} from './IncomingTransactionObserver';
import {
  nextWalletPublication,
  presentWalletSync,
  syncStartHeightForWallet,
  type WalletPublication,
  type WalletReadinessPhase,
} from '../../../../packages/wallet-shared/src/walletSync';
import { useAppSecurity } from './AppSecurity';
import {
  loadPendingOutgoingTransactions,
  mergePendingOutgoingTransactions,
  recordPendingOutgoingTransaction,
  replacePendingOutgoingTransactions,
} from './PendingOutgoingRegistry';

type RegisterOpenedSessionOptions = {
  refresh?: boolean;
  select?: boolean;
  startNetwork?: boolean;
};

type RecoverStaleSession = (
  registration: RegisteredWallet,
  staleSession: WalletSession,
) => Promise<RegisteredWalletSessionRecovery>;

export type WalletRuntimeStatus =
  | 'loading'
  | 'empty'
  | 'locked'
  | 'opening'
  | 'syncing'
  | 'open'
  | 'error';

// This describes the app-wide transport for a network, never an individual
// address or wallet file. Wallet snapshots retain their own scan progress.
export type NodeConnectionStatus =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'error';

export type NodeConnectionPhase = 'tor' | 'block-sync';

interface WalletStateValue {
  error: string | undefined;
  registeredWallet: RegisteredWallet | undefined;
  registeredWallets: RegisteredWallet[];
  hardwareStatus: HardwareWalletStatus | undefined;
  walletSnapshots: WalletSnapshotCache;
  session: WalletSession | undefined;
  snapshot: WalletSnapshot | undefined;
  workingSnapshot: WalletSnapshot | undefined;
  walletReadinessPhase: WalletReadinessPhase | undefined;
  spendReady: boolean;
  transactions: WalletTransaction[];
  incomingTransactionNotice: IncomingTransactionNotice | undefined;
  nodeConnectionStatus: NodeConnectionStatus;
  nodeConnectionPhase: NodeConnectionPhase | undefined;
  networkSyncStatus: NetworkSyncStatus | undefined;
  ledgerReconciliationProgress: LedgerReconciliationProgress | undefined;
  status: WalletRuntimeStatus;
  syncProgress: number | undefined;
  syncStartHeight: number | undefined;
  isRegisteredWalletOpen: (walletId: string) => boolean;
  openRegisteredWalletById: (walletId: string) => Promise<boolean>;
  clearError: () => void;
  dismissIncomingTransactionNotice: () => void;
  registerOpenedSession: (
    session: WalletSession,
    registration?: RegisteredWallet,
    options?: RegisterOpenedSessionOptions,
  ) => Promise<void>;
  reloadRegisteredWallet: () => Promise<RegisteredWallet | undefined>;
  reloadRegisteredWallets: () => Promise<RegisteredWallet[]>;
  setActiveRegisteredWallet: (
    walletId: string,
  ) => Promise<RegisteredWallet | undefined>;
  renameRegisteredWallet: (
    walletId: string,
    displayName: string,
  ) => Promise<RegisteredWallet | undefined>;
  removeRegisteredWallet: (walletId: string) => Promise<RegisteredWallet[]>;
  backupRegisteredWalletSeed: (
    walletId: string,
    reason: string,
  ) => Promise<boolean>;
  refreshSnapshot: () => Promise<WalletSnapshot | undefined>;
  refreshTransactions: () => Promise<WalletTransaction[]>;
  publishPendingOutgoing: (transaction: WalletTransaction) => void;
  refreshHardwareWalletStatus: () => Promise<HardwareWalletStatus | undefined>;
  reconnectHardwareWallet: () => Promise<HardwareWalletStatus | undefined>;
  connectLedgerForSigning: (
    control?: LedgerSigningControl,
  ) => Promise<WalletSession | undefined>;
  restoreLedgerViewAfterSigning: () => Promise<boolean>;
  reconcileLedgerBalance: (fullSpendOutputScan?: boolean) => Promise<boolean>;
  showHardwareWalletAddress: (
    accountIndex?: number,
    addressIndex?: number,
    paymentId?: string,
  ) => Promise<HardwareWalletStatus | undefined>;
}

const WalletStateContext = createContext<WalletStateValue | undefined>(
  undefined,
);

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sessionRegistrationId(session: WalletSession): string {
  return session.registrationId ?? session.walletId;
}

function snapshotPublicationToken(snapshot: WalletSnapshot): string {
  return String(snapshot.snapshotRevision ?? 0);
}

function nodeConnectionFromNative(
  status: NetworkSyncStatus,
): NodeConnectionStatus {
  if (status.state === 'reconnecting' || status.phase === 'reconnecting') {
    return 'connecting';
  }
  if (status.state === 'retrying' || status.state === 'provider-backoff') {
    return 'error';
  }
  if (
    status.transportStarts > 0 &&
    ['fetching-blocks', 'fanout', 'scanning', 'synced'].includes(status.state)
  ) {
    return 'connected';
  }
  if (status.joinedWallets > 0 || status.state !== 'idle') {
    return 'connecting';
  }
  return 'idle';
}

function canOpenRegisteredWalletAutomatically(
  registration: RegisteredWallet,
): boolean {
  return (
    ((registration.kind === 'software' || registration.kind === 'fast') &&
      Boolean(registration.credentialKey)) ||
    (registration.kind === 'hardware' &&
      Boolean(
        registration.viewOnlyPath && registration.viewOnlyCredentialKey,
      ))
  );
}

export function WalletStateProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const { locked: appSecurityLocked, ready: appSecurityReady } =
    useAppSecurity();
  const [loadingRegistry, setLoadingRegistry] = useState(true);
  const [registeredWallet, setRegisteredWallet] = useState<
    RegisteredWallet | undefined
  >();
  const [registeredWallets, setRegisteredWallets] = useState<
    RegisteredWallet[]
  >([]);
  const [session, setSession] = useState<WalletSession | undefined>();
  const [hardwareStatus, setHardwareStatus] = useState<
    HardwareWalletStatus | undefined
  >();
  const hardwareStatusRef = useRef<HardwareWalletStatus | undefined>(undefined);
  const [walletSnapshots, setWalletSnapshots] = useState<WalletSnapshotCache>(
    {},
  );
  const walletSnapshotsRef = useRef<WalletSnapshotCache>({});
  const [snapshot, setSnapshot] = useState<WalletSnapshot | undefined>();
  const [syncStartHeight, setSyncStartHeight] = useState<number | undefined>();
  const [workingTransactions, setTransactions] = useState<WalletTransaction[]>(
    [],
  );
  const [publicationTick, setPublicationTick] = useState(0);
  const publicationsByRegistrationRef = useRef(
    new Map<string, WalletPublication<WalletSnapshot, WalletTransaction>>(),
  );
  const sessionGenerationsByRegistrationRef = useRef(new Map<string, number>());
  const [incomingTransactionNotice, setIncomingTransactionNotice] = useState<
    IncomingTransactionNotice | undefined
  >();
  const [error, setError] = useState<string | undefined>();
  const [nodeConnections, setNodeConnections] = useState<
    Record<string, NodeConnectionStatus>
  >({});
  const [nodeConnectionPhases, setNodeConnectionPhases] = useState<
    Record<string, NodeConnectionPhase>
  >({});
  const [networkSyncStatuses, setNetworkSyncStatuses] = useState<
    Record<string, NetworkSyncStatus>
  >({});
  const networkSyncStatusesRef = useRef<Record<string, NetworkSyncStatus>>({});
  const [ledgerReconciliationProgress, setLedgerReconciliationProgress] =
    useState<LedgerReconciliationProgress | undefined>();
  const [ledgerNodeRetryRegistrationId, setLedgerNodeRetryRegistrationId] =
    useState<string | undefined>();
  const ledgerNodeRetryRegistrationIdRef = useRef<string | undefined>(
    undefined,
  );
  const [sessionRecovering, setSessionRecovering] = useState(false);
  const sessionRef = useRef<WalletSession | undefined>(undefined);
  const sessionsByRegistrationRef = useRef(new Map<string, WalletSession>());
  const transactionsByRegistrationRef = useRef(
    new Map<string, WalletTransaction[]>(),
  );
  const pendingOutgoingByRegistrationRef = useRef(
    new Map<string, WalletTransaction[]>(),
  );
  const walletStateSamplesByRegistrationRef = useRef(
    new Map<
      string,
      { snapshot: WalletSnapshot; transactions: WalletTransaction[] }
    >(),
  );
  const syncStartHeightsRef = useRef(new Map<string, number>());
  const registeredWalletRef = useRef<RegisteredWallet | undefined>(undefined);
  const registeredWalletsRef = useRef<RegisteredWallet[]>([]);
  const activeWalletSelectionGenerationRef = useRef(0);
  const activeWalletPersistenceRef = useRef<Promise<void>>(Promise.resolve());
  const incomingTransactionObserverRef = useRef(
    new IncomingTransactionObserver(),
  );
  const incomingTransactionNoticeRef = useRef<
    IncomingTransactionNotice | undefined
  >(undefined);
  const incomingTransactionNoticeQueueRef = useRef<IncomingTransactionNotice[]>(
    [],
  );
  const walletOpenInFlightRef = useRef(
    new Map<string, Promise<WalletSession>>(),
  );
  const recoverStaleSessionRef = useRef<RecoverStaleSession | undefined>(
    undefined,
  );
  const nativeRefreshWalletIdsRef = useRef(new Set<string>());
  const nativeRefreshReadyWalletIdsRef = useRef(new Set<string>());
  const nativeRefreshRetryAttemptsRef = useRef(new Map<string, number>());
  const nativeRefreshRetryTimeoutsRef = useRef(
    new Map<string, ReturnType<typeof setTimeout>>(),
  );
  const deferredNativeRefreshTimeoutsRef = useRef(
    new Map<string, ReturnType<typeof setTimeout>>(),
  );
  const snapshotRefreshInFlightIdsRef = useRef(new Set<string>());
  const transactionRefreshInFlightIdsRef = useRef(new Set<string>());
  const globallyLockedRef = useRef(false);
  const hardwareRefreshInFlight = useRef(false);
  const processedPushEventIdRef = useRef<string | undefined>(undefined);
  const fastWalletMigrationCompletedRef = useRef(false);
  const fastWalletMigrationInFlightRef = useRef(false);
  const lastNativeNetworkStateRef = useRef(new Map<string, string>());
  const ledgerInitialVerificationAttemptedRef = useRef(new Set<string>());
  const ledgerInitialVerificationNextAttemptAtRef = useRef(
    new Map<string, number>(),
  );
  // One physical Ledger can answer one key-image request at a time. This is
  // deliberately application-wide rather than tied to the selected card or
  // reconciliation origin (automatic, background, or a legacy caller).
  const ledgerReconciliationInFlightRef = useRef(false);
  const startupStateRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    const transitionKey = `${appSecurityReady}:${appSecurityLocked}:${loadingRegistry}`;
    if (startupStateRef.current === transitionKey) {
      return;
    }
    startupStateRef.current = transitionKey;
    logStartupEvent('AppStartup', 'walletState.lifecycle', {
      appSecurityLocked,
      appSecurityReady,
      loadingRegistry,
    });
  }, [appSecurityLocked, appSecurityReady, loadingRegistry]);

  const updateNodeConnection = useCallback(
    (network: string, next: NodeConnectionStatus) => {
      setNodeConnections(previous => {
        const current = previous[network];
        // A second wallet joining an already live network must not make the
        // whole application look as if it is reconnecting. Likewise, an
        // isolated wallet error must not erase a connection confirmed by a
        // different local scanner.
        if (
          (current === 'connected' && next === 'connecting') ||
          (current === 'connected' && next === 'error')
        ) {
          return previous;
        }
        if (current === next) {
          return previous;
        }
        return { ...previous, [network]: next };
      });
    },
    [],
  );

  const updateNodeConnectionPhase = useCallback(
    (network: string, next: NodeConnectionPhase) => {
      setNodeConnectionPhases(previous => {
        const current = previous[network];
        if (current === next) {
          return previous;
        }
        return { ...previous, [network]: next };
      });
    },
    [],
  );

  const queueIncomingTransactionNotices = useCallback(
    (notices: IncomingTransactionNotice[]) => {
      if (notices.length === 0) {
        return;
      }

      const queuedIds = new Set(
        incomingTransactionNoticeQueueRef.current.map(notice => notice.id),
      );
      if (incomingTransactionNoticeRef.current) {
        queuedIds.add(incomingTransactionNoticeRef.current.id);
      }

      const uniqueNotices = notices.filter(notice => !queuedIds.has(notice.id));
      if (uniqueNotices.length === 0) {
        return;
      }

      incomingTransactionNoticeQueueRef.current.push(...uniqueNotices);
      if (incomingTransactionNoticeRef.current) {
        return;
      }

      const next = incomingTransactionNoticeQueueRef.current.shift();
      incomingTransactionNoticeRef.current = next;
      setIncomingTransactionNotice(next);
      if (next) {
        logWalletEvent('WalletState', 'incomingNotice.shown', {
          direction: next.direction,
          pending: next.pending,
          walletId: next.walletId,
        });
      }
    },
    [],
  );

  const observeTransactionSample = useCallback(
    async (
      registration: RegisteredWallet,
      sample: { snapshot: WalletSnapshot; transactions: WalletTransaction[] },
    ) => {
      try {
        const notices = await incomingTransactionObserverRef.current.observe({
          walletId: registration.id,
          walletName: walletDisplayName(registration),
          transactions: sample.transactions,
          walletHeight: sample.snapshot.walletHeight,
          historicalScanComplete: sample.snapshot.synchronized,
        });
        queueIncomingTransactionNotices(notices);
      } catch (reason) {
        // Never display a notice unless its durable deduplication checkpoint
        // was stored successfully first.
        logWalletEvent('WalletState', 'transactionNotices.error', {
          error: errorMessage(reason),
          registrationId: registration.id,
        });
      }
    },
    [queueIncomingTransactionNotices],
  );

  const dismissIncomingTransactionNotice = useCallback(() => {
    const dismissed = incomingTransactionNoticeRef.current;
    const next = incomingTransactionNoticeQueueRef.current.shift();
    incomingTransactionNoticeRef.current = next;
    setIncomingTransactionNotice(next);
    if (dismissed) {
      logWalletEvent('WalletState', 'incomingNotice.dismissed', {
        direction: dismissed.direction,
        walletId: dismissed.walletId,
      });
    }
  }, []);

  const stopNativeRefresh = useCallback(
    (closingSession: WalletSession | undefined, reason: string) => {
      if (!closingSession) {
        return Promise.resolve();
      }

      const registrationId = sessionRegistrationId(closingSession);
      const deferredRefresh =
        deferredNativeRefreshTimeoutsRef.current.get(registrationId);
      if (deferredRefresh) {
        clearTimeout(deferredRefresh);
        deferredNativeRefreshTimeoutsRef.current.delete(registrationId);
      }
      const retryTimeout =
        nativeRefreshRetryTimeoutsRef.current.get(registrationId);
      if (retryTimeout) {
        clearTimeout(retryTimeout);
        nativeRefreshRetryTimeoutsRef.current.delete(registrationId);
      }
      nativeRefreshWalletIdsRef.current.delete(registrationId);
      nativeRefreshReadyWalletIdsRef.current.delete(registrationId);
      nativeRefreshRetryAttemptsRef.current.delete(registrationId);
      logWalletEvent('WalletState', 'stopNativeRefresh.start', {
        reason,
        registrationId,
        walletId: closingSession.walletId,
      });
      return walletService.stopRefresh(closingSession).catch(stopError => {
        logWalletEvent('WalletState', 'stopNativeRefresh.error', {
          error: errorMessage(stopError),
          reason,
          walletId: closingSession.walletId,
        });
      });
    },
    [],
  );

  const shouldSkipLiveWalletRead = useCallback(
    (activeSession: WalletSession, operation: string) => {
      const registrationId = sessionRegistrationId(activeSession);
      if (
        nativeRefreshWalletIdsRef.current.has(registrationId) &&
        !nativeRefreshReadyWalletIdsRef.current.has(registrationId)
      ) {
        logWalletEvent('WalletState', `${operation}.skipped`, {
          reason: 'nativeRefreshStarting',
          walletId: activeSession.walletId,
        });
        return true;
      }

      const registration = registeredWalletsRef.current.find(
        wallet => wallet.id === registrationId,
      );
      const networkStatus = registration
        ? networkSyncStatusesRef.current[registration.network]
        : undefined;
      if (
        networkStatus &&
        networkStatus.joinedWallets > 0 &&
        ['fetching-blocks', 'fanout', 'scanning'].includes(
          networkStatus.state,
        ) &&
        operation !== 'refreshTransactions'
      ) {
        // The process-wide native sync worker owns the Monero wallet while it
        // fans downloaded blocks into it. Snapshot reads in that window do
        // not contain a coherent balance yet. Transaction reads are the one
        // deliberate exception: the native session mutex waits for the
        // current bounded scan batch, then exposes newly discovered history.
        // This lets both incoming and outgoing notices appear during a long
        // restore instead of arriving together only after the final block.
        logWalletEvent('WalletState', `${operation}.skipped`, {
          network: registration?.network,
          reason: 'nativeNetworkSyncActive',
          walletId: activeSession.walletId,
        });
        return true;
      }

      return false;
    },
    [],
  );

  const hydrateCachedWalletState = useCallback(
    (
      active: RegisteredWallet | undefined,
      wallets: RegisteredWallet[],
      cachedSnapshots: WalletSnapshotCache,
    ) => {
      let seededPublication = false;
      for (const wallet of wallets) {
        const cachedSnapshot = cachedSnapshots[wallet.id];
        if (
          !cachedSnapshot ||
          walletStateSamplesByRegistrationRef.current.has(wallet.id)
        ) {
          continue;
        }
        walletStateSamplesByRegistrationRef.current.set(wallet.id, {
          snapshot: cachedSnapshot,
          transactions:
            transactionsByRegistrationRef.current.get(wallet.id) ?? [],
        });
        seededPublication = true;
      }

      const activeSnapshot = active ? cachedSnapshots[active.id] : undefined;
      setSnapshot(activeSnapshot);
      setTransactions(
        active
          ? transactionsByRegistrationRef.current.get(active.id) ?? []
          : [],
      );
      if (seededPublication) {
        // The encrypted app vault is already open. Publish the last durable
        // balance immediately while native wallet sessions reopen and replace
        // it with a fresh local snapshot.
        setPublicationTick(current => current + 1);
      }
    },
    [],
  );

  const reloadRegisteredWallet = useCallback(async () => {
    await walletService.recoverUnregisteredWallets();
    const [wallet, wallets, cachedSnapshots] = await Promise.all([
      walletService.loadRegisteredWallet(),
      walletService.loadRegisteredWallets(),
      loadWalletSnapshotCache(),
    ]);
    registeredWalletRef.current = wallet;
    registeredWalletsRef.current = wallets;
    setRegisteredWallet(wallet);
    setRegisteredWallets(wallets);
    setWalletSnapshots(cachedSnapshots);
    walletSnapshotsRef.current = cachedSnapshots;
    hydrateCachedWalletState(wallet, wallets, cachedSnapshots);
    setLoadingRegistry(false);
    return wallet;
  }, [hydrateCachedWalletState]);

  const reloadRegisteredWallets = useCallback(async () => {
    await walletService.recoverUnregisteredWallets();
    const [wallets, active, cachedSnapshots] = await Promise.all([
      walletService.loadRegisteredWallets(),
      walletService.loadRegisteredWallet(),
      loadWalletSnapshotCache(),
    ]);
    registeredWalletRef.current = active;
    registeredWalletsRef.current = wallets;
    setRegisteredWallets(wallets);
    setRegisteredWallet(active);
    setWalletSnapshots(cachedSnapshots);
    walletSnapshotsRef.current = cachedSnapshots;
    hydrateCachedWalletState(active, wallets, cachedSnapshots);
    setLoadingRegistry(false);
    return wallets;
  }, [hydrateCachedWalletState]);

  const activateRegisteredWallet = useCallback(async (walletId: string) => {
    const startedAt = Date.now();
    const selectionGeneration = activeWalletSelectionGenerationRef.current + 1;
    activeWalletSelectionGenerationRef.current = selectionGeneration;
    logWalletEvent('WalletState', 'activateRegisteredWallet.start', {
      walletId,
    });
    try {
      const optimisticWallet = registeredWalletsRef.current.find(
        candidate => candidate.id === walletId,
      );
      if (!optimisticWallet) {
        throw new Error('Selected wallet is missing from the local registry');
      }
      let openedSession = sessionsByRegistrationRef.current.get(walletId);

      // A warm JavaScript handle is only a hint. Validate it against the
      // native registry before committing the visible selection, otherwise a
      // closed native session can leave the wallet permanently stuck at "—".
      if (openedSession) {
        try {
          const validatedSnapshot = await walletService.snapshot(openedSession);
          walletSnapshotsRef.current = {
            ...walletSnapshotsRef.current,
            [walletId]: validatedSnapshot,
          };
          walletStateSamplesByRegistrationRef.current.set(walletId, {
            snapshot: validatedSnapshot,
            transactions:
              transactionsByRegistrationRef.current.get(walletId) ?? [],
          });
          setWalletSnapshots(walletSnapshotsRef.current);
          setPublicationTick(current => current + 1);
        } catch (reason) {
          if (!isWalletSessionStaleError(reason)) throw reason;
          openedSession = (
            await recoverStaleSessionRef.current?.(
              optimisticWallet,
              openedSession,
            )
          )?.session;
          if (!openedSession) {
            throw new Error('Wallet session recovery is unavailable');
          }
        }
      }

      // The visible switch is deliberately completed before protected metadata
      // is persisted.  A warm wallet therefore changes the active snapshot in
      // the same JavaScript turn and never waits for AsyncStorage, Keychain,
      // Keystore, a daemon handshake, or a native refresh.
      registeredWalletRef.current = optimisticWallet;
      setRegisteredWallet(optimisticWallet);
      sessionRef.current = openedSession;
      setSession(openedSession);
      if (openedSession) {
        walletService.activateSession(openedSession);
        walletService.prioritizeNetworkWallet(openedSession).catch(reason => {
          logWalletEvent(
            'WalletState',
            'activateRegisteredWallet.priorityError',
            {
              error: errorMessage(reason),
            },
          );
        });
      }
      setSnapshot(walletSnapshotsRef.current[walletId]);
      setTransactions(
        transactionsByRegistrationRef.current.get(walletId) ?? [],
      );
      setSyncStartHeight(syncStartHeightsRef.current.get(walletId));
      setHardwareStatus(undefined);
      setError(undefined);
      setLoadingRegistry(false);
      logWalletEvent('WalletState', 'activateRegisteredWallet.uiCommitted', {
        elapsedMs: Date.now() - startedAt,
        sessionOpen: Boolean(openedSession),
        walletId,
      });

      // Persist the new active registration after the visible selection has
      // changed. Wallet switching must never wait on AsyncStorage or a registry
      // reload. A generation check also prevents a slower earlier write from
      // replacing a newer user selection in React state.
      const persistSelection = activeWalletPersistenceRef.current
        .catch(() => undefined)
        .then(async () => {
          const wallet = await walletService.setActiveRegisteredWallet(
            walletId,
          );
          if (!wallet) {
            throw new Error(
              'Selected wallet is missing from the local registry',
            );
          }
          const wallets = await walletService.loadRegisteredWallets();
          if (
            activeWalletSelectionGenerationRef.current !==
              selectionGeneration ||
            registeredWalletRef.current?.id !== walletId
          ) {
            logWalletEvent(
              'WalletState',
              'activateRegisteredWallet.persistStale',
              {
                elapsedMs: Date.now() - startedAt,
                walletId,
              },
            );
            return;
          }
          registeredWalletRef.current = wallet;
          registeredWalletsRef.current = wallets;
          setRegisteredWallet(wallet);
          setRegisteredWallets(wallets);
          logWalletEvent('WalletState', 'activateRegisteredWallet.success', {
            elapsedMs: Date.now() - startedAt,
            sessionOpen: Boolean(openedSession),
            walletId,
          });
        });
      activeWalletPersistenceRef.current = persistSelection.then(
        () => undefined,
        () => undefined,
      );
      persistSelection.catch(reason => {
        logWalletEvent('WalletState', 'activateRegisteredWallet.persistError', {
          elapsedMs: Date.now() - startedAt,
          error: errorMessage(reason),
          walletId,
        });
        if (
          activeWalletSelectionGenerationRef.current === selectionGeneration &&
          registeredWalletRef.current?.id === walletId
        ) {
          setError(
            'The selected wallet is open, but its active state could not be saved.',
          );
        }
      });

      return optimisticWallet;
    } catch (reason) {
      logWalletEvent('WalletState', 'activateRegisteredWallet.error', {
        elapsedMs: Date.now() - startedAt,
        error: errorMessage(reason),
        walletId,
      });
      throw reason;
    }
  }, []);

  const removeRegisteredWallet = useCallback(
    async (walletId: string) => {
      const activeWalletBeforeRemovalId = registeredWalletRef.current?.id;
      const walletsBeforeRemoval = registeredWalletsRef.current;
      const wallets = await walletService.removeRegisteredWallet(walletId);
      const remainingWalletIds = new Set(wallets.map(wallet => wallet.id));
      const removedWalletIds = walletsBeforeRemoval
        .filter(wallet => !remainingWalletIds.has(wallet.id))
        .map(wallet => wallet.id);
      await incomingTransactionObserverRef.current
        .forgetMany(removedWalletIds)
        .catch(reason => {
          logWalletEvent('WalletState', 'transactionNotices.forgetError', {
            error: errorMessage(reason),
            removedWalletCount: removedWalletIds.length,
          });
        });
      const removingActiveWallet = activeWalletBeforeRemovalId
        ? removedWalletIds.includes(activeWalletBeforeRemovalId)
        : false;
      const [active, cachedSnapshots] = await Promise.all([
        walletService.loadRegisteredWallet(),
        pruneWalletSnapshotCache(wallets.map(wallet => wallet.id)),
      ]);

      const removedSessions = new Map<string, WalletSession>();
      for (const removedWalletId of removedWalletIds) {
        const removedSession =
          sessionsByRegistrationRef.current.get(removedWalletId);
        if (removedSession) {
          removedSessions.set(removedSession.walletId, removedSession);
        }
        sessionsByRegistrationRef.current.delete(removedWalletId);
        transactionsByRegistrationRef.current.delete(removedWalletId);
        walletStateSamplesByRegistrationRef.current.delete(removedWalletId);
        syncStartHeightsRef.current.delete(removedWalletId);
        ledgerInitialVerificationAttemptedRef.current.delete(removedWalletId);
        ledgerInitialVerificationNextAttemptAtRef.current.delete(
          removedWalletId,
        );
      }
      for (const removedSession of removedSessions.values()) {
        await stopNativeRefresh(removedSession, 'walletRemoved');
        await walletService.closeWallet(removedSession).catch(() => undefined);
      }

      registeredWalletRef.current = active;
      registeredWalletsRef.current = wallets;
      setRegisteredWallet(active);
      setRegisteredWallets(wallets);
      setWalletSnapshots(cachedSnapshots);
      walletSnapshotsRef.current = cachedSnapshots;
      if (removingActiveWallet) {
        const nextSession = active
          ? sessionsByRegistrationRef.current.get(active.id)
          : undefined;
        sessionRef.current = nextSession;
        setSession(nextSession);
        setSnapshot(active ? cachedSnapshots[active.id] : undefined);
        setTransactions(
          active
            ? transactionsByRegistrationRef.current.get(active.id) ?? []
            : [],
        );
        setSyncStartHeight(
          active ? syncStartHeightsRef.current.get(active.id) : undefined,
        );
        setHardwareStatus(undefined);
      }
      setError(undefined);
      setLoadingRegistry(false);
      return wallets;
    },
    [stopNativeRefresh],
  );

  const renameRegisteredWallet = useCallback(
    async (walletId: string, displayName: string) => {
      const updated = await walletService.renameRegisteredWallet(
        walletId,
        displayName,
      );
      if (!updated) {
        return undefined;
      }
      const wallets = await walletService.loadRegisteredWallets();
      const active = await walletService.loadRegisteredWallet();
      registeredWalletRef.current = active;
      registeredWalletsRef.current = wallets;
      setRegisteredWallet(active);
      setRegisteredWallets(wallets);
      return updated;
    },
    [],
  );

  const backupRegisteredWalletSeed = useCallback(
    async (walletId: string, reason: string): Promise<boolean> => {
      let registration = registeredWalletsRef.current.find(
        wallet => wallet.id === walletId,
      );
      if (!registration) {
        const wallets = await walletService.loadRegisteredWallets();
        registeredWalletsRef.current = wallets;
        setRegisteredWallets(wallets);
        registration = wallets.find(wallet => wallet.id === walletId);
      }
      if (!registration) {
        throw new Error('Wallet is missing from the local registry.');
      }
      if (registration.kind === 'hardware') {
        throw new Error(
          'A hardware wallet keeps its recovery words on the device.',
        );
      }

      let openedSession = sessionsByRegistrationRef.current.get(walletId);
      let temporarySession = false;
      if (!openedSession) {
        openedSession = await walletService.openRegisteredWalletRegistration(
          registration,
        );
        temporarySession = true;
      }

      try {
        const confirmed = await walletService.presentRecoverySeed(
          openedSession,
          reason,
        );
        if (!confirmed) {
          return false;
        }
        const updated = await walletService.markRegisteredWalletSeedBackedUp(
          walletId,
        );
        if (updated) {
          const wallets = registeredWalletsRef.current.map(wallet =>
            wallet.id === updated.id ? updated : wallet,
          );
          registeredWalletsRef.current = wallets;
          setRegisteredWallets(wallets);
          if (registeredWalletRef.current?.id === updated.id) {
            registeredWalletRef.current = updated;
            setRegisteredWallet(updated);
          }
        }
        return true;
      } finally {
        if (temporarySession) {
          await walletService.closeWallet(openedSession).catch(() => undefined);
        }
      }
    },
    [],
  );

  useEffect(() => {
    if (!appSecurityReady || appSecurityLocked) {
      return;
    }
    let mounted = true;
    const startedAt = Date.now();
    logWalletEvent('WalletState', 'registryLoad.start');
    Promise.all([
      walletService.loadRegisteredWallet(),
      walletService.loadRegisteredWallets(),
      loadWalletSnapshotCache(),
    ] as const)
      .then(([wallet, wallets, cachedSnapshots]) => {
        if (mounted) {
          registeredWalletRef.current = wallet;
          registeredWalletsRef.current = wallets;
          setRegisteredWallet(wallet);
          setRegisteredWallets(wallets);
          setWalletSnapshots(cachedSnapshots);
          walletSnapshotsRef.current = cachedSnapshots;
          hydrateCachedWalletState(wallet, wallets, cachedSnapshots);
          logWalletEvent('WalletState', 'registryLoad.success', {
            elapsedMs: Date.now() - startedAt,
            walletCount: wallets.length,
          });
          pruneWalletSnapshotCache(wallets.map(item => item.id))
            .then(pruned => {
              walletSnapshotsRef.current = pruned;
              setWalletSnapshots(pruned);
            })
            .catch(() => undefined);
        }
      })
      .catch(reason => {
        if (mounted) {
          const message = errorMessage(reason);
          setError(message);
          logWalletEvent('WalletState', 'registryLoad.error', {
            elapsedMs: Date.now() - startedAt,
            error: message,
          });
        }
      })
      .finally(() => {
        if (mounted) {
          setLoadingRegistry(false);
        }
      });

    return () => {
      mounted = false;
    };
  }, [appSecurityLocked, appSecurityReady, hydrateCachedWalletState]);

  useEffect(() => {
    if (!appSecurityReady || !appSecurityLocked) {
      return;
    }

    // Native lock/background paths close every WalletEngine session and wipe
    // the AppVault session.  Discard the corresponding JavaScript handles in
    // one place so an unlock can never reuse a closed native wallet id.
    globallyLockedRef.current = true;
    for (const timeout of deferredNativeRefreshTimeoutsRef.current.values()) {
      clearTimeout(timeout);
    }
    deferredNativeRefreshTimeoutsRef.current.clear();
    for (const timeout of nativeRefreshRetryTimeoutsRef.current.values()) {
      clearTimeout(timeout);
    }
    nativeRefreshRetryTimeoutsRef.current.clear();
    sessionsByRegistrationRef.current.clear();
    walletOpenInFlightRef.current.clear();
    nativeRefreshWalletIdsRef.current.clear();
    nativeRefreshReadyWalletIdsRef.current.clear();
    nativeRefreshRetryAttemptsRef.current.clear();
    ledgerInitialVerificationAttemptedRef.current.clear();
    ledgerInitialVerificationNextAttemptAtRef.current.clear();
    sessionRef.current = undefined;
    setSession(undefined);
    setHardwareStatus(undefined);
    walletService.clearSessionReferencesAfterAppLock();
    logWalletEvent('WalletState', 'appLock.sessionRegistryCleared');
  }, [appSecurityLocked, appSecurityReady]);

  useEffect(() => {
    if (
      !appSecurityReady ||
      appSecurityLocked ||
      fastWalletMigrationCompletedRef.current ||
      fastWalletMigrationInFlightRef.current
    ) {
      return;
    }

    fastWalletMigrationInFlightRef.current = true;
    const startedAt = Date.now();
    logWalletEvent('WalletState', 'fastWalletMigration.start');
    walletService
      .loadFastReceiveIdentities()
      .then(identities => {
        fastWalletMigrationCompletedRef.current = true;
        logWalletEvent('WalletState', 'fastWalletMigration.success', {
          count: identities.length,
          elapsedMs: Date.now() - startedAt,
        });
      })
      .catch(reason => {
        logWalletEvent('WalletState', 'fastWalletMigration.error', {
          elapsedMs: Date.now() - startedAt,
          error: errorMessage(reason),
        });
      })
      .finally(() => {
        fastWalletMigrationInFlightRef.current = false;
      });
  }, [appSecurityLocked, appSecurityReady]);

  const refreshSessionSnapshot = useCallback(
    async (
      registration: RegisteredWallet,
      openedSession: WalletSession,
    ): Promise<WalletSnapshot | undefined> => {
      if (shouldSkipLiveWalletRead(openedSession, 'refreshSnapshot')) {
        return walletSnapshotsRef.current[registration.id];
      }
      if (snapshotRefreshInFlightIdsRef.current.has(registration.id)) {
        return walletSnapshotsRef.current[registration.id];
      }

      snapshotRefreshInFlightIdsRef.current.add(registration.id);
      try {
        const nextSnapshot = await walletService.snapshot(openedSession);
        if (!syncStartHeightsRef.current.has(registration.id)) {
          const startHeight = syncStartHeightForWallet(
            registration.restoreHeight,
            nextSnapshot.walletHeight,
          );
          if (startHeight !== undefined) {
            // An import/Ledger scan starts exactly where the owner selected.
            // A new wallet has no chosen height, so only its first live Core
            // snapshot may establish the presentation baseline.
            syncStartHeightsRef.current.set(registration.id, startHeight);
          }
        }
        const nextCache = {
          ...walletSnapshotsRef.current,
          [registration.id]: nextSnapshot,
        };
        walletSnapshotsRef.current = nextCache;
        setWalletSnapshots(nextCache);
        if (registeredWalletRef.current?.id === registration.id) {
          setSnapshot(nextSnapshot);
          setSyncStartHeight(syncStartHeightsRef.current.get(registration.id));
          setError(undefined);
        }
        saveWalletSnapshot(registration.id, nextSnapshot).catch(reason => {
          logWalletEvent('WalletState', 'refreshSnapshot.cacheError', {
            error: errorMessage(reason),
            walletId: registration.id,
          });
        });
        logWalletEvent('WalletState', 'refreshSnapshot.success', {
          daemonHeight: nextSnapshot.daemonHeight,
          synchronized: nextSnapshot.synchronized,
          syncStartHeight: syncStartHeightsRef.current.get(registration.id),
          walletHeight: nextSnapshot.walletHeight,
          registrationId: registration.id,
        });
        return nextSnapshot;
      } catch (reason) {
        if (isWalletSessionStaleError(reason)) {
          await recoverStaleSessionRef.current?.(registration, openedSession);
          return walletSnapshotsRef.current[registration.id];
        }
        // Snapshot polling reads the last sanitized native cache. A delayed
        // read must never masquerade as a node outage or replace a valid
        // cached wallet state with a red global error. Keep rendering the
        // prior snapshot and leave connection health to networkSyncStatus().
        logWalletEvent('WalletState', 'refreshSnapshot.error', {
          cacheRetained: Boolean(walletSnapshotsRef.current[registration.id]),
          error: errorMessage(reason),
          registrationId: registration.id,
        });
        return undefined;
      } finally {
        snapshotRefreshInFlightIdsRef.current.delete(registration.id);
      }
    },
    [shouldSkipLiveWalletRead],
  );

  const mergeTransactionsWithPending = useCallback(
    async (
      registrationId: string,
      authoritativeTransactions: WalletTransaction[],
    ): Promise<WalletTransaction[]> => {
      let storedPending: WalletTransaction[] = [];
      try {
        storedPending = await loadPendingOutgoingTransactions(registrationId);
      } catch (reason) {
        logWalletEvent('WalletState', 'pendingOutgoing.loadError', {
          error: errorMessage(reason),
          registrationId,
        });
      }
      const merged = mergePendingOutgoingTransactions(
        authoritativeTransactions,
        [
          ...storedPending,
          ...(pendingOutgoingByRegistrationRef.current.get(registrationId) ??
            []),
        ],
      );
      pendingOutgoingByRegistrationRef.current.set(
        registrationId,
        merged.pending,
      );
      replacePendingOutgoingTransactions(registrationId, merged.pending).catch(
        reason => {
          logWalletEvent('WalletState', 'pendingOutgoing.storeError', {
            error: errorMessage(reason),
            registrationId,
          });
        },
      );
      return merged.transactions;
    },
    [],
  );

  const refreshSessionTransactions = useCallback(
    async (
      registration: RegisteredWallet,
      openedSession: WalletSession,
    ): Promise<WalletTransaction[]> => {
      const cached =
        transactionsByRegistrationRef.current.get(registration.id) ?? [];
      if (shouldSkipLiveWalletRead(openedSession, 'refreshTransactions')) {
        return cached;
      }
      if (transactionRefreshInFlightIdsRef.current.has(registration.id)) {
        return cached;
      }

      transactionRefreshInFlightIdsRef.current.add(registration.id);
      try {
        // A normal Ledger/software registration represents the complete
        // Monero wallet container, exactly like the CLI reference. The old
        // account-scoped feed belonged to the retired "Ledger account 1 is a
        // Fast Wallet" model and hid valid account-1 history from the owner.
        // Keep scoping only for a legacy explicit Ledger-Fast child record.
        const authoritativeTransactions =
          registration.kind === 'hardware' && registration.role === 'fast'
            ? await walletService.getTransactions(openedSession, 0)
            : await walletService.getTransactionsForAllAccounts(
                openedSession,
                0,
              );
        const nextTransactions = await mergeTransactionsWithPending(
          registration.id,
          authoritativeTransactions,
        );
        transactionsByRegistrationRef.current.set(
          registration.id,
          nextTransactions,
        );
        setPublicationTick(current => current + 1);
        if (registeredWalletRef.current?.id === registration.id) {
          setTransactions(nextTransactions);
        }
        return nextTransactions;
      } catch (reason) {
        if (isWalletSessionStaleError(reason)) {
          await recoverStaleSessionRef.current?.(registration, openedSession);
          return cached;
        }
        logWalletEvent('WalletState', 'refreshTransactions.error', {
          error: errorMessage(reason),
          registrationId: registration.id,
        });
        return cached;
      } finally {
        transactionRefreshInFlightIdsRef.current.delete(registration.id);
      }
    },
    [mergeTransactionsWithPending, shouldSkipLiveWalletRead],
  );

  const refreshSessionState = useCallback(
    async (
      registration: RegisteredWallet,
      openedSession: WalletSession,
    ): Promise<
      | { snapshot: WalletSnapshot; transactions: WalletTransaction[] }
      | undefined
    > => {
      const beforeHistory = await refreshSessionSnapshot(
        registration,
        openedSession,
      );
      if (!beforeHistory) return undefined;
      const nextTransactions = await refreshSessionTransactions(
        registration,
        openedSession,
      );
      const afterHistory = await refreshSessionSnapshot(
        registration,
        openedSession,
      );
      if (
        !afterHistory ||
        snapshotPublicationToken(beforeHistory) !==
          snapshotPublicationToken(afterHistory)
      ) {
        return undefined;
      }
      const sample = {
        snapshot: afterHistory,
        transactions: nextTransactions,
      };
      walletStateSamplesByRegistrationRef.current.set(registration.id, sample);
      setPublicationTick(current => current + 1);
      await observeTransactionSample(registration, sample);
      return sample;
    },
    [
      observeTransactionSample,
      refreshSessionSnapshot,
      refreshSessionTransactions,
    ],
  );

  const refreshSnapshot = useCallback(async () => {
    const activeRegistration = registeredWalletRef.current;
    const activeSession = sessionRef.current;
    if (!activeRegistration || !activeSession) {
      return undefined;
    }
    return (await refreshSessionState(activeRegistration, activeSession))
      ?.snapshot;
  }, [refreshSessionState]);

  const refreshTransactions = useCallback(async () => {
    const activeRegistration = registeredWalletRef.current;
    const activeSession = sessionRef.current;
    if (!activeRegistration || !activeSession) {
      setTransactions([]);
      return [];
    }
    return (
      (await refreshSessionState(activeRegistration, activeSession))
        ?.transactions ??
      transactionsByRegistrationRef.current.get(activeRegistration.id) ??
      []
    );
  }, [refreshSessionState]);

  const publishPendingOutgoing = useCallback(
    (transaction: WalletTransaction) => {
      const registration = registeredWalletRef.current;
      if (!registration || transaction.direction !== 'out') return;

      const pending = mergePendingOutgoingTransactions(
        [],
        [
          transaction,
          ...(pendingOutgoingByRegistrationRef.current.get(registration.id) ??
            []),
        ],
      ).pending;
      pendingOutgoingByRegistrationRef.current.set(registration.id, pending);

      const current =
        transactionsByRegistrationRef.current.get(registration.id) ?? [];
      const nextTransactions = [
        transaction,
        ...current.filter(
          existing =>
            existing.hash.toLowerCase() !== transaction.hash.toLowerCase(),
        ),
      ].sort((left, right) => right.timestamp - left.timestamp);
      transactionsByRegistrationRef.current.set(
        registration.id,
        nextTransactions,
      );
      const currentSnapshot = walletSnapshotsRef.current[registration.id];
      if (currentSnapshot) {
        walletStateSamplesByRegistrationRef.current.set(registration.id, {
          snapshot: currentSnapshot,
          transactions: nextTransactions,
        });
      }
      setPublicationTick(currentTick => currentTick + 1);
      if (registeredWalletRef.current?.id === registration.id) {
        setTransactions(nextTransactions);
      }

      recordPendingOutgoingTransaction(registration.id, transaction).catch(
        reason => {
          logWalletEvent('WalletState', 'pendingOutgoing.storeError', {
            error: errorMessage(reason),
            registrationId: registration.id,
          });
        },
      );
    },
    [],
  );

  const refreshFastWalletsFromIncomingSignal = useCallback(
    async (event: FastWalletPushEvent) => {
      // A push signal deliberately carries no payment details. Its local
      // validation, however, opens the encrypted Fast Wallet container. Do
      // that only after the single app-wide lock has been opened. Retaining
      // the event lets the effect replay it immediately after unlock rather
      // than producing a misleading "Connecting node" state or an
      // app-locked native error at launch.
      if (!appSecurityReady || appSecurityLocked) {
        logWalletEvent('WalletState', 'incomingSignal.refresh.deferred', {
          reason: !appSecurityReady ? 'appSecurityNotReady' : 'appLocked',
        });
        return;
      }
      if (processedPushEventIdRef.current === event.eventId) {
        return;
      }
      processedPushEventIdRef.current = event.eventId;
      logWalletEvent('WalletState', 'incomingSignal.refresh.start');
      try {
        const refreshed =
          await walletService.refreshFastWalletsFromIncomingSignal();
        for (const result of refreshed) {
          if (result.snapshot) {
            const nextCache = {
              ...walletSnapshotsRef.current,
              [result.registrationId]: result.snapshot,
            };
            walletSnapshotsRef.current = nextCache;
            setWalletSnapshots(nextCache);
            await saveWalletSnapshot(
              result.registrationId,
              result.snapshot,
            ).catch(() => undefined);
          }
          transactionsByRegistrationRef.current.set(
            result.registrationId,
            result.transactions,
          );
          if (result.snapshot) {
            walletStateSamplesByRegistrationRef.current.set(
              result.registrationId,
              {
                snapshot: result.snapshot,
                transactions: result.transactions,
              },
            );
          }
          setPublicationTick(current => current + 1);
        }

        const activeRegistration = registeredWalletRef.current;
        const activeResult = refreshed.find(
          result => result.registrationId === activeRegistration?.id,
        );
        if (activeResult?.snapshot) {
          setSnapshot(activeResult.snapshot);
          setTransactions(activeResult.transactions);
        }
        await walletService
          .loadFastReceiveIdentitiesForActiveNode()
          .catch(() => undefined);
        setError(undefined);
        logWalletEvent('WalletState', 'incomingSignal.refresh.success', {
          refreshedWalletCount: refreshed.length,
        });
      } catch (reason) {
        logWalletEvent('WalletState', 'incomingSignal.refresh.error', {
          error: errorMessage(reason),
        });
      }
    },
    [appSecurityLocked, appSecurityReady],
  );

  useEffect(() => {
    let mounted = true;
    const handle = (event: FastWalletPushEvent) => {
      if (mounted) {
        refreshFastWalletsFromIncomingSignal(event).catch(() => undefined);
      }
    };
    const unsubscribe = FastWalletPushService.subscribe(handle);
    FastWalletPushService.getLastEvent()
      .then(event => {
        if (event) {
          handle(event);
        }
      })
      .catch(() => undefined);

    return () => {
      mounted = false;
      unsubscribe();
    };
  }, [refreshFastWalletsFromIncomingSignal]);

  const refreshHardwareWalletStatus = useCallback(async () => {
    const activeSession = sessionRef.current;
    if (!activeSession?.hardwareDevice) {
      hardwareStatusRef.current = undefined;
      setHardwareStatus(undefined);
      return undefined;
    }
    if (hardwareRefreshInFlight.current) {
      logWalletEvent('WalletState', 'refreshHardwareWalletStatus.skipped', {
        reason: 'inFlight',
        walletId: activeSession.walletId,
      });
      return hardwareStatusRef.current;
    }

    hardwareRefreshInFlight.current = true;
    try {
      const nextStatus = await walletService.getHardwareWalletStatus(
        activeSession,
      );
      hardwareStatusRef.current = nextStatus;
      setHardwareStatus(nextStatus);
      setError(undefined);
      return nextStatus;
    } catch (reason) {
      setError(errorMessage(reason));
      return undefined;
    } finally {
      hardwareRefreshInFlight.current = false;
    }
  }, []);

  const startNativeRefresh = useCallback(
    (openedSession: WalletSession, reason: string) => {
      const registrationId = sessionRegistrationId(openedSession);
      const registration = registeredWalletsRef.current.find(
        wallet => wallet.id === registrationId,
      );
      if (!registration) {
        logWalletEvent('WalletState', 'startNativeRefresh.skipped', {
          reason: 'missingRegistration',
          walletId: openedSession.walletId,
        });
        return;
      }

      // Fast Wallets are independent, recoverable local wallets. A generic
      // wake signal is only a hint; it never replaces their local chain
      // verification. They therefore join the app-wide sync lifecycle just
      // like every normal wallet after the one app-wide unlock. The native
      // Core's bounded shared public-range cache can serve common data; the
      // per-wallet guard below makes selecting a Fast Wallet a pure UI
      // operation.

      if (nativeRefreshWalletIdsRef.current.has(registrationId)) {
        logWalletEvent('WalletState', 'startNativeRefresh.skipped', {
          reason: 'alreadyStarted',
          registrationId,
        });
        return;
      }

      const retryTimeout =
        nativeRefreshRetryTimeoutsRef.current.get(registrationId);
      if (retryTimeout) {
        clearTimeout(retryTimeout);
        nativeRefreshRetryTimeoutsRef.current.delete(registrationId);
      }
      nativeRefreshWalletIdsRef.current.add(registrationId);
      nativeRefreshReadyWalletIdsRef.current.delete(registrationId);
      // A new native refresh is a new measurement window, but an imported
      // wallet's configured restore height is already an authoritative
      // baseline. Keep it available while the native coordinator owns the
      // wallet: live snapshot polling is deliberately paused during that
      // interval and would otherwise leave the visible scan percentage
      // indeterminate until synchronization had already completed.
      const configuredSyncStartHeight = syncStartHeightForWallet(
        registration.restoreHeight,
      );
      if (configuredSyncStartHeight === undefined) {
        syncStartHeightsRef.current.delete(registrationId);
      } else {
        syncStartHeightsRef.current.set(
          registrationId,
          configuredSyncStartHeight,
        );
      }
      if (registeredWalletRef.current?.id === registrationId) {
        setSyncStartHeight(configuredSyncStartHeight);
      }
      logWalletEvent('WalletState', 'startNativeRefresh.start', {
        configuredSyncStartHeight,
        reason,
        registrationId,
      });

      updateNodeConnection(registration.network, 'connecting');

      walletService
        .startRefresh(openedSession, phase => {
          updateNodeConnectionPhase(registration.network, phase);
        })
        .then(() => {
          if (
            sessionsByRegistrationRef.current.get(registrationId) !==
            openedSession
          ) {
            logWalletEvent('WalletState', 'startNativeRefresh.stale', {
              reason,
              registrationId,
            });
            return;
          }

          nativeRefreshRetryAttemptsRef.current.delete(registrationId);
          nativeRefreshReadyWalletIdsRef.current.add(registrationId);
          // Joining is not the same as a completed network handshake. The
          // native coordinator poll is the sole authority for "connected".
          updateNodeConnection(registration.network, 'connecting');
          if (registeredWalletRef.current?.id === registrationId) {
            setError(undefined);
          }
          logWalletEvent('WalletState', 'startNativeRefresh.success', {
            reason,
            registrationId,
          });
          refreshSessionState(registration, openedSession).catch(
            refreshError => {
              logWalletEvent('WalletState', 'startNativeRefresh.stateError', {
                error: errorMessage(refreshError),
                registrationId,
              });
            },
          );
          if (
            registeredWalletRef.current?.id === registrationId &&
            openedSession.hardwareDevice
          ) {
            refreshHardwareWalletStatus().catch(refreshError => {
              logWalletEvent(
                'WalletState',
                'startNativeRefresh.hardwareError',
                {
                  error: errorMessage(refreshError),
                  registrationId,
                },
              );
            });
          }
        })
        .catch(reasonError => {
          if (
            sessionsByRegistrationRef.current.get(registrationId) !==
            openedSession
          ) {
            return;
          }

          nativeRefreshReadyWalletIdsRef.current.delete(registrationId);
          nativeRefreshWalletIdsRef.current.delete(registrationId);
          updateNodeConnection(registration.network, 'error');
          if (registeredWalletRef.current?.id === registrationId) {
            setError(errorMessage(reasonError));
          }
          const retryAttempt =
            (nativeRefreshRetryAttemptsRef.current.get(registrationId) ?? 0) +
            1;
          nativeRefreshRetryAttemptsRef.current.set(
            registrationId,
            retryAttempt,
          );
          const retryDelayMs = Math.min(
            30_000,
            5_000 * 2 ** Math.min(retryAttempt - 1, 3),
          );
          logWalletEvent('WalletState', 'startNativeRefresh.error', {
            error: errorMessage(reasonError),
            reason,
            registrationId,
          });
          logWalletEvent('WalletState', 'startNativeRefresh.retryScheduled', {
            previousError: errorMessage(reasonError),
            retryAttempt,
            retryDelayMs,
            registrationId,
          });
          const timeout = setTimeout(() => {
            nativeRefreshRetryTimeoutsRef.current.delete(registrationId);
            if (
              globallyLockedRef.current ||
              sessionsByRegistrationRef.current.get(registrationId) !==
                openedSession
            ) {
              logWalletEvent('WalletState', 'startNativeRefresh.retrySkipped', {
                reason: 'sessionChangedOrLocked',
                registrationId,
              });
              return;
            }

            startNativeRefresh(openedSession, 'retryAfterError');
          }, retryDelayMs);
          nativeRefreshRetryTimeoutsRef.current.set(registrationId, timeout);
        });
    },
    [
      refreshHardwareWalletStatus,
      refreshSessionState,
      updateNodeConnection,
      updateNodeConnectionPhase,
    ],
  );

  useEffect(() => {
    const subscription = AppState.addEventListener('change', nextState => {
      if (nextState === 'background') {
        if (activeSystemUiInterruptionDeadlineMs()) {
          logWalletEvent(
            'WalletState',
            'appBackground.persistWallets.deferred',
            {
              reason: 'trusted-system-ui',
            },
          );
          return;
        }

        // A normal app switch is not a security reset. Keep the AppVault and
        // already-open native sessions warm until the configured inactivity
        // deadline; the native layer independently enforces that deadline and
        // locks immediately if the device itself is locked. This is what makes
        // returning to the app and switching wallets instantaneous.
        logWalletEvent(
          'WalletState',
          'appBackground.sessionRetainedUntilTimeout',
          {
            walletCount: sessionsByRegistrationRef.current.size,
          },
        );
        return;
      }
    });
    return () => subscription.remove();
  }, []);

  const reconnectHardwareWallet = useCallback(async () => {
    const activeSession = sessionRef.current;
    if (!activeSession?.hardwareDevice) {
      setHardwareStatus(undefined);
      return undefined;
    }

    try {
      const nextStatus = await walletService.reconnectHardwareWallet(
        activeSession,
      );
      setHardwareStatus(nextStatus);
      setError(undefined);
      return nextStatus;
    } catch (reason) {
      setError(errorMessage(reason));
      return undefined;
    }
  }, []);

  useEffect(
    () => () => {
      for (const timeout of deferredNativeRefreshTimeoutsRef.current.values()) {
        clearTimeout(timeout);
      }
      deferredNativeRefreshTimeoutsRef.current.clear();
      for (const timeout of nativeRefreshRetryTimeoutsRef.current.values()) {
        clearTimeout(timeout);
      }
      nativeRefreshRetryTimeoutsRef.current.clear();
      const walletCount = sessionsByRegistrationRef.current.size;
      // AppSecurity deliberately unmounts this provider as soon as the app is
      // locked. Native lockApp() is the single owner of stop -> persist ->
      // close ordering. Starting another asynchronous close here can arrive
      // after biometric unlock and close the freshly reopened wallet.
      globallyLockedRef.current = true;
      sessionsByRegistrationRef.current.clear();
      walletOpenInFlightRef.current.clear();
      walletService.clearSessionReferencesAfterAppLock();
      logWalletEvent('WalletState', 'unmount.nativeLockOwnsPersistence', {
        walletCount,
      });
    },
    [],
  );

  const showHardwareWalletAddress = useCallback(
    async (accountIndex = 0, addressIndex = 0, paymentId = '') => {
      const activeSession = sessionRef.current;
      if (!activeSession?.hardwareDevice) {
        setHardwareStatus(undefined);
        return undefined;
      }

      try {
        const nextStatus = await walletService.showHardwareWalletAddress(
          activeSession,
          accountIndex,
          addressIndex,
          paymentId,
        );
        setHardwareStatus(nextStatus);
        setError(undefined);
        return nextStatus;
      } catch (reason) {
        setError(errorMessage(reason));
        return undefined;
      }
    },
    [],
  );

  const registerOpenedSession = useCallback(
    async (
      openedSession: WalletSession,
      registration?: RegisteredWallet,
      options?: RegisterOpenedSessionOptions,
    ) => {
      const registrationId = sessionRegistrationId(openedSession);
      let openedRegistration =
        registration ??
        registeredWalletsRef.current.find(
          wallet => wallet.id === registrationId,
        );

      if (!openedRegistration) {
        const wallets = await walletService.loadRegisteredWallets();
        registeredWalletsRef.current = wallets;
        setRegisteredWallets(wallets);
        openedRegistration = wallets.find(
          wallet => wallet.id === registrationId,
        );
      }
      if (!openedRegistration) {
        throw new Error('Opened wallet is missing from the local registry');
      }
      const previousSession = sessionsByRegistrationRef.current.get(
        openedRegistration.id,
      );
      if (
        previousSession &&
        previousSession.walletId !== openedSession.walletId
      ) {
        await stopNativeRefresh(previousSession, 'registrationReopened');
        await walletService.closeWallet(previousSession).catch(() => undefined);
      }

      const registeredSession = {
        ...openedSession,
        registrationId: openedRegistration.id,
      };
      sessionsByRegistrationRef.current.set(
        openedRegistration.id,
        registeredSession,
      );
      globallyLockedRef.current = false;

      const wallets = registeredWalletsRef.current.some(
        wallet => wallet.id === openedRegistration?.id,
      )
        ? registeredWalletsRef.current.map(wallet =>
            wallet.id === openedRegistration?.id ? openedRegistration! : wallet,
          )
        : [...registeredWalletsRef.current, openedRegistration];
      registeredWalletsRef.current = wallets;
      setRegisteredWallets(wallets);

      const shouldSelect =
        options?.select ??
        Boolean(
          registration ||
            !registeredWalletRef.current ||
            registeredWalletRef.current.id === openedRegistration.id,
        );
      if (shouldSelect) {
        walletService.activateSession(registeredSession);
        registeredWalletRef.current = openedRegistration;
        sessionRef.current = registeredSession;
        setRegisteredWallet(openedRegistration);
        setSession(registeredSession);
        setSnapshot(walletSnapshotsRef.current[openedRegistration.id]);
        setTransactions(
          transactionsByRegistrationRef.current.get(openedRegistration.id) ??
            [],
        );
        setSyncStartHeight(
          syncStartHeightsRef.current.get(openedRegistration.id),
        );
        setHardwareStatus(undefined);
      } else if (sessionRef.current) {
        // Opening a background session touches WalletService's compatibility
        // pointer. Restore the visible session immediately; the actual native
        // WalletSessionRegistry keeps both wallet handles alive.
        walletService.activateSession(sessionRef.current);
      }
      setError(undefined);
      setLoadingRegistry(false);

      // Local wallet opening is fast, but Monero's daemon initialization can
      // take tens of seconds. Calling the TurboModule refresh in this stack
      // blocks navigation and touch handling until native setDaemon returns.
      // Let the open promise and its UI update finish before network startup.
      const previousDeferredRefresh =
        deferredNativeRefreshTimeoutsRef.current.get(openedRegistration.id);
      if (previousDeferredRefresh) {
        clearTimeout(previousDeferredRefresh);
      }
      if (options?.startNetwork !== false) {
        const deferredRefresh = setTimeout(() => {
          deferredNativeRefreshTimeoutsRef.current.delete(
            openedRegistration.id,
          );
          if (
            globallyLockedRef.current ||
            sessionsByRegistrationRef.current.get(openedRegistration.id) !==
              registeredSession
          ) {
            logWalletEvent(
              'WalletState',
              'startNativeRefresh.deferredSkipped',
              {
                reason: globallyLockedRef.current ? 'globallyLocked' : 'stale',
              },
            );
            return;
          }
          startNativeRefresh(registeredSession, 'sessionOpenedDeferred');
        }, 0);
        deferredNativeRefreshTimeoutsRef.current.set(
          openedRegistration.id,
          deferredRefresh,
        );
      }

      if (options?.refresh === false) {
        return;
      }

      await refreshSessionState(openedRegistration, registeredSession);
      if (shouldSelect && registeredSession.hardwareDevice) {
        await refreshHardwareWalletStatus();
      }
    },
    [
      refreshHardwareWalletStatus,
      refreshSessionState,
      startNativeRefresh,
      stopNativeRefresh,
    ],
  );

  const recoverStaleSession = useCallback<RecoverStaleSession>(
    async (registration, staleSession) => {
      setSessionRecovering(true);
      logWalletEvent('WalletState', 'recoverSession.start', {
        cacheRetained: Boolean(walletSnapshotsRef.current[registration.id]),
      });
      try {
        const recovered =
          await walletService.recoverRegisteredWalletRegistration(
            registration,
            staleSession,
          );
        for (const registrationId of recovered.invalidatedRegistrationIds) {
          sessionGenerationsByRegistrationRef.current.set(
            registrationId,
            recovered.sessionGeneration,
          );
          const mapped = sessionsByRegistrationRef.current.get(registrationId);
          if (!mapped || mapped.walletId === staleSession.walletId) {
            sessionsByRegistrationRef.current.delete(registrationId);
          }
          walletOpenInFlightRef.current.delete(registrationId);
          nativeRefreshWalletIdsRef.current.delete(registrationId);
          nativeRefreshReadyWalletIdsRef.current.delete(registrationId);
          nativeRefreshRetryAttemptsRef.current.delete(registrationId);
          snapshotRefreshInFlightIdsRef.current.delete(registrationId);
          transactionRefreshInFlightIdsRef.current.delete(registrationId);
          const retry =
            nativeRefreshRetryTimeoutsRef.current.get(registrationId);
          if (retry) clearTimeout(retry);
          nativeRefreshRetryTimeoutsRef.current.delete(registrationId);
          const deferred =
            deferredNativeRefreshTimeoutsRef.current.get(registrationId);
          if (deferred) clearTimeout(deferred);
          deferredNativeRefreshTimeoutsRef.current.delete(registrationId);
        }

        const registeredSession = {
          ...recovered.session,
          registrationId: registration.id,
        };
        sessionsByRegistrationRef.current.set(
          registration.id,
          registeredSession,
        );
        sessionGenerationsByRegistrationRef.current.set(
          registration.id,
          recovered.sessionGeneration,
        );
        setPublicationTick(value => value + 1);
        if (registeredWalletRef.current?.id === registration.id) {
          walletService.activateSession(registeredSession);
          sessionRef.current = registeredSession;
          setSession(registeredSession);
          setError(undefined);
        }
        startNativeRefresh(registeredSession, 'sessionRecovered');
        logWalletEvent('WalletState', 'recoverSession.success', {
          cacheRetained: Boolean(walletSnapshotsRef.current[registration.id]),
          ownerCount: recovered.invalidatedRegistrationIds.length,
          reopenAttempt: recovered.reopenAttempt,
          sessionGeneration: recovered.sessionGeneration,
        });
        return { ...recovered, session: registeredSession };
      } catch (reason) {
        logWalletEvent('WalletState', 'recoverSession.error', {
          error: reason,
        });
        throw reason;
      } finally {
        setSessionRecovering(false);
      }
    },
    [startNativeRefresh],
  );
  recoverStaleSessionRef.current = recoverStaleSession;

  const ensureRegisteredWalletOpen = useCallback(
    async (
      registration: RegisteredWallet,
      selectAfterOpen: boolean,
      startNetwork = true,
    ): Promise<boolean> => {
      const existingSession = sessionsByRegistrationRef.current.get(
        registration.id,
      );
      if (existingSession) {
        if (
          selectAfterOpen &&
          registeredWalletRef.current?.id === registration.id
        ) {
          await activateRegisteredWallet(registration.id);
          startNativeRefresh(existingSession, 'warmWalletSelected');
        }
        return true;
      }

      const canOpenWithoutPrompt =
        canOpenRegisteredWalletAutomatically(registration);
      if (!canOpenWithoutPrompt) {
        return false;
      }

      let opening = walletOpenInFlightRef.current.get(registration.id);
      if (!opening) {
        opening = walletService
          .openRegisteredWalletRegistration(registration)
          .then(async openedSession => {
            await registerOpenedSession(openedSession, registration, {
              refresh: false,
              select: false,
              startNetwork,
            });
            return openedSession;
          });
        walletOpenInFlightRef.current.set(registration.id, opening);
        const clearOpening = () => {
          if (walletOpenInFlightRef.current.get(registration.id) === opening) {
            walletOpenInFlightRef.current.delete(registration.id);
          }
        };
        opening.then(clearOpening, clearOpening);
      }

      await opening;
      if (
        selectAfterOpen &&
        registeredWalletRef.current?.id === registration.id
      ) {
        await activateRegisteredWallet(registration.id);
        if (!startNetwork) {
          startNativeRefresh(
            sessionsByRegistrationRef.current.get(registration.id)!,
            'walletSelectedAfterWarmOpen',
          );
        }
      }
      return true;
    },
    [activateRegisteredWallet, registerOpenedSession, startNativeRefresh],
  );

  const automaticWalletOpenKey = useMemo(
    () =>
      registeredWallets
        .map(
          wallet =>
            `${wallet.id}:${wallet.kind}:${Boolean(
              wallet.credentialKey,
            )}:${Boolean(wallet.viewOnlyPath)}:${Boolean(
              wallet.viewOnlyCredentialKey,
            )}`,
        )
        .join('|'),
    [registeredWallets],
  );

  useEffect(() => {
    if (
      !appSecurityReady ||
      appSecurityLocked ||
      automaticWalletOpenKey.length === 0
    ) {
      return;
    }

    let cancelled = false;
    const retryWaits = new Map<
      ReturnType<typeof setTimeout>,
      () => void
    >();

    const waitForRetry = (delayMs: number) =>
      new Promise<void>(resolve => {
        const timer = setTimeout(() => {
          retryWaits.delete(timer);
          resolve();
        }, delayMs);
        retryWaits.set(timer, resolve);
      });

    const warmAllWallets = async () => {
      let retryRound = 0;
      while (!cancelled) {
        const activeId = registeredWalletRef.current?.id;
        const unopened = registeredWalletsRef.current
          .filter(canOpenRegisteredWalletAutomatically)
          .filter(
            registration =>
              !sessionsByRegistrationRef.current.has(registration.id),
          );
        if (unopened.length === 0) {
          logWalletEvent('WalletState', 'warmWallet.allOpen', {
            walletCount: registeredWalletsRef.current.length,
          });
          return;
        }

        const candidates = unopened
          .filter(
            registration =>
              !walletOpenInFlightRef.current.has(registration.id),
          )
          .sort((left, right) =>
            left.id === activeId ? -1 : right.id === activeId ? 1 : 0,
          );

        if (candidates.length > 0) {
          let cursor = 0;
          const warmWorker = async () => {
            while (!cancelled) {
              const registration = candidates[cursor];
              cursor += 1;
              if (!registration) return;
              const isActive = registration.id === activeId;
              const startedAt = Date.now();
              const maxAttempts = isActive ? 3 : 2;
              logWalletEvent('WalletState', 'warmWallet.start', {
                active: isActive,
                registrationId: registration.id,
              });
              for (
                let attempt = 1;
                attempt <= maxAttempts && !cancelled;
                attempt += 1
              ) {
                try {
                  await ensureRegisteredWalletOpen(
                    registration,
                    isActive,
                    true,
                  );
                  logWalletEvent('WalletState', 'warmWallet.success', {
                    active: isActive,
                    attempt,
                    elapsedMs: Date.now() - startedAt,
                    registrationId: registration.id,
                  });
                  break;
                } catch (reason) {
                  logWalletEvent('WalletState', 'warmWallet.error', {
                    active: isActive,
                    attempt,
                    elapsedMs: Date.now() - startedAt,
                    error: errorMessage(reason),
                    registrationId: registration.id,
                    retrying: true,
                  });
                  if (isActive && attempt === maxAttempts && !cancelled) {
                    setError(errorMessage(reason));
                  }
                  if (attempt < maxAttempts) {
                    await waitForRetry(attempt * 250);
                  }
                }
              }
            }
          };

          logWalletEvent('WalletState', 'warmWallet.batchStart', {
            concurrency: Math.min(2, candidates.length),
            walletCount: candidates.length,
          });
          await Promise.all(
            Array.from({ length: Math.min(2, candidates.length) }, () =>
              warmWorker(),
            ),
          );
        }

        if (cancelled) return;
        const remaining = registeredWalletsRef.current
          .filter(canOpenRegisteredWalletAutomatically)
          .filter(
            registration =>
              !sessionsByRegistrationRef.current.has(registration.id),
          );
        if (remaining.length === 0) {
          logWalletEvent('WalletState', 'warmWallet.batchComplete', {
            walletCount: registeredWalletsRef.current.length,
          });
          return;
        }

        retryRound += 1;
        const retryDelayMs = Math.min(
          15_000,
          500 * 2 ** Math.min(retryRound - 1, 5),
        );
        logWalletEvent('WalletState', 'warmWallet.retryScheduled', {
          retryDelayMs,
          walletCount: remaining.length,
        });
        await waitForRetry(retryDelayMs);
      }
    };

    warmAllWallets().catch(reason => {
      if (!cancelled) {
        logWalletEvent('WalletState', 'warmWallet.lifecycleError', {
          error: errorMessage(reason),
        });
      }
    });

    return () => {
      cancelled = true;
      for (const [timer, resolve] of retryWaits) {
        clearTimeout(timer);
        resolve();
      }
      retryWaits.clear();
    };
  }, [
    appSecurityLocked,
    appSecurityReady,
    automaticWalletOpenKey,
    ensureRegisteredWalletOpen,
  ]);

  useEffect(() => {
    if (!appSecurityReady || appSecurityLocked) {
      return;
    }

    let cancelled = false;
    const poll = async () => {
      const networks = Array.from(
        new Set(
          registeredWalletsRef.current
            .filter(wallet => sessionsByRegistrationRef.current.has(wallet.id))
            .map(wallet => wallet.network),
        ),
      );
      await Promise.all(
        networks.map(async network => {
          try {
            const nativeStatus = await walletService.networkSyncStatus(network);
            if (cancelled) return;
            networkSyncStatusesRef.current = {
              ...networkSyncStatusesRef.current,
              [network]: nativeStatus,
            };
            setNetworkSyncStatuses(previous => ({
              ...previous,
              [network]: nativeStatus,
            }));
            const connection = nodeConnectionFromNative(nativeStatus);
            setNodeConnections(previous =>
              previous[network] === connection
                ? previous
                : { ...previous, [network]: connection },
            );
            if (connection !== 'connecting') {
              setNodeConnectionPhases(previous => {
                if (!(network in previous)) return previous;
                const next = { ...previous };
                delete next[network];
                return next;
              });
            }
            const failureCode = networkSyncFailureCode(nativeStatus);
            const phaseKey = `${nativeStatus.state}:${nativeStatus.phase}:${
              nativeStatus.phaseSequence
            }:${failureCode ?? 'none'}:${nativeStatus.consecutiveFailures}`;
            const previousState =
              lastNativeNetworkStateRef.current.get(network);
            if (previousState !== phaseKey) {
              lastNativeNetworkStateRef.current.set(network, phaseKey);
              logWalletEvent('WalletState', 'networkSync.stateChanged', {
                chainHeight: nativeStatus.chainHeight,
                downloadStartHeight: nativeStatus.downloadStartHeight,
                downloadedHeight: nativeStatus.downloadedHeight,
                failureCode,
                failedAttempts: nativeStatus.consecutiveFailures,
                joinedWallets: nativeStatus.joinedWallets,
                network,
                phase: nativeStatus.phase,
                phaseElapsedMs: nativeStatus.phaseElapsedMs,
                phaseSequence: nativeStatus.phaseSequence,
                state: nativeStatus.state,
                targetHeight: nativeStatus.targetHeight,
                transportStarts: nativeStatus.transportStarts,
              });
            }
          } catch (reason) {
            if (!cancelled) {
              logWalletEvent('WalletState', 'networkSync.statusError', {
                error: errorMessage(reason),
                network,
              });
            }
          }
        }),
      );
    };

    poll();
    const interval = setInterval(() => {
      poll();
    }, 750);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [appSecurityLocked, appSecurityReady, registeredWallets]);

  const openRegisteredWalletById = useCallback(
    async (walletId: string): Promise<boolean> => {
      const startedAt = Date.now();
      logWalletEvent('WalletState', 'openById.registry.start');
      let registration = registeredWalletsRef.current.find(
        wallet => wallet.id === walletId,
      );
      if (!registration) {
        const wallets = await walletService.loadRegisteredWallets();
        registeredWalletsRef.current = wallets;
        setRegisteredWallets(wallets);
        registration = wallets.find(wallet => wallet.id === walletId);
      }
      if (!registration) {
        throw new Error('Selected wallet is missing from the local registry');
      }
      logWalletEvent('WalletState', 'openById.registry.success', {
        elapsedMs: Date.now() - startedAt,
        hasCredentialKey: Boolean(registration.credentialKey),
        isHardware: registration.kind === 'hardware',
      });

      if (registeredWalletRef.current?.id !== walletId) {
        logWalletEvent('WalletState', 'openById.activation.start', {
          elapsedMs: Date.now() - startedAt,
        });
        await activateRegisteredWallet(walletId);
        logWalletEvent('WalletState', 'openById.activation.success', {
          elapsedMs: Date.now() - startedAt,
        });
      }

      try {
        logWalletEvent('WalletState', 'openById.native.start', {
          elapsedMs: Date.now() - startedAt,
        });
        const opened = await ensureRegisteredWalletOpen(registration, true);
        if (opened) {
          setError(undefined);
        }
        logWalletEvent('WalletState', 'openById.native.success', {
          elapsedMs: Date.now() - startedAt,
          success: opened,
        });
        return opened;
      } catch (reason) {
        const message = errorMessage(reason);
        if (registeredWalletRef.current?.id === walletId) {
          setError(message);
        }
        logWalletEvent('WalletState', 'openById.native.error', {
          elapsedMs: Date.now() - startedAt,
        });
        throw reason;
      }
    },
    [activateRegisteredWallet, ensureRegisteredWalletOpen],
  );

  const restoreLedgerViewAfterSigning = useCallback(async (): Promise<boolean> => {
    const activeSession = sessionRef.current;
    const activeRegistration = registeredWalletRef.current;
    if (
      !activeSession ||
      activeSession.readOnly ||
      activeRegistration?.kind !== 'hardware' ||
      !activeRegistration.viewOnlyPath ||
      !activeRegistration.viewOnlyCredentialKey
    ) {
      return false;
    }

    await stopNativeRefresh(activeSession, 'ledgerSigningComplete');
    await walletService.closeWallet(activeSession, true);
    sessionsByRegistrationRef.current.delete(activeRegistration.id);
    sessionRef.current = undefined;
    setSession(undefined);
    setSnapshot(undefined);
    setHardwareStatus(undefined);

    const readOnlySession = {
      ...(await walletService.openRegisteredWalletRegistration(
        activeRegistration,
      )),
      registrationId: activeRegistration.id,
    };
    sessionsByRegistrationRef.current.set(
      activeRegistration.id,
      readOnlySession,
    );
    walletService.activateSession(readOnlySession);
    sessionRef.current = readOnlySession;
    setSession(readOnlySession);
    startNativeRefresh(readOnlySession, 'ledgerSigningComplete');
    return true;
  }, [startNativeRefresh, stopNativeRefresh]);

  const connectLedgerForSigning = useCallback(
    async (control?: LedgerSigningControl) => {
      const activeSession = sessionRef.current;
      const activeRegistration = registeredWalletRef.current;
      if (!activeSession || !activeRegistration) {
        return undefined;
      }
      if (!activeSession.readOnly) {
        if (activeRegistration.kind === 'hardware') {
          const transport = await waitForLedgerTransport({
            getStatus: () => walletService.getLedgerTransportStatus(),
            requestAccess: () => walletService.requestLedgerTransportAccess(),
            control,
          });
          if (control?.isCancelled?.()) {
            throw new LedgerSigningCancelledError();
          }
          control?.onProgress?.({ phase: 'connected', transport });
        } else {
          control?.onProgress?.({ phase: 'connected' });
        }
        return activeSession;
      }
      if (activeRegistration.kind !== 'hardware') {
        throw new Error('The active wallet is not a Ledger wallet');
      }

      logWalletEvent('WalletState', 'connectLedgerForSigning.start', {
        walletId: activeSession.walletId,
        registrationId: activeRegistration.id,
      });
      const transport = await waitForLedgerTransport({
        getStatus: () => walletService.getLedgerTransportStatus(),
        requestAccess: () => walletService.requestLedgerTransportAccess(),
        control,
      });
      if (control?.isCancelled?.()) {
        throw new LedgerSigningCancelledError();
      }
      control?.onProgress?.({ phase: 'synchronizing-wallet', transport });

      // Capture a fresh, account-scoped reference immediately before closing
      // the read companion. Cached UI totals are deliberately insufficient:
      // the signing wallet must later prove the same account identity and at
      // least this scan height.
      const referenceSnapshot = await walletService.snapshot(activeSession);

      // Keep the useful read-only companion open while Android/iOS discovers the
      // Ledger. When an encrypted companion exists, keep its native handle open
      // until Core has transferred the view capability directly into the
      // signing session. No private key crosses React Native or a platform
      // bridge. A wallet without a companion keeps the existing Ledger-export
      // fallback inside Core.
      await stopNativeRefresh(activeSession, 'ledgerSigningRequested');
      const hasEncryptedViewCompanion = Boolean(
        activeRegistration.viewOnlyPath &&
          activeRegistration.viewOnlyCredentialKey,
      );
      let readOnlyCompanionClosed = false;
      const closeReadOnlyCompanion = async () => {
        await walletService.closeWallet(activeSession);
        readOnlyCompanionClosed = true;
        sessionsByRegistrationRef.current.delete(activeRegistration.id);
        sessionRef.current = undefined;
        setSession(undefined);
        setSnapshot(undefined);
        setTransactions([]);
        setHardwareStatus(undefined);
      };

      if (!hasEncryptedViewCompanion) {
        await closeReadOnlyCompanion();
      }

      let openedSigningSession: WalletSession | undefined;
      try {
        const signingSession = await walletService.openHardwareWalletForSigning(
          activeRegistration,
        );
        const registeredSigningSession = {
          ...signingSession,
          registrationId: activeRegistration.id,
        };
        openedSigningSession = registeredSigningSession;
        if (control?.isCancelled?.()) {
          throw new LedgerSigningCancelledError();
        }

        if (hasEncryptedViewCompanion) {
          await walletService.primeHardwareWalletFromViewOnly(
            registeredSigningSession,
            activeSession,
          );
        }

        // Await the native coordinator join before polling. A transport-ready
        // device or a queued refresh alone is not evidence that this distinct
        // hardware wallet cache can spend the balance shown by its companion.
        await walletService.startRefresh(
          registeredSigningSession,
          phase => {
            updateNodeConnectionPhase(activeRegistration.network, phase);
          },
        );
        if (control?.isCancelled?.()) {
          throw new LedgerSigningCancelledError();
        }
        let currentReferenceSnapshot = referenceSnapshot;
        const signingControl: LedgerSigningControl = {
          isCancelled: control?.isCancelled,
          onProgress: progress =>
            control?.onProgress?.({ ...progress, transport }),
        };
        const readSigningSnapshot = (
          deadlineMs: number,
          expectedAccountIndex: number,
        ) =>
          walletService.snapshotForLedgerSigningReadiness(
            {
              ...registeredSigningSession,
              accountIndex: expectedAccountIndex,
              addressIndex: 0,
            },
            deadlineMs,
          );
        const readySnapshot =
          await waitForLedgerSigningSpendReadyWithSingleRebuild({
            referenceSnapshot,
            readSnapshot: readSigningSnapshot,
            control: signingControl,
            refreshReferenceAfterMismatch: hasEncryptedViewCompanion
                  ? async mismatch => {
                    // Freeze both caches around one scan height. Either refresh can
                    // cross another block while catching up, so advance whichever
                    // cache is behind and let the bounded readiness helper repeat
                    // until spend-state parity is proven at a common height.
                    await walletService.stopRefresh(registeredSigningSession);
                    if (
                      mismatch.signingSnapshot.walletHeight >
                  currentReferenceSnapshot.walletHeight
                ) {
                  await walletService.startRefresh(
                    activeSession,
                    phase => {
                      updateNodeConnectionPhase(
                        activeRegistration.network,
                        phase,
                      );
                    },
                  );
                  try {
                    currentReferenceSnapshot =
                      await waitForWalletSnapshotAtHeight({
                        targetHeight: mismatch.signingSnapshot.walletHeight,
                        readSnapshot: deadlineMs =>
                          walletService.snapshotForLedgerSigningReadiness(
                            activeSession,
                            deadlineMs,
                          ),
                        control: signingControl,
                      });
                  } finally {
                    await walletService
                      .stopRefresh(activeSession)
                          .catch(() => undefined);
                      }
                    }
                    if (
                      currentReferenceSnapshot.walletHeight >
                      mismatch.signingSnapshot.walletHeight
                    ) {
                      const expectedAccountIndex =
                        currentReferenceSnapshot.spendAccountIndex;
                      if (expectedAccountIndex === undefined) {
                        throw new Error(
                          'The encrypted Ledger viewing wallet does not have a verified transaction account.',
                        );
                      }
                      await walletService.startRefresh(
                        registeredSigningSession,
                        phase => {
                          updateNodeConnectionPhase(
                            activeRegistration.network,
                            phase,
                          );
                        },
                      );
                      try {
                        await waitForWalletSnapshotAtHeight({
                          targetHeight:
                            currentReferenceSnapshot.walletHeight,
                          readSnapshot: deadlineMs =>
                            readSigningSnapshot(
                              deadlineMs,
                              expectedAccountIndex,
                            ),
                          control: signingControl,
                        });
                      } finally {
                        await walletService
                          .stopRefresh(registeredSigningSession)
                          .catch(() => undefined);
                      }
                    }
                    return currentReferenceSnapshot;
                  }
              : undefined,
            rebuild: async () => {
              if (!hasEncryptedViewCompanion) {
                throw new Error(
                  'The Ledger signing wallet spend state could not be rebuilt without its encrypted viewing wallet.',
                );
              }
              await walletService.rebuildHardwareWalletCacheFromViewOnly(
                registeredSigningSession,
                activeSession,
                activeRegistration.restoreHeight ?? 0,
              );
              await walletService.startRefresh(
                registeredSigningSession,
                phase => {
                  updateNodeConnectionPhase(activeRegistration.network, phase);
                },
              );
            },
          });
        if (control?.isCancelled?.()) {
          throw new LedgerSigningCancelledError();
        }
        const spendAccountIndex = readySnapshot.spendAccountIndex;
        if (spendAccountIndex === undefined) {
          throw new Error(
            'The Ledger signing wallet does not have a verified transaction account.',
          );
        }
        if (hasEncryptedViewCompanion && !readOnlyCompanionClosed) {
          await closeReadOnlyCompanion();
        }
        const spendScopedSigningSession = {
          ...registeredSigningSession,
          accountIndex: spendAccountIndex,
          addressIndex: 0,
        };
        sessionsByRegistrationRef.current.set(
          activeRegistration.id,
          spendScopedSigningSession,
        );
        walletService.activateSession(spendScopedSigningSession);
        sessionRef.current = spendScopedSigningSession;
        setSession(spendScopedSigningSession);
        const nextSnapshots = {
          ...walletSnapshotsRef.current,
          [activeRegistration.id]: readySnapshot,
        };
        walletSnapshotsRef.current = nextSnapshots;
        setWalletSnapshots(nextSnapshots);
        setSnapshot(readySnapshot);
        walletStateSamplesByRegistrationRef.current.set(
          activeRegistration.id,
          {
            snapshot: readySnapshot,
            transactions:
              transactionsByRegistrationRef.current.get(
                activeRegistration.id,
              ) ?? [],
          },
        );
        setPublicationTick(current => current + 1);
        const signingReadyRegistration = await saveRegisteredWallet({
          ...activeRegistration,
          ledgerSigningReadyAt: new Date().toISOString(),
          ledgerSigningReadyHeight: readySnapshot.walletHeight,
        });
        registeredWalletRef.current = signingReadyRegistration;
        registeredWalletsRef.current = registeredWalletsRef.current.map(
          wallet =>
            wallet.id === signingReadyRegistration.id
              ? signingReadyRegistration
              : wallet,
        );
        setRegisteredWallet(signingReadyRegistration);
        setRegisteredWallets([...registeredWalletsRef.current]);
        saveWalletSnapshot(activeRegistration.id, readySnapshot).catch(
          cacheError => {
            logWalletEvent('WalletState', 'ledgerSigning.cacheError', {
              error: errorMessage(cacheError),
              registrationId: activeRegistration.id,
            });
          },
        );
        setError(undefined);
        startNativeRefresh(spendScopedSigningSession, 'ledgerSigningConnected');
        control?.onProgress?.({ phase: 'connected', transport });
        logWalletEvent('WalletState', 'connectLedgerForSigning.success', {
          walletId: spendScopedSigningSession.walletId,
          registrationId: activeRegistration.id,
        });
        openedSigningSession = undefined;
        return spendScopedSigningSession;
      } catch (reason) {
        const message = errorMessage(reason);
        if (openedSigningSession) {
          await walletService
            .stopRefresh(openedSigningSession)
            .catch(() => undefined);
          // A failed or timed-out signing attempt has not created or
          // broadcast a transaction. Persist only the validated wallet cache
          // so the next attempt resumes its Ledger scan instead of starting
          // again at the original restore height.
          await walletService
            .closeWallet(openedSigningSession, true)
            .catch(() => undefined);
        }
        if (!isLedgerSigningCancelledError(reason)) {
          setError(message);
        }
        logWalletEvent('WalletState', 'connectLedgerForSigning.error', {
          error: message,
          registrationId: activeRegistration.id,
        });

        // A cancelled, unavailable, or mismatched Ledger must not destroy the
        // useful companion. Reuse its still-open native handle when priming
        // failed; only reopen it when the successful handoff already closed it.
        try {
          const readOnlySession = readOnlyCompanionClosed
            ? await walletService.openRegisteredWalletRegistration(
                activeRegistration,
              )
            : activeSession;
          const registeredReadOnlySession = {
            ...readOnlySession,
            registrationId: activeRegistration.id,
          };
          sessionsByRegistrationRef.current.set(
            activeRegistration.id,
            registeredReadOnlySession,
          );
          walletService.activateSession(registeredReadOnlySession);
          sessionRef.current = registeredReadOnlySession;
          setSession(registeredReadOnlySession);
          startNativeRefresh(
            registeredReadOnlySession,
            'ledgerSigningCancelled',
          );
        } catch (restoreError) {
          logWalletEvent(
            'WalletState',
            'connectLedgerForSigning.restoreError',
            {
              error: errorMessage(restoreError),
              registrationId: activeRegistration.id,
            },
          );
        }
        throw reason;
      }
    },
    [startNativeRefresh, stopNativeRefresh, updateNodeConnectionPhase],
  );

  const reconcileLedgerBalance = useCallback(
    async (
      fullSpendOutputScan = false,
      singleFlightAlreadyHeld = false,
      observeProgress?: (progress: LedgerReconciliationProgress) => void,
    ): Promise<boolean> => {
      if (!singleFlightAlreadyHeld) {
        if (ledgerReconciliationInFlightRef.current) {
          logWalletEvent(
            'WalletState',
            'ledgerReconciliation.singleFlightJoined',
            {
              origin: 'manual-or-legacy',
            },
          );
          return false;
        }
        ledgerReconciliationInFlightRef.current = true;
      }
      try {
        let activeRegistration = registeredWalletRef.current;
        let activeSession = sessionRef.current;
        if (!activeRegistration || activeRegistration.kind !== 'hardware') {
          throw new Error(
            'Choose the normal Ledger wallet to verify its balance.',
          );
        }
        setLedgerReconciliationProgress({ phase: 'checking-local-scan' });
        if (
          !activeRegistration.viewOnlyPath ||
          !activeRegistration.viewOnlyCredentialKey
        ) {
          activeRegistration =
            await walletService.enableLedgerReadOnlyCompanion(
              activeRegistration,
            );
        }
        if (activeSession && !activeSession.readOnly) {
          await walletService.closeWallet(activeSession, true);
        }
        // Never trust only the React-side warmed-session map here. A previous
        // background reconciliation may have closed that native handle while
        // the UI still held its old id. Ask WalletService for the currently
        // leased handle (or a newly opened one) before the one-time Ledger
        // pass, otherwise Core correctly rejects it as "unknown wallet id".
        activeSession = {
          ...(await walletService.openRegisteredWalletRegistration(
            activeRegistration,
          )),
          registrationId: activeRegistration.id,
        };
        sessionsByRegistrationRef.current.set(
          activeRegistration.id,
          activeSession,
        );
        walletService.activateSession(activeSession);
        sessionRef.current = activeSession;
        setSession(activeSession);
        registeredWalletRef.current = activeRegistration;
        setRegisteredWallet(activeRegistration);
        const result = await walletService.reconcileLedgerViewOnlyWallet(
          activeRegistration,
          progress => {
            observeProgress?.(progress);
            setLedgerReconciliationProgress(progress);
            logWalletEvent('WalletState', 'ledgerReconciliation.phase', {
              phase: progress.phase,
              targetHeight: progress.targetHeight,
              viewHeight: progress.viewHeight,
            });
          },
          {
            // The selected Ledger registration is already backed by its
            // warmed read-only companion. Supplying it explicitly prevents a
            // background service pointer from causing a duplicate native
            // scanner while another wallet is being warmed.
            viewSession: activeSession,
            fullSpendOutputScan,
          },
        );
        const wallets = await walletService.loadRegisteredWallets();
        registeredWalletRef.current = result.registration;
        registeredWalletsRef.current = wallets;
        setRegisteredWallet(result.registration);
        setRegisteredWallets(wallets);
        const nextCache = {
          ...walletSnapshotsRef.current,
          [result.registration.id]: result.snapshot,
        };
        walletSnapshotsRef.current = nextCache;
        setWalletSnapshots(nextCache);
        setSnapshot(result.snapshot);
        await saveWalletSnapshot(result.registration.id, result.snapshot);
        // Key-image import mutates spent state and can reconstruct confirmed
        // outgoing history inside the already-open view wallet. Refresh the
        // complete history before releasing the reconciliation gate; waiting
        // for an unrelated polling tick leaves the UI showing only incoming
        // transfers even though Core has already committed the spends.
        const authoritativeTransactions =
          await walletService.getTransactionsForAllAccounts(activeSession, 0);
        const nextTransactions = await mergeTransactionsWithPending(
          result.registration.id,
          authoritativeTransactions,
        );
        transactionsByRegistrationRef.current.set(
          result.registration.id,
          nextTransactions,
        );
        walletStateSamplesByRegistrationRef.current.set(
          result.registration.id,
          { snapshot: result.snapshot, transactions: nextTransactions },
        );
        setPublicationTick(current => current + 1);
        setTransactions(nextTransactions);
        logWalletEvent('WalletState', 'ledgerReconciliation.stateRefreshed', {
          incomingTransactionCount: nextTransactions.filter(
            transaction => transaction.direction === 'in',
          ).length,
          outgoingTransactionCount: nextTransactions.filter(
            transaction => transaction.direction === 'out',
          ).length,
          pendingOutputKeyImageCount:
            result.snapshot.pendingOutputKeyImageCount ?? 0,
          txCount: nextTransactions.length,
        });
        if (
          ledgerNodeRetryRegistrationIdRef.current === result.registration.id
        ) {
          ledgerNodeRetryRegistrationIdRef.current = undefined;
          setLedgerNodeRetryRegistrationId(undefined);
        }
        setError(undefined);
        return true;
      } catch (reason) {
        if (isLedgerNodeVerificationError(reason)) {
          ledgerNodeRetryRegistrationIdRef.current =
            registeredWalletRef.current?.id;
          setLedgerNodeRetryRegistrationId(
            ledgerNodeRetryRegistrationIdRef.current,
          );
        }
        logWalletEvent('WalletState', 'ledgerReconciliation.failed', {
          error: errorMessage(reason),
        });
        throw reason;
      } finally {
        setLedgerReconciliationProgress(undefined);
        if (!singleFlightAlreadyHeld) {
          ledgerReconciliationInFlightRef.current = false;
        }
      }
    },
    [mergeTransactionsWithPending],
  );

  const ledgerAutoVerificationRegistrationId =
    registeredWallet?.kind === 'hardware' &&
    registeredWallet.role !== 'fast' &&
    registeredWallet.viewOnlyPath &&
    registeredWallet.viewOnlyCredentialKey
      ? registeredWallet.id
      : undefined;
  const ledgerAutoVerificationSnapshot = ledgerAutoVerificationRegistrationId
    ? walletSnapshots[ledgerAutoVerificationRegistrationId] ?? snapshot
    : undefined;
  // Keep the effect trigger primitive and stable. The five-second polling
  // loop replaces snapshot and registration objects even when their relevant
  // state did not change; depending on those objects cancels Android BLE
  // discovery before it can finish.
  const ledgerAutoVerificationReady = Boolean(
    ledgerAutoVerificationRegistrationId &&
      registeredWallet &&
      ledgerInitialVerificationCanStart(
        registeredWallet,
        ledgerAutoVerificationSnapshot,
        transactionsByRegistrationRef.current.get(
          ledgerAutoVerificationRegistrationId,
        )?.length ?? 0,
      ),
  );

  useEffect(() => {
    const registrationId = ledgerAutoVerificationRegistrationId;
    if (
      !appSecurityReady ||
      appSecurityLocked ||
      !registrationId ||
      !ledgerAutoVerificationReady
    ) {
      return;
    }

    let cancelled = false;
    let inFlight = false;
    let retryTimeout: ReturnType<typeof setTimeout> | undefined;

    const scheduleRetry = (delayMs: number) => {
      if (cancelled || retryTimeout) return;
      retryTimeout = setTimeout(() => {
        retryTimeout = undefined;
        attempt().catch(() => undefined);
      }, Math.max(250, delayMs));
    };

    const attempt = async () => {
      if (cancelled || inFlight) return;
      const registration = registeredWalletRef.current;
      if (!registration || registration.id !== registrationId) {
        logWalletEvent('WalletState', 'ledgerAutoVerification.deferred', {
          reason: 'active-wallet-changed',
          registrationId,
        });
        return;
      }
      const currentSnapshot =
        walletSnapshotsRef.current[registrationId] ??
        walletStateSamplesByRegistrationRef.current.get(registrationId)
          ?.snapshot;
      const needsLedgerDerivation =
        ledgerNodeRetryRegistrationIdRef.current !== registrationId &&
        currentSnapshot?.pendingOutputKeyImageCount !== 0;
      let derivationStarted = false;
      if (
        !ledgerInitialVerificationCanStart(
          registration,
          currentSnapshot,
          transactionsByRegistrationRef.current.get(registrationId)?.length ??
            0,
        )
      ) {
        return;
      }
      const now = Date.now();
      const nextAttemptAt =
        ledgerInitialVerificationNextAttemptAtRef.current.get(registrationId) ??
        0;
      if (nextAttemptAt > now) {
        scheduleRetry(nextAttemptAt - now);
        return;
      }
      if (ledgerInitialVerificationAttemptedRef.current.has(registrationId)) {
        return;
      }
      if (ledgerReconciliationInFlightRef.current) {
        scheduleRetry(1_000);
        return;
      }

      // Status is deliberately a passive check on iOS/Android. When work is
      // queued, request one bounded discovery pass before giving up. This
      // avoids the old dead end where a Ledger was powered on but invisible
      // until the user opened the "add Ledger" screen. The cooldown belongs
      // to the wallet, so a missing device never causes continuous scans.
      try {
        // Hold the app-wide gate during the bounded BLE discovery too. This
        // prevents an inactive wallet or an old manual caller from opening a
        // second discovery/reconciliation path for the same physical device.
        inFlight = true;
        ledgerReconciliationInFlightRef.current = true;
        if (needsLedgerDerivation) {
          if (ledgerNodeRetryRegistrationIdRef.current === registrationId) {
            ledgerNodeRetryRegistrationIdRef.current = undefined;
            setLedgerNodeRetryRegistrationId(undefined);
          }
          let transport = await walletService.getLedgerTransportStatus();
          if (
            !transport.supported ||
            !transport.available ||
            !transport.permissionGranted ||
            transport.deviceCount < 1
          ) {
            setLedgerReconciliationProgress({ phase: 'connecting-ledger' });
            transport = await walletService.requestLedgerTransportAccess();
          }
          if (
            !transport.supported ||
            !transport.available ||
            !transport.permissionGranted ||
            transport.deviceCount < 1
          ) {
            ledgerInitialVerificationNextAttemptAtRef.current.set(
              registrationId,
              Date.now() + 15_000,
            );
            logWalletEvent('WalletState', 'ledgerAutoVerification.waiting', {
              available: transport.available,
              deviceCount: transport.deviceCount,
              permissionGranted: transport.permissionGranted,
              registrationId,
              supported: transport.supported,
              transport: transport.transport,
            });
            setLedgerReconciliationProgress(undefined);
            scheduleRetry(15_000);
            return;
          }
        } else {
          ledgerNodeRetryRegistrationIdRef.current = registrationId;
          setLedgerNodeRetryRegistrationId(registrationId);
          setLedgerReconciliationProgress({
            phase: 'retrying-spent-output-node',
          });
          logWalletEvent(
            'WalletState',
            'ledgerAutoVerification.nodeOnlyRetry',
            { registrationId },
          );
        }

        // BLE discovery is asynchronous. Only a real lifecycle invalidation
        // or wallet switch may cancel it; routine snapshot polling must not.
        if (cancelled) {
          ledgerInitialVerificationNextAttemptAtRef.current.set(
            registrationId,
            Date.now() + 15_000,
          );
          logWalletEvent('WalletState', 'ledgerAutoVerification.deferred', {
            reason: 'effect-invalidated',
            registrationId,
          });
          return;
        }
        if (registeredWalletRef.current?.id !== registrationId) {
          logWalletEvent('WalletState', 'ledgerAutoVerification.deferred', {
            reason: 'active-wallet-changed',
            registrationId,
          });
          return;
        }

        ledgerInitialVerificationAttemptedRef.current.add(registrationId);
        ledgerInitialVerificationNextAttemptAtRef.current.delete(
          registrationId,
        );
        logWalletEvent('WalletState', 'ledgerAutoVerification.start', {
          registrationId,
        });
        await reconcileLedgerBalance(true, true, progress => {
          if (progress.phase === 'deriving-owned-output-key-images') {
            derivationStarted = true;
          }
        });
        if (ledgerNodeRetryRegistrationIdRef.current === registrationId) {
          ledgerNodeRetryRegistrationIdRef.current = undefined;
          setLedgerNodeRetryRegistrationId(undefined);
        }
        logWalletEvent('WalletState', 'ledgerAutoVerification.complete', {
          registrationId,
        });
      } catch (reason) {
        const nodeVerificationFailed = isLedgerNodeVerificationError(reason);
        // Transport/local-scan failures may retry after a cooldown. Once the
        // Ledger derivation itself started, keep the attempted gate so an
        // effect remount cannot immediately repeat hardware APDUs. A wrapped
        // node-only failure is safe to retry without waking Ledger again.
        const retryAllowed = !derivationStarted || nodeVerificationFailed;
        if (retryAllowed) {
          ledgerInitialVerificationAttemptedRef.current.delete(registrationId);
          ledgerInitialVerificationNextAttemptAtRef.current.set(
            registrationId,
            Date.now() + 15_000,
          );
        } else {
          ledgerInitialVerificationNextAttemptAtRef.current.delete(
            registrationId,
          );
        }
        if (nodeVerificationFailed) {
          ledgerNodeRetryRegistrationIdRef.current = registrationId;
          setLedgerNodeRetryRegistrationId(registrationId);
        } else if (
          ledgerNodeRetryRegistrationIdRef.current === registrationId
        ) {
          ledgerNodeRetryRegistrationIdRef.current = undefined;
          setLedgerNodeRetryRegistrationId(undefined);
        }
        logWalletEvent('WalletState', 'ledgerAutoVerification.failed', {
          error: errorMessage(reason),
          registrationId,
        });
        if (retryAllowed) {
          scheduleRetry(15_000);
        }
      } finally {
        setLedgerReconciliationProgress(undefined);
        inFlight = false;
        ledgerReconciliationInFlightRef.current = false;
      }
    };

    attempt().catch(() => undefined);
    return () => {
      cancelled = true;
      if (retryTimeout) {
        clearTimeout(retryTimeout);
      }
    };
  }, [
    appSecurityLocked,
    appSecurityReady,
    ledgerAutoVerificationReady,
    ledgerAutoVerificationRegistrationId,
    reconcileLedgerBalance,
  ]);

  useEffect(() => {
    let pollCount = 0;
    const refreshOpenSessions = () => {
      if (!appSecurityReady || appSecurityLocked) {
        return;
      }
      pollCount += 1;
      logWalletEvent('WalletState', 'openSessionPolling.tick', {
        hardwareStatusRequested: Boolean(sessionRef.current?.hardwareDevice),
        intervalMs: 5000,
        pollCount,
        sessionCount: sessionsByRegistrationRef.current.size,
      });
      for (const [
        registrationId,
        openedSession,
      ] of sessionsByRegistrationRef.current.entries()) {
        const registration = registeredWalletsRef.current.find(
          wallet => wallet.id === registrationId,
        );
        if (!registration) {
          continue;
        }
        refreshSessionState(registration, openedSession).catch(() => undefined);
      }
      if (sessionRef.current?.hardwareDevice) {
        refreshHardwareWalletStatus().catch(() => undefined);
      }
    };

    logWalletEvent('WalletState', 'openSessionPolling.started', {
      intervalMs: 5000,
    });
    refreshOpenSessions();
    const interval = setInterval(refreshOpenSessions, 5000);

    return () => {
      clearInterval(interval);
      logWalletEvent('WalletState', 'openSessionPolling.stopped', {
        intervalMs: 5000,
        pollCount,
      });
    };
  }, [
    appSecurityLocked,
    appSecurityReady,
    refreshHardwareWalletStatus,
    refreshSessionState,
  ]);

  const publicationState = useMemo(() => {
    const publishedWalletSnapshots: WalletSnapshotCache = {};
    let activePublication:
      | WalletPublication<WalletSnapshot, WalletTransaction>
      | undefined;
    const ledgerPhase: WalletReadinessPhase | undefined =
      ledgerReconciliationProgress?.phase === 'connecting-ledger'
        ? 'connecting-ledger'
        : ledgerReconciliationProgress?.phase ===
          'deriving-owned-output-key-images'
        ? 'scanning-spend-outputs'
        : ledgerReconciliationProgress?.phase ===
          'retrying-spent-output-node'
        ? 'retrying-spent-output-node'
        : ledgerReconciliationProgress?.phase === 'saving-ledger-balance'
        ? 'persisting-wallet'
        : ledgerReconciliationProgress
        ? 'wallet-scan'
        : undefined;

    for (const registration of registeredWallets) {
      const sample = walletStateSamplesByRegistrationRef.current.get(
        registration.id,
      );
      const candidate = sample?.snapshot;
      const requiresLedgerVerification =
        registration.kind === 'hardware' &&
        registration.role !== 'fast' &&
        !registration.ledgerKeyImagesVerifiedAt;
      const ledgerVerified = !requiresLedgerVerification;
      const previous = publicationsByRegistrationRef.current.get(
        registration.id,
      );
      const next = nextWalletPublication(previous, {
        snapshot: candidate,
        transactions: sample?.transactions ?? [],
        requiresLedgerVerification,
        ledgerVerified,
        ledgerPhase:
          registeredWallet?.id === registration.id
            ? ledgerPhase ??
              (ledgerNodeRetryRegistrationId === registration.id
                ? 'retrying-spent-output-node'
                : undefined)
            : undefined,
        sessionRecovering:
          registeredWallet?.id === registration.id && sessionRecovering,
        sessionGeneration:
          sessionGenerationsByRegistrationRef.current.get(registration.id) ?? 0,
      });
      publicationsByRegistrationRef.current.set(registration.id, next);
      if (next.publishedSnapshot) {
        publishedWalletSnapshots[registration.id] = next.publishedSnapshot;
      }
      if (registeredWallet?.id === registration.id) {
        activePublication = next;
      }
    }

    return { activePublication, publicationTick, publishedWalletSnapshots };
  }, [
    ledgerReconciliationProgress,
    ledgerNodeRetryRegistrationId,
    publicationTick,
    registeredWallet,
    registeredWallets,
    sessionRecovering,
  ]);
  const publishedSnapshot =
    publicationState.activePublication?.publishedSnapshot;
  const publishedTransactions = useMemo(
    () => [
      ...(publicationState.activePublication?.publishedTransactions ?? []),
    ],
    [publicationState.activePublication],
  );
  const visibleTransactions = useMemo(() => {
    if (publicationState.activePublication?.ready) {
      return publishedTransactions;
    }
    // A Ledger restore knows incoming ownership before it knows which owned
    // outputs were spent. Show that confirmed discovery immediately, but keep
    // outgoing history and the balance behind the one-time key-image gate so
    // the UI never claims a provisional spendable amount.
    if (
      registeredWallet?.kind === 'hardware' &&
      registeredWallet.role !== 'fast'
    ) {
      return workingTransactions.filter(
        transaction => transaction.direction === 'in' && !transaction.failed,
      );
    }
    return workingTransactions.filter(transaction => !transaction.failed);
  }, [
    publicationState.activePublication?.ready,
    publishedTransactions,
    registeredWallet?.kind,
    registeredWallet?.role,
    workingTransactions,
  ]);

  const progress = presentWalletSync(snapshot, {
    startHeight: syncStartHeight,
  }).progress;
  const status = useMemo<WalletRuntimeStatus>(() => {
    if (loadingRegistry) {
      return 'loading';
    }

    if (error && !session) {
      return 'error';
    }

    if (session && snapshot) {
      return walletSnapshotIsSynchronized(snapshot) ? 'open' : 'syncing';
    }

    if (session) {
      return 'opening';
    }

    if (registeredWallet) {
      // App authorization is the only wallet lock. A registered wallet with
      // no native handle yet is reopening automatically, never waiting for a
      // second per-wallet unlock action.
      return 'opening';
    }

    return 'empty';
  }, [error, loadingRegistry, registeredWallet, session, snapshot]);
  const nodeConnectionStatus =
    registeredWallet === undefined
      ? 'idle'
      : nodeConnections[registeredWallet.network] ?? 'idle';
  const nodeConnectionPhase = registeredWallet
    ? nodeConnectionPhases[registeredWallet.network]
    : undefined;
  const networkSyncStatus = registeredWallet
    ? networkSyncStatuses[registeredWallet.network]
    : undefined;
  const spendReady = useMemo(() => {
    return walletIsSpendReady({
      snapshot: publishedSnapshot,
      hardwareWallet:
        registeredWallet?.kind === 'hardware' &&
        registeredWallet.role !== 'fast',
      readOnlySession: session?.readOnly !== false,
      ledgerSigningReadyHeight: registeredWallet?.ledgerSigningReadyHeight,
    });
  }, [publishedSnapshot, registeredWallet, session?.readOnly]);

  const isRegisteredWalletOpen = useCallback(
    (walletId: string) => sessionsByRegistrationRef.current.has(walletId),
    [],
  );

  const value = useMemo<WalletStateValue>(
    () => ({
      error,
      registeredWallet,
      registeredWallets,
      hardwareStatus,
      walletSnapshots: publicationState.publishedWalletSnapshots,
      session,
      snapshot: publishedSnapshot,
      workingSnapshot: snapshot,
      walletReadinessPhase: publicationState.activePublication?.phase,
      spendReady,
      transactions: [...visibleTransactions],
      incomingTransactionNotice,
      nodeConnectionStatus,
      nodeConnectionPhase,
      networkSyncStatus,
      ledgerReconciliationProgress,
      status,
      syncProgress: progress,
      syncStartHeight,
      isRegisteredWalletOpen,
      openRegisteredWalletById,
      clearError: () => setError(undefined),
      dismissIncomingTransactionNotice,
      registerOpenedSession,
      reloadRegisteredWallet,
      reloadRegisteredWallets,
      setActiveRegisteredWallet: activateRegisteredWallet,
      renameRegisteredWallet,
      removeRegisteredWallet,
      backupRegisteredWalletSeed,
      refreshSnapshot,
      refreshTransactions,
      publishPendingOutgoing,
      refreshHardwareWalletStatus,
      reconnectHardwareWallet,
      connectLedgerForSigning,
      restoreLedgerViewAfterSigning,
      reconcileLedgerBalance,
      showHardwareWalletAddress,
    }),
    [
      error,
      hardwareStatus,
      incomingTransactionNotice,
      nodeConnectionStatus,
      nodeConnectionPhase,
      networkSyncStatus,
      ledgerReconciliationProgress,
      isRegisteredWalletOpen,
      openRegisteredWalletById,
      progress,
      syncStartHeight,
      reconnectHardwareWallet,
      connectLedgerForSigning,
      restoreLedgerViewAfterSigning,
      reconcileLedgerBalance,
      refreshHardwareWalletStatus,
      refreshSnapshot,
      refreshTransactions,
      publishPendingOutgoing,
      registerOpenedSession,
      registeredWallet,
      registeredWallets,
      publicationState,
      reloadRegisteredWallet,
      reloadRegisteredWallets,
      activateRegisteredWallet,
      renameRegisteredWallet,
      removeRegisteredWallet,
      backupRegisteredWalletSeed,
      session,
      showHardwareWalletAddress,
      snapshot,
      status,
      spendReady,
      publishedSnapshot,
      visibleTransactions,
      dismissIncomingTransactionNotice,
    ],
  );

  return (
    <WalletStateContext.Provider value={value}>
      {children}
    </WalletStateContext.Provider>
  );
}

export function useWalletState(): WalletStateValue {
  const value = useContext(WalletStateContext);
  if (!value) {
    throw new Error('useWalletState must be used inside WalletStateProvider');
  }

  return value;
}
