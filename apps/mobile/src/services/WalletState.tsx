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
import { walletDisplayName, type RegisteredWallet } from './WalletRegistry';
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
};

export type WalletRuntimeStatus =
  | 'loading'
  | 'empty'
  | 'locked'
  | 'opening'
  | 'syncing'
  | 'open'
  | 'error';

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
  unlockRequestId: number | undefined;
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

function syncProgress(
  snapshot: WalletSnapshot | undefined,
): number | undefined {
  return presentWalletSync(snapshot).progress;
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
  const [snapshot, setSnapshot] = useState<WalletSnapshot | undefined>();
  const [transactions, setTransactions] = useState<WalletTransaction[]>([]);
  const [incomingTransactionNotice, setIncomingTransactionNotice] = useState<
    IncomingTransactionNotice | undefined
  >();
  const [unlockRequestId, setUnlockRequestId] = useState<number | undefined>();
  const [error, setError] = useState<string | undefined>();
  const sessionRef = useRef<WalletSession | undefined>(undefined);
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
  const autoOpenAttemptedWalletIdRef = useRef<string | undefined>(undefined);
  const nativeRefreshWalletIdRef = useRef<string | undefined>(undefined);
  const nativeRefreshReadyWalletIdRef = useRef<string | undefined>(undefined);
  const nativeRefreshRecoverUntilRef = useRef(0);
  const nativeRefreshGenerationRef = useRef(0);
  const nativeRefreshRetryAttemptRef = useRef(0);
  const nativeRefreshRetryTimeoutRef = useRef<
    ReturnType<typeof setTimeout> | undefined
  >(undefined);
  const snapshotRefreshInFlight = useRef(false);
  const transactionRefreshInFlight = useRef(false);
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

      nativeRefreshGenerationRef.current += 1;
      if (nativeRefreshRetryTimeoutRef.current) {
        clearTimeout(nativeRefreshRetryTimeoutRef.current);
        nativeRefreshRetryTimeoutRef.current = undefined;
      }
      if (nativeRefreshWalletIdRef.current === closingSession.walletId) {
        nativeRefreshWalletIdRef.current = undefined;
      }
      if (nativeRefreshReadyWalletIdRef.current === closingSession.walletId) {
        nativeRefreshReadyWalletIdRef.current = undefined;
      }
      nativeRefreshRecoverUntilRef.current = 0;
      nativeRefreshRetryAttemptRef.current = 0;
      logWalletEvent('WalletState', 'stopNativeRefresh.start', {
        reason,
        walletId: closingSession.walletId,
      });
      return walletService
        .stopRefresh(closingSession)
        .catch(stopError => {
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
      const recoveringForMs =
        nativeRefreshRecoverUntilRef.current > Date.now()
          ? nativeRefreshRecoverUntilRef.current - Date.now()
          : 0;
      if (recoveringForMs > 0) {
        logWalletEvent('WalletState', `${operation}.skipped`, {
          reason: 'nativeRefreshRecovering',
          recoverMs: Math.round(recoveringForMs),
          walletId: activeSession.walletId,
        });
        return true;
      }

      if (
        nativeRefreshWalletIdRef.current === activeSession.walletId &&
        nativeRefreshReadyWalletIdRef.current !== activeSession.walletId
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
    setLoadingRegistry(false);
    return wallets;
  }, []);

  const activateRegisteredWallet = useCallback(
    async (walletId: string) => {
      stopNativeRefresh(sessionRef.current, 'activeWalletChanged');
      // Selecting a saved wallet is an explicit user action.  Allow the
      // automatic local-credential opener to run again even when the same
      // wallet had previously been locked.
      autoOpenAttemptedWalletIdRef.current = undefined;
      const wallet = await walletService.setActiveRegisteredWallet(walletId);
      const wallets = await walletService.loadRegisteredWallets();
      registeredWalletRef.current = wallet;
      registeredWalletsRef.current = wallets;
      setRegisteredWallet(wallet);
      setRegisteredWallets(wallets);
      setSession(undefined);
      sessionRef.current = undefined;
      setSnapshot(undefined);
      setTransactions([]);
      setHardwareStatus(undefined);
      setError(undefined);
      setUnlockRequestId(undefined);
      setLoadingRegistry(false);
      return wallet;
    },
    [stopNativeRefresh],
  );

  const removeRegisteredWallet = useCallback(
    async (walletId: string) => {
      const removingActiveWallet = registeredWalletRef.current?.id === walletId;
      const wallets = await walletService.removeRegisteredWallet(walletId);
      const [active, cachedSnapshots] = await Promise.all([
        walletService.loadRegisteredWallet(),
        pruneWalletSnapshotCache(wallets.map(wallet => wallet.id)),
      ]);

      if (removingActiveWallet) {
        stopNativeRefresh(sessionRef.current, 'activeWalletRemoved');
        setSession(undefined);
        sessionRef.current = undefined;
        setSnapshot(undefined);
        setTransactions([]);
        setHardwareStatus(undefined);
      }

      registeredWalletRef.current = active;
      registeredWalletsRef.current = wallets;
      setRegisteredWallet(active);
      setRegisteredWallets(wallets);
      setWalletSnapshots(cachedSnapshots);
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
          pruneWalletSnapshotCache(wallets.map(item => item.id))
            .then(setWalletSnapshots)
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

  const refreshSnapshot = useCallback(async () => {
    const activeSession = sessionRef.current;
    if (!activeSession) {
      return undefined;
    }
    if (shouldSkipLiveWalletRead(activeSession, 'refreshSnapshot')) {
      return snapshot;
    }
    if (snapshotRefreshInFlight.current) {
      logWalletEvent('WalletState', 'refreshSnapshot.skipped', {
        reason: 'inFlight',
        walletId: activeSession.walletId,
      });
      return snapshot;
    }

    snapshotRefreshInFlight.current = true;
    try {
      const nextSnapshot = await walletService.snapshot(activeSession);
      logWalletEvent('WalletState', 'refreshSnapshot.success', {
        daemonHeight: nextSnapshot.daemonHeight,
        daemonTargetHeight: nextSnapshot.daemonTargetHeight,
        synchronized: nextSnapshot.synchronized,
        walletHeight: nextSnapshot.walletHeight,
        walletId: activeSession.walletId,
      });
      setSnapshot(nextSnapshot);
      const activeWallet = registeredWalletRef.current;
      if (activeWallet) {
        setWalletSnapshots(current => ({
          ...current,
          [activeWallet.id]: nextSnapshot,
        }));
        saveWalletSnapshot(activeWallet.id, nextSnapshot).catch(reason => {
          logWalletEvent('WalletState', 'refreshSnapshot.cacheError', {
            error: errorMessage(reason),
            walletId: activeWallet.id,
          });
        });
      }
      setError(undefined);
      return nextSnapshot;
    } catch (reason) {
      setError(errorMessage(reason));
      logWalletEvent('WalletState', 'refreshSnapshot.error', {
        error: errorMessage(reason),
        walletId: activeSession.walletId,
      });
      return undefined;
    } finally {
      snapshotRefreshInFlight.current = false;
    }
  }, [shouldSkipLiveWalletRead, snapshot]);

  const refreshTransactions = useCallback(async () => {
    const activeSession = sessionRef.current;
    if (!activeSession) {
      setTransactions([]);
      return [];
    }
    if (shouldSkipLiveWalletRead(activeSession, 'refreshTransactions')) {
      return transactions;
    }
    if (transactionRefreshInFlight.current) {
      logWalletEvent('WalletState', 'refreshTransactions.skipped', {
        reason: 'inFlight',
        walletId: activeSession.walletId,
      });
      return transactions;
    }

    transactionRefreshInFlight.current = true;
    try {
      const nextTransactions = await walletService.getTransactions(
        activeSession,
        25,
      );
      const uniqueTransactionCount = new Set(
        nextTransactions.map(transaction => transaction.hash),
      ).size;
      logWalletEvent('WalletState', 'refreshTransactions.success', {
        pendingTransactionCount: nextTransactions.filter(
          transaction => transaction.pending,
        ).length,
        transactionCount: nextTransactions.length,
        uniqueTransactionCount,
        walletId: activeSession.walletId,
      });
      const activeWallet = registeredWalletRef.current;
      queueIncomingTransactionNotices(
        incomingTransactionObserverRef.current.observe({
          walletId: activeWallet?.id ?? activeSession.walletId,
          walletName: activeWallet ? walletDisplayName(activeWallet) : 'Wallet',
          transactions: nextTransactions,
        }),
      );
      setTransactions(nextTransactions);
      setError(undefined);
      return nextTransactions;
    } catch (reason) {
      setError(errorMessage(reason));
      logWalletEvent('WalletState', 'refreshTransactions.error', {
        error: errorMessage(reason),
        walletId: activeSession.walletId,
      });
      return [];
    } finally {
      transactionRefreshInFlight.current = false;
    }
  }, [queueIncomingTransactionNotices, shouldSkipLiveWalletRead, transactions]);

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
            setWalletSnapshots(current => ({
              ...current,
              [result.registrationId]: result.snapshot!,
            }));
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
      const nextStatus = await walletService.getHardwareWalletStatus(
        activeSession,
      );
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
      if (nativeRefreshWalletIdRef.current === openedSession.walletId) {
        logWalletEvent('WalletState', 'startNativeRefresh.skipped', {
          reason: 'alreadyStarted',
          walletId: openedSession.walletId,
        });
        return;
      }

      const generation = nativeRefreshGenerationRef.current + 1;
      nativeRefreshGenerationRef.current = generation;
      nativeRefreshWalletIdRef.current = openedSession.walletId;
      nativeRefreshReadyWalletIdRef.current = undefined;
      nativeRefreshRecoverUntilRef.current = 0;
      if (nativeRefreshRetryTimeoutRef.current) {
        clearTimeout(nativeRefreshRetryTimeoutRef.current);
        nativeRefreshRetryTimeoutRef.current = undefined;
      }
      logWalletEvent('WalletState', 'startNativeRefresh.start', {
        reason,
        walletId: openedSession.walletId,
      });

      walletService
        .startRefresh(openedSession)
        .then(() => {
          if (
            nativeRefreshGenerationRef.current !== generation ||
            sessionRef.current?.walletId !== openedSession.walletId
          ) {
            logWalletEvent('WalletState', 'startNativeRefresh.stale', {
              reason,
              walletId: openedSession.walletId,
            });
            return;
          }

          setError(undefined);
          nativeRefreshRetryAttemptRef.current = 0;
          nativeRefreshReadyWalletIdRef.current = openedSession.walletId;
          logWalletEvent('WalletState', 'startNativeRefresh.success', {
            reason,
            walletId: openedSession.walletId,
          });
          refreshSnapshot().catch(refreshError => {
            logWalletEvent('WalletState', 'startNativeRefresh.snapshotError', {
              error: errorMessage(refreshError),
              walletId: openedSession.walletId,
            });
          });
          refreshTransactions().catch(refreshError => {
            logWalletEvent(
              'WalletState',
              'startNativeRefresh.transactionsError',
              {
                error: errorMessage(refreshError),
                walletId: openedSession.walletId,
              },
            );
          });
          refreshHardwareWalletStatus().catch(refreshError => {
            logWalletEvent('WalletState', 'startNativeRefresh.hardwareError', {
              error: errorMessage(refreshError),
              walletId: openedSession.walletId,
            });
          });
        })
        .catch(reasonError => {
          if (
            nativeRefreshGenerationRef.current !== generation ||
            sessionRef.current?.walletId !== openedSession.walletId
          ) {
            return;
          }

          nativeRefreshReadyWalletIdRef.current = undefined;
          setError(errorMessage(reasonError));
          const retryAttempt = nativeRefreshRetryAttemptRef.current + 1;
          nativeRefreshRetryAttemptRef.current = retryAttempt;
          const retryDelayMs = Math.min(
            30_000,
            5_000 * 2 ** Math.min(retryAttempt - 1, 3),
          );
          nativeRefreshWalletIdRef.current = undefined;
          nativeRefreshRecoverUntilRef.current =
            Date.now() + retryDelayMs + 5_000;
          logWalletEvent('WalletState', 'startNativeRefresh.error', {
            error: errorMessage(reasonError),
            reason,
            walletId: openedSession.walletId,
          });
          logWalletEvent('WalletState', 'startNativeRefresh.retryScheduled', {
            previousError: errorMessage(reasonError),
            retryAttempt,
            retryDelayMs,
            walletId: openedSession.walletId,
          });
          nativeRefreshRetryTimeoutRef.current = setTimeout(() => {
            nativeRefreshRetryTimeoutRef.current = undefined;
            if (sessionRef.current?.walletId !== openedSession.walletId) {
              logWalletEvent('WalletState', 'startNativeRefresh.retrySkipped', {
                reason: 'sessionChanged',
                walletId: openedSession.walletId,
              });
              return;
            }

            startNativeRefresh(openedSession, 'retryAfterError');
          }, retryDelayMs);
        });
    },
    [refreshHardwareWalletStatus, refreshSnapshot, refreshTransactions],
  );

  const lockWallet = useCallback(async () => {
    const activeSession = sessionRef.current;
    if (!activeSession) {
      return;
    }

    logWalletEvent('WalletState', 'lockWallet.start', {
      walletId: activeSession.walletId,
    });
    stopNativeRefresh(activeSession, 'manualLock');
    try {
      await walletService.closeWallet(activeSession);
      // Prevent the background auto-open path from immediately undoing a
      // conscious lock action. The UI redirects to the explicit unlock sheet.
      autoOpenAttemptedWalletIdRef.current =
        registeredWalletRef.current?.id ?? activeSession.walletId;
      sessionRef.current = undefined;
      setSession(undefined);
      setSnapshot(undefined);
      setTransactions([]);
      setHardwareStatus(undefined);
      setError(undefined);
      setUnlockRequestId(Date.now());
      logWalletEvent('WalletState', 'lockWallet.success', {
        walletId: activeSession.walletId,
      });
    } catch (reason) {
      startNativeRefresh(activeSession, 'lockFailed');
      const message = errorMessage(reason);
      setError(message);
      logWalletEvent('WalletState', 'lockWallet.error', {
        error: message,
        walletId: activeSession.walletId,
      });
      throw reason;
    }
  }, [startNativeRefresh, stopNativeRefresh]);

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
      stopNativeRefresh(sessionRef.current, 'unmount');
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
      const previousSession = sessionRef.current;
      if (previousSession?.walletId !== openedSession.walletId) {
        stopNativeRefresh(previousSession, 'sessionReplaced');
      }

      walletService.activateSession(openedSession);
      sessionRef.current = openedSession;
      setSession(openedSession);
      setSnapshot(undefined);
      setTransactions([]);
      setHardwareStatus(undefined);
      setError(undefined);
      setUnlockRequestId(undefined);
      startNativeRefresh(openedSession, 'sessionOpened');

      if (registration) {
        registeredWalletRef.current = registration;
        setRegisteredWallet(registration);
        setRegisteredWallets(current => {
          const wallets = current.some(wallet => wallet.id === registration.id)
            ? current.map(wallet =>
                wallet.id === registration.id ? registration : wallet,
              )
            : [...current, registration];
          registeredWalletsRef.current = wallets;
          return wallets;
        });
        setLoadingRegistry(false);
      } else {
        const wallet = await reloadRegisteredWallet();
        registeredWalletRef.current = wallet;
      }

      if (options?.refresh === false) {
        return;
      }

      await refreshSnapshot();
      await refreshTransactions();
      await refreshHardwareWalletStatus();
    },
    [
      refreshHardwareWalletStatus,
      refreshSnapshot,
      refreshTransactions,
      reloadRegisteredWallet,
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
    sessionRef.current = undefined;
    setSession(undefined);
    setSnapshot(undefined);
    setTransactions([]);
    setHardwareStatus(undefined);

    try {
      const signingSession =
        await walletService.openHardwareWalletForSigning(activeRegistration);
      walletService.activateSession(signingSession);
      sessionRef.current = signingSession;
      setSession(signingSession);
      setError(undefined);
      startNativeRefresh(signingSession, 'ledgerSigningConnected');
      logWalletEvent('WalletState', 'connectLedgerForSigning.success', {
        walletId: signingSession.walletId,
        registrationId: activeRegistration.id,
      });
      return signingSession;
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
        const readOnlySession = await walletService.openRegisteredWallet();
        walletService.activateSession(readOnlySession);
        sessionRef.current = readOnlySession;
        setSession(readOnlySession);
        startNativeRefresh(readOnlySession, 'ledgerSigningCancelled');
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
    if (
      loadingRegistry ||
      sessionRef.current ||
      !registeredWallet?.credentialKey ||
      registeredWallet.kind === 'hardware' ||
      autoOpenAttemptedWalletIdRef.current === registeredWallet.id
    ) {
      return;
    }

    autoOpenAttemptedWalletIdRef.current = registeredWallet.id;
    logWalletEvent('WalletState', 'autoOpen.start', {
      walletId: registeredWallet.id,
      walletName: registeredWallet.walletName,
    });
    walletService
      .openRegisteredWallet()
      .then(openedSession =>
        registerOpenedSession(openedSession, undefined, { refresh: false }),
      )
      .then(() => {
        logWalletEvent('WalletState', 'autoOpen.success', {
          walletId: registeredWallet.id,
          walletName: registeredWallet.walletName,
        });
      })
      .catch(reason => {
        const message = errorMessage(reason);
        setError(message);
        logWalletEvent('WalletState', 'autoOpen.error', {
          error: message,
          walletId: registeredWallet.id,
          walletName: registeredWallet.walletName,
        });
      });
  }, [loadingRegistry, registerOpenedSession, registeredWallet]);

  useEffect(() => {
    sessionRef.current = session;
    if (!session) {
      return undefined;
    }

    const interval = setInterval(() => {
      refreshSnapshot().catch(() => undefined);
      refreshTransactions().catch(() => undefined);
      refreshHardwareWalletStatus().catch(() => undefined);
    }, 5000);

    return () => {
      clearInterval(interval);
    };
  }, [
    refreshHardwareWalletStatus,
    refreshSnapshot,
    refreshTransactions,
    session,
  ]);

  const progress = syncProgress(snapshot);
  const status = useMemo<WalletRuntimeStatus>(() => {
    if (loadingRegistry) {
      return 'loading';
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
      unlockRequestId,
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
      lockWallet,
      progress,
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
