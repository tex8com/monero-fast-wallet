import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import type {
  HardwareWalletStatus,
  WalletTransaction,
  WalletSnapshot,
} from './NativeMoneroWallet';
import {
  isFastWalletRegistration,
  walletDisplayName,
  type RegisteredWallet,
} from './WalletRegistry';
import { walletService, type WalletSession } from './WalletService';
import {
  FastWalletPushService,
  type FastWalletPushEvent,
} from './FastWalletPushService';
import { logWalletEvent } from './WalletLogger';
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
import { presentWalletSync } from '../../../../packages/wallet-shared/src/walletSync';

type RegisterOpenedSessionOptions = {
  refresh?: boolean;
  select?: boolean;
};

export type WalletRuntimeStatus =
  'loading' | 'empty' | 'locked' | 'opening' | 'syncing' | 'open' | 'error';

interface WalletStateValue {
  error: string | undefined;
  registeredWallet: RegisteredWallet | undefined;
  registeredWallets: RegisteredWallet[];
  hardwareStatus: HardwareWalletStatus | undefined;
  walletSnapshots: WalletSnapshotCache;
  session: WalletSession | undefined;
  snapshot: WalletSnapshot | undefined;
  transactions: WalletTransaction[];
  incomingTransactionNotice: IncomingTransactionNotice | undefined;
  status: WalletRuntimeStatus;
  syncProgress: number | undefined;
  syncStartHeight: number | undefined;
  unlockRequestId: number | undefined;
  isRegisteredWalletOpen: (walletId: string) => boolean;
  clearError: () => void;
  dismissIncomingTransactionNotice: () => void;
  lockWallet: () => Promise<void>;
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
  refreshSnapshot: () => Promise<WalletSnapshot | undefined>;
  refreshTransactions: () => Promise<WalletTransaction[]>;
  refreshHardwareWalletStatus: () => Promise<HardwareWalletStatus | undefined>;
  reconnectHardwareWallet: () => Promise<HardwareWalletStatus | undefined>;
  connectLedgerForSigning: () => Promise<WalletSession | undefined>;
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

export function WalletStateProvider({
  children,
}: {
  children: React.ReactNode;
}) {
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
  const [walletSnapshots, setWalletSnapshots] = useState<WalletSnapshotCache>(
    {},
  );
  const walletSnapshotsRef = useRef<WalletSnapshotCache>({});
  const [snapshot, setSnapshot] = useState<WalletSnapshot | undefined>();
  const [syncStartHeight, setSyncStartHeight] = useState<number | undefined>();
  const [transactions, setTransactions] = useState<WalletTransaction[]>([]);
  const [incomingTransactionNotice, setIncomingTransactionNotice] = useState<
    IncomingTransactionNotice | undefined
  >();
  const [unlockRequestId, setUnlockRequestId] = useState<number | undefined>();
  const [error, setError] = useState<string | undefined>();
  const sessionRef = useRef<WalletSession | undefined>(undefined);
  const sessionsByRegistrationRef = useRef(new Map<string, WalletSession>());
  const transactionsByRegistrationRef = useRef(
    new Map<string, WalletTransaction[]>(),
  );
  const syncStartHeightsRef = useRef(new Map<string, number>());
  const registeredWalletRef = useRef<RegisteredWallet | undefined>(undefined);
  const registeredWalletsRef = useRef<RegisteredWallet[]>([]);
  const incomingTransactionObserverRef = useRef(
    new IncomingTransactionObserver(),
  );
  const incomingTransactionNoticeRef = useRef<
    IncomingTransactionNotice | undefined
  >(undefined);
  const incomingTransactionNoticeQueueRef = useRef<IncomingTransactionNotice[]>(
    [],
  );
  const autoOpenAttemptedWalletIdsRef = useRef(new Set<string>());
  const nativeRefreshWalletIdsRef = useRef(new Set<string>());
  const nativeRefreshReadyWalletIdsRef = useRef(new Set<string>());
  const nativeRefreshRetryAttemptsRef = useRef(new Map<string, number>());
  const nativeRefreshRetryTimeoutsRef = useRef(
    new Map<string, ReturnType<typeof setTimeout>>(),
  );
  const snapshotRefreshInFlightIdsRef = useRef(new Set<string>());
  const transactionRefreshInFlightIdsRef = useRef(new Set<string>());
  const globallyLockedRef = useRef(false);
  const hardwareRefreshInFlight = useRef(false);
  const processedPushEventIdRef = useRef<string | undefined>(undefined);

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
          pending: next.pending,
          walletId: next.walletId,
        });
      }
    },
    [],
  );

  const dismissIncomingTransactionNotice = useCallback(() => {
    const dismissed = incomingTransactionNoticeRef.current;
    const next = incomingTransactionNoticeQueueRef.current.shift();
    incomingTransactionNoticeRef.current = next;
    setIncomingTransactionNotice(next);
    if (dismissed) {
      logWalletEvent('WalletState', 'incomingNotice.dismissed', {
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
      const registration = registeredWalletsRef.current.find(
        wallet => wallet.id === registrationId,
      );
      if (isFastWalletRegistration(registration)) {
        logWalletEvent('WalletState', `${operation}.skipped`, {
          reason: 'fastWalletUsesScannerSignals',
          walletId: activeSession.walletId,
        });
        return true;
      }

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

      return false;
    },
    [],
  );

  const reloadRegisteredWallet = useCallback(async () => {
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
    setLoadingRegistry(false);
    return wallet;
  }, []);

  const reloadRegisteredWallets = useCallback(async () => {
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
    setLoadingRegistry(false);
    return wallets;
  }, []);

  const activateRegisteredWallet = useCallback(async (walletId: string) => {
    const wallet = await walletService.setActiveRegisteredWallet(walletId);
    const wallets = await walletService.loadRegisteredWallets();
    const openedSession = sessionsByRegistrationRef.current.get(walletId);
    registeredWalletRef.current = wallet;
    registeredWalletsRef.current = wallets;
    setRegisteredWallet(wallet);
    setRegisteredWallets(wallets);
    sessionRef.current = openedSession;
    setSession(openedSession);
    if (openedSession) {
      walletService.activateSession(openedSession);
    }
    setSnapshot(walletSnapshotsRef.current[walletId]);
    setTransactions(transactionsByRegistrationRef.current.get(walletId) ?? []);
    setSyncStartHeight(syncStartHeightsRef.current.get(walletId));
    setHardwareStatus(undefined);
    setError(undefined);
    setUnlockRequestId(undefined);
    setLoadingRegistry(false);
    return wallet;
  }, []);

  const removeRegisteredWallet = useCallback(
    async (walletId: string) => {
      const removingActiveWallet = registeredWalletRef.current?.id === walletId;
      const wallets = await walletService.removeRegisteredWallet(walletId);
      const [active, cachedSnapshots] = await Promise.all([
        walletService.loadRegisteredWallet(),
        pruneWalletSnapshotCache(wallets.map(wallet => wallet.id)),
      ]);

      const removedSession = sessionsByRegistrationRef.current.get(walletId);
      if (removedSession) {
        await stopNativeRefresh(removedSession, 'walletRemoved');
        await walletService.closeWallet(removedSession).catch(() => undefined);
      }
      sessionsByRegistrationRef.current.delete(walletId);
      transactionsByRegistrationRef.current.delete(walletId);
      syncStartHeightsRef.current.delete(walletId);
      autoOpenAttemptedWalletIdsRef.current.delete(walletId);

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
            ? (transactionsByRegistrationRef.current.get(active.id) ?? [])
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

  useEffect(() => {
    let mounted = true;
    walletService
      .loadFastReceiveIdentities()
      .catch(reason => {
        logWalletEvent('WalletState', 'fastWalletMigration.error', {
          error: errorMessage(reason),
        });
        return [];
      })
      .then(() =>
        Promise.all([
          walletService.loadRegisteredWallet(),
          walletService.loadRegisteredWallets(),
          loadWalletSnapshotCache(),
        ] as const),
      )
      .then(([wallet, wallets, cachedSnapshots]) => {
        if (mounted) {
          registeredWalletRef.current = wallet;
          registeredWalletsRef.current = wallets;
          setRegisteredWallet(wallet);
          setRegisteredWallets(wallets);
          setWalletSnapshots(cachedSnapshots);
          walletSnapshotsRef.current = cachedSnapshots;
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
          setError(errorMessage(reason));
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
  }, []);

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
          const cachedHeight = Number(
            walletSnapshotsRef.current[registration.id]?.walletHeight,
          );
          syncStartHeightsRef.current.set(
            registration.id,
            Number.isFinite(cachedHeight) && cachedHeight > 0
              ? cachedHeight
              : nextSnapshot.walletHeight,
          );
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
          walletHeight: nextSnapshot.walletHeight,
          registrationId: registration.id,
        });
        return nextSnapshot;
      } catch (reason) {
        if (registeredWalletRef.current?.id === registration.id) {
          setError(errorMessage(reason));
        }
        logWalletEvent('WalletState', 'refreshSnapshot.error', {
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
        const nextTransactions = await walletService.getTransactions(
          openedSession,
          25,
        );
        transactionsByRegistrationRef.current.set(
          registration.id,
          nextTransactions,
        );
        queueIncomingTransactionNotices(
          incomingTransactionObserverRef.current.observe({
            walletId: registration.id,
            walletName: walletDisplayName(registration),
            transactions: nextTransactions,
          }),
        );
        if (registeredWalletRef.current?.id === registration.id) {
          setTransactions(nextTransactions);
        }
        return nextTransactions;
      } catch (reason) {
        logWalletEvent('WalletState', 'refreshTransactions.error', {
          error: errorMessage(reason),
          registrationId: registration.id,
        });
        return cached;
      } finally {
        transactionRefreshInFlightIdsRef.current.delete(registration.id);
      }
    },
    [queueIncomingTransactionNotices, shouldSkipLiveWalletRead],
  );

  const refreshSnapshot = useCallback(async () => {
    const activeRegistration = registeredWalletRef.current;
    const activeSession = sessionRef.current;
    if (!activeRegistration || !activeSession) {
      return undefined;
    }
    return refreshSessionSnapshot(activeRegistration, activeSession);
  }, [refreshSessionSnapshot]);

  const refreshTransactions = useCallback(async () => {
    const activeRegistration = registeredWalletRef.current;
    const activeSession = sessionRef.current;
    if (!activeRegistration || !activeSession) {
      setTransactions([]);
      return [];
    }
    return refreshSessionTransactions(activeRegistration, activeSession);
  }, [refreshSessionTransactions]);

  const refreshFastWalletsFromIncomingSignal = useCallback(
    async (event: FastWalletPushEvent, announceInitialTransactions = false) => {
      if (processedPushEventIdRef.current === event.eventId) {
        return;
      }
      processedPushEventIdRef.current = event.eventId;
      logWalletEvent('WalletState', 'incomingSignal.refresh.start');
      try {
        const refreshed =
          await walletService.refreshFastWalletsFromIncomingSignal();
        for (const result of refreshed) {
          const registration = registeredWalletsRef.current.find(
            wallet => wallet.id === result.registrationId,
          );
          queueIncomingTransactionNotices(
            incomingTransactionObserverRef.current.observe({
              walletId: result.registrationId,
              walletName: registration
                ? walletDisplayName(registration)
                : 'Fast Wallet',
              transactions: result.transactions,
              announceInitial: announceInitialTransactions,
            }),
          );
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
    [queueIncomingTransactionNotices],
  );

  useEffect(() => {
    let mounted = true;
    const handle = (
      event: FastWalletPushEvent,
      announceInitialTransactions = true,
    ) => {
      if (mounted) {
        refreshFastWalletsFromIncomingSignal(
          event,
          announceInitialTransactions,
        ).catch(() => undefined);
      }
    };
    const unsubscribe = FastWalletPushService.subscribe(handle);
    FastWalletPushService.getLastEvent()
      .then(event => {
        if (event) {
          handle(event, false);
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
      setHardwareStatus(undefined);
      return undefined;
    }
    if (hardwareRefreshInFlight.current) {
      logWalletEvent('WalletState', 'refreshHardwareWalletStatus.skipped', {
        reason: 'inFlight',
        walletId: activeSession.walletId,
      });
      return hardwareStatus;
    }

    hardwareRefreshInFlight.current = true;
    try {
      const nextStatus =
        await walletService.getHardwareWalletStatus(activeSession);
      setHardwareStatus(nextStatus);
      setError(undefined);
      return nextStatus;
    } catch (reason) {
      setError(errorMessage(reason));
      return undefined;
    } finally {
      hardwareRefreshInFlight.current = false;
    }
  }, [hardwareStatus]);

  const startNativeRefresh = useCallback(
    (openedSession: WalletSession, reason: string) => {
      const registrationId = sessionRegistrationId(openedSession);
      const registration = registeredWalletsRef.current.find(
        wallet => wallet.id === registrationId,
      );
      if (!registration || isFastWalletRegistration(registration)) {
        logWalletEvent('WalletState', 'startNativeRefresh.skipped', {
          reason: 'fastWalletUsesScannerSignals',
          walletId: openedSession.walletId,
        });
        return;
      }

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
      logWalletEvent('WalletState', 'startNativeRefresh.start', {
        reason,
        registrationId,
      });

      walletService
        .startRefresh(openedSession)
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
          if (registeredWalletRef.current?.id === registrationId) {
            setError(undefined);
          }
          logWalletEvent('WalletState', 'startNativeRefresh.success', {
            reason,
            registrationId,
          });
          refreshSessionSnapshot(registration, openedSession).catch(
            refreshError => {
              logWalletEvent(
                'WalletState',
                'startNativeRefresh.snapshotError',
                {
                  error: errorMessage(refreshError),
                  registrationId,
                },
              );
            },
          );
          refreshSessionTransactions(registration, openedSession).catch(
            refreshError => {
              logWalletEvent(
                'WalletState',
                'startNativeRefresh.transactionsError',
                {
                  error: errorMessage(refreshError),
                  registrationId,
                },
              );
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
      refreshSessionSnapshot,
      refreshSessionTransactions,
    ],
  );

  const lockWallet = useCallback(async () => {
    const openSessions = [...sessionsByRegistrationRef.current.values()];
    if (openSessions.length === 0) {
      return;
    }

    globallyLockedRef.current = true;
    logWalletEvent('WalletState', 'lockWallet.start', {
      walletCount: openSessions.length,
    });
    try {
      await Promise.all(
        openSessions.map(openedSession =>
          stopNativeRefresh(openedSession, 'manualLock'),
        ),
      );
      await Promise.all(
        openSessions.map(openedSession =>
          walletService.closeWallet(openedSession).catch(() => undefined),
        ),
      );
      sessionsByRegistrationRef.current.clear();
      autoOpenAttemptedWalletIdsRef.current.clear();
      sessionRef.current = undefined;
      setSession(undefined);
      setSnapshot(undefined);
      setTransactions([]);
      setHardwareStatus(undefined);
      setError(undefined);
      setUnlockRequestId(Date.now());
      logWalletEvent('WalletState', 'lockWallet.success', {
        walletCount: openSessions.length,
      });
    } catch (reason) {
      const message = errorMessage(reason);
      setError(message);
      logWalletEvent('WalletState', 'lockWallet.error', {
        error: message,
        walletCount: openSessions.length,
      });
      throw reason;
    }
  }, [stopNativeRefresh]);

  const reconnectHardwareWallet = useCallback(async () => {
    const activeSession = sessionRef.current;
    if (!activeSession?.hardwareDevice) {
      setHardwareStatus(undefined);
      return undefined;
    }

    try {
      const nextStatus =
        await walletService.reconnectHardwareWallet(activeSession);
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
      for (const timeout of nativeRefreshRetryTimeoutsRef.current.values()) {
        clearTimeout(timeout);
      }
      nativeRefreshRetryTimeoutsRef.current.clear();
      for (const openedSession of sessionsByRegistrationRef.current.values()) {
        void stopNativeRefresh(openedSession, 'unmount');
        void walletService.closeWallet(openedSession).catch(() => undefined);
      }
      sessionsByRegistrationRef.current.clear();
    },
    [stopNativeRefresh],
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
      if (isFastWalletRegistration(openedRegistration)) {
        throw new Error('Fast Wallet is synchronized by the scanner service');
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
      autoOpenAttemptedWalletIdsRef.current.add(openedRegistration.id);
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
      }
      setError(undefined);
      setUnlockRequestId(undefined);
      setLoadingRegistry(false);

      startNativeRefresh(registeredSession, 'sessionOpened');

      if (options?.refresh === false) {
        return;
      }

      await refreshSessionSnapshot(openedRegistration, registeredSession);
      await refreshSessionTransactions(openedRegistration, registeredSession);
      if (shouldSelect && registeredSession.hardwareDevice) {
        await refreshHardwareWalletStatus();
      }
    },
    [
      refreshHardwareWalletStatus,
      refreshSessionSnapshot,
      refreshSessionTransactions,
      startNativeRefresh,
      stopNativeRefresh,
    ],
  );

  const connectLedgerForSigning = useCallback(async () => {
    const activeSession = sessionRef.current;
    const activeRegistration = registeredWalletRef.current;
    if (!activeSession || !activeRegistration) {
      return undefined;
    }
    if (!activeSession.readOnly) {
      return activeSession;
    }
    if (activeRegistration.kind !== 'hardware') {
      throw new Error('The active wallet is not a Ledger wallet');
    }

    logWalletEvent('WalletState', 'connectLedgerForSigning.start', {
      walletId: activeSession.walletId,
      registrationId: activeRegistration.id,
    });
    await stopNativeRefresh(activeSession, 'ledgerSigningRequested');
    await walletService.closeWallet(activeSession);
    sessionsByRegistrationRef.current.delete(activeRegistration.id);
    sessionRef.current = undefined;
    setSession(undefined);
    setSnapshot(undefined);
    setTransactions([]);
    setHardwareStatus(undefined);

    try {
      const signingSession =
        await walletService.openHardwareWalletForSigning(activeRegistration);
      const registeredSigningSession = {
        ...signingSession,
        registrationId: activeRegistration.id,
      };
      sessionsByRegistrationRef.current.set(
        activeRegistration.id,
        registeredSigningSession,
      );
      walletService.activateSession(registeredSigningSession);
      sessionRef.current = registeredSigningSession;
      setSession(registeredSigningSession);
      setError(undefined);
      startNativeRefresh(registeredSigningSession, 'ledgerSigningConnected');
      logWalletEvent('WalletState', 'connectLedgerForSigning.success', {
        walletId: registeredSigningSession.walletId,
        registrationId: activeRegistration.id,
      });
      return registeredSigningSession;
    } catch (reason) {
      const message = errorMessage(reason);
      setError(message);
      logWalletEvent('WalletState', 'connectLedgerForSigning.error', {
        error: message,
        registrationId: activeRegistration.id,
      });

      // A cancelled or unavailable Ledger must not destroy the useful local
      // read-only session. Reopen it so balances and incoming transfers remain
      // available without requiring another user action.
      try {
        const readOnlySession =
          await walletService.openRegisteredWalletRegistration(
            activeRegistration,
          );
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
        startNativeRefresh(registeredReadOnlySession, 'ledgerSigningCancelled');
      } catch (restoreError) {
        logWalletEvent('WalletState', 'connectLedgerForSigning.restoreError', {
          error: errorMessage(restoreError),
          registrationId: activeRegistration.id,
        });
      }
      throw reason;
    }
  }, [startNativeRefresh, stopNativeRefresh]);

  useEffect(() => {
    if (loadingRegistry || globallyLockedRef.current) {
      return;
    }

    for (const wallet of registeredWallets) {
      const canOpenWithoutPrompt =
        (wallet.kind === 'software' && Boolean(wallet.credentialKey)) ||
        (wallet.kind === 'hardware' &&
          Boolean(wallet.viewOnlyPath && wallet.viewOnlyCredentialKey));
      if (
        isFastWalletRegistration(wallet) ||
        !canOpenWithoutPrompt ||
        sessionsByRegistrationRef.current.has(wallet.id) ||
        autoOpenAttemptedWalletIdsRef.current.has(wallet.id)
      ) {
        continue;
      }

      autoOpenAttemptedWalletIdsRef.current.add(wallet.id);
      logWalletEvent('WalletState', 'autoOpen.start', {
        walletId: wallet.id,
        walletName: wallet.walletName,
      });
      walletService
        .openRegisteredWalletRegistration(wallet)
        .then(openedSession =>
          registerOpenedSession(openedSession, wallet, {
            refresh: false,
            select: registeredWalletRef.current?.id === wallet.id,
          }),
        )
        .then(() => {
          logWalletEvent('WalletState', 'autoOpen.success', {
            walletId: wallet.id,
            walletName: wallet.walletName,
          });
        })
        .catch(reason => {
          const message = errorMessage(reason);
          if (registeredWalletRef.current?.id === wallet.id) {
            setError(message);
          }
          logWalletEvent('WalletState', 'autoOpen.error', {
            error: message,
            walletId: wallet.id,
            walletName: wallet.walletName,
          });
        });
    }
  }, [
    loadingRegistry,
    registerOpenedSession,
    registeredWallets,
    unlockRequestId,
  ]);

  useEffect(() => {
    const refreshOpenSessions = () => {
      for (const [
        registrationId,
        openedSession,
      ] of sessionsByRegistrationRef.current.entries()) {
        const registration = registeredWalletsRef.current.find(
          wallet => wallet.id === registrationId,
        );
        if (!registration || isFastWalletRegistration(registration)) {
          continue;
        }
        refreshSessionSnapshot(registration, openedSession).catch(
          () => undefined,
        );
        refreshSessionTransactions(registration, openedSession).catch(
          () => undefined,
        );
      }
      if (sessionRef.current?.hardwareDevice) {
        refreshHardwareWalletStatus().catch(() => undefined);
      }
    };

    refreshOpenSessions();
    const interval = setInterval(refreshOpenSessions, 5000);

    return () => {
      clearInterval(interval);
    };
  }, [
    refreshHardwareWalletStatus,
    refreshSessionSnapshot,
    refreshSessionTransactions,
  ]);

  const progress = presentWalletSync(snapshot, {
    startHeight: syncStartHeight,
  }).progress;
  const status = useMemo<WalletRuntimeStatus>(() => {
    if (loadingRegistry) {
      return 'loading';
    }

    if (isFastWalletRegistration(registeredWallet)) {
      return 'open';
    }

    if (error && !session) {
      return 'error';
    }

    if (session && snapshot) {
      return snapshot.synchronized ? 'open' : 'syncing';
    }

    if (session) {
      return 'opening';
    }

    if (registeredWallet) {
      return 'locked';
    }

    return 'empty';
  }, [error, loadingRegistry, registeredWallet, session, snapshot]);

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
      walletSnapshots,
      session,
      snapshot,
      transactions,
      incomingTransactionNotice,
      status,
      syncProgress: progress,
      syncStartHeight,
      unlockRequestId,
      isRegisteredWalletOpen,
      clearError: () => setError(undefined),
      dismissIncomingTransactionNotice,
      lockWallet,
      registerOpenedSession,
      reloadRegisteredWallet,
      reloadRegisteredWallets,
      setActiveRegisteredWallet: activateRegisteredWallet,
      renameRegisteredWallet,
      removeRegisteredWallet,
      refreshSnapshot,
      refreshTransactions,
      refreshHardwareWalletStatus,
      reconnectHardwareWallet,
      connectLedgerForSigning,
      showHardwareWalletAddress,
    }),
    [
      error,
      hardwareStatus,
      incomingTransactionNotice,
      isRegisteredWalletOpen,
      lockWallet,
      progress,
      syncStartHeight,
      reconnectHardwareWallet,
      connectLedgerForSigning,
      refreshHardwareWalletStatus,
      refreshSnapshot,
      refreshTransactions,
      registerOpenedSession,
      registeredWallet,
      registeredWallets,
      walletSnapshots,
      reloadRegisteredWallet,
      reloadRegisteredWallets,
      activateRegisteredWallet,
      renameRegisteredWallet,
      removeRegisteredWallet,
      session,
      showHardwareWalletAddress,
      snapshot,
      status,
      transactions,
      unlockRequestId,
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
