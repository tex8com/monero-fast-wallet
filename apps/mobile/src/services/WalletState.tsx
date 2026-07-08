import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import type {
  HardwareWalletStatus,
  WalletTransaction,
  WalletSnapshot,
} from "./NativeMoneroWallet";
import type { RegisteredWallet } from "./WalletRegistry";
import { walletService, type WalletSession } from "./WalletService";

type RegisterOpenedSessionOptions = {
  refresh?: boolean;
};

export type WalletRuntimeStatus =
  | "loading"
  | "empty"
  | "locked"
  | "opening"
  | "syncing"
  | "open"
  | "error";

interface WalletStateValue {
  error: string | undefined;
  registeredWallet: RegisteredWallet | undefined;
  registeredWallets: RegisteredWallet[];
  hardwareStatus: HardwareWalletStatus | undefined;
  session: WalletSession | undefined;
  snapshot: WalletSnapshot | undefined;
  transactions: WalletTransaction[];
  status: WalletRuntimeStatus;
  syncProgress: number | undefined;
  clearError: () => void;
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
  refreshSnapshot: () => Promise<WalletSnapshot | undefined>;
  refreshTransactions: () => Promise<WalletTransaction[]>;
  refreshHardwareWalletStatus: () => Promise<HardwareWalletStatus | undefined>;
  reconnectHardwareWallet: () => Promise<HardwareWalletStatus | undefined>;
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

function syncProgress(snapshot: WalletSnapshot | undefined): number | undefined {
  if (!snapshot) {
    return undefined;
  }

  const targetHeight =
    snapshot.daemonTargetHeight > 0
      ? snapshot.daemonTargetHeight
      : snapshot.daemonHeight;

  if (targetHeight <= 0) {
    return undefined;
  }

  return Math.max(
    0,
    Math.min(100, Math.floor((snapshot.walletHeight / targetHeight) * 100)),
  );
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
  const [snapshot, setSnapshot] = useState<WalletSnapshot | undefined>();
  const [transactions, setTransactions] = useState<WalletTransaction[]>([]);
  const [error, setError] = useState<string | undefined>();
  const sessionRef = useRef<WalletSession | undefined>(undefined);

  const reloadRegisteredWallet = useCallback(async () => {
    const [wallet, wallets] = await Promise.all([
      walletService.loadRegisteredWallet(),
      walletService.loadRegisteredWallets(),
    ]);
    setRegisteredWallet(wallet);
    setRegisteredWallets(wallets);
    setLoadingRegistry(false);
    return wallet;
  }, []);

  const reloadRegisteredWallets = useCallback(async () => {
    const wallets = await walletService.loadRegisteredWallets();
    const active = await walletService.loadRegisteredWallet();
    setRegisteredWallets(wallets);
    setRegisteredWallet(active);
    setLoadingRegistry(false);
    return wallets;
  }, []);

  const activateRegisteredWallet = useCallback(async (walletId: string) => {
    const wallet = await walletService.setActiveRegisteredWallet(walletId);
    const wallets = await walletService.loadRegisteredWallets();
    setRegisteredWallet(wallet);
    setRegisteredWallets(wallets);
    setSession(undefined);
    sessionRef.current = undefined;
    setSnapshot(undefined);
    setTransactions([]);
    setHardwareStatus(undefined);
    setError(undefined);
    setLoadingRegistry(false);
    return wallet;
  }, []);

  useEffect(() => {
    let mounted = true;
    Promise.all([
      walletService.loadRegisteredWallet(),
      walletService.loadRegisteredWallets(),
    ])
      .then(([wallet, wallets]) => {
        if (mounted) {
          setRegisteredWallet(wallet);
          setRegisteredWallets(wallets);
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

    try {
      const nextSnapshot = await walletService.snapshot(activeSession);
      setSnapshot(nextSnapshot);
      setError(undefined);
      return nextSnapshot;
    } catch (reason) {
      setError(errorMessage(reason));
      return undefined;
    }
  }, []);

  const refreshTransactions = useCallback(async () => {
    const activeSession = sessionRef.current;
    if (!activeSession) {
      setTransactions([]);
      return [];
    }

    try {
      const nextTransactions = await walletService.getTransactions(
        activeSession,
        25,
      );
      setTransactions(nextTransactions);
      setError(undefined);
      return nextTransactions;
    } catch (reason) {
      setError(errorMessage(reason));
      return [];
    }
  }, []);

  const refreshHardwareWalletStatus = useCallback(async () => {
    const activeSession = sessionRef.current;
    if (!activeSession?.hardwareDevice) {
      setHardwareStatus(undefined);
      return undefined;
    }

    try {
      const nextStatus =
        await walletService.getHardwareWalletStatus(activeSession);
      setHardwareStatus(nextStatus);
      setError(undefined);
      return nextStatus;
    } catch (reason) {
      setError(errorMessage(reason));
      return undefined;
    }
  }, []);

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

  const showHardwareWalletAddress = useCallback(
    async (accountIndex = 0, addressIndex = 0, paymentId = "") => {
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
      sessionRef.current = openedSession;
      setSession(openedSession);
      setSnapshot(undefined);
      setTransactions([]);
      setHardwareStatus(undefined);
      setError(undefined);

      if (registration) {
        setRegisteredWallet(registration);
        setRegisteredWallets(current =>
          current.some(wallet => wallet.id === registration.id)
            ? current.map(wallet =>
                wallet.id === registration.id ? registration : wallet,
              )
            : [...current, registration],
        );
        setLoadingRegistry(false);
      } else {
        await reloadRegisteredWallet();
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
    ],
  );

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
      return "loading";
    }

    if (error && !session) {
      return "error";
    }

    if (session && snapshot) {
      return snapshot.synchronized ? "open" : "syncing";
    }

    if (session) {
      return "opening";
    }

    if (registeredWallet) {
      return "locked";
    }

    return "empty";
  }, [error, loadingRegistry, registeredWallet, session, snapshot]);

  const value = useMemo<WalletStateValue>(
    () => ({
      error,
      registeredWallet,
      registeredWallets,
      hardwareStatus,
      session,
      snapshot,
      transactions,
      status,
      syncProgress: progress,
      clearError: () => setError(undefined),
      registerOpenedSession,
      reloadRegisteredWallet,
      reloadRegisteredWallets,
      setActiveRegisteredWallet: activateRegisteredWallet,
      refreshSnapshot,
      refreshTransactions,
      refreshHardwareWalletStatus,
      reconnectHardwareWallet,
      showHardwareWalletAddress,
    }),
    [
      error,
      hardwareStatus,
      progress,
      reconnectHardwareWallet,
      refreshHardwareWalletStatus,
      refreshSnapshot,
      refreshTransactions,
      registerOpenedSession,
      registeredWallet,
      registeredWallets,
      reloadRegisteredWallet,
      reloadRegisteredWallets,
      activateRegisteredWallet,
      session,
      showHardwareWalletAddress,
      snapshot,
      status,
      transactions,
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
    throw new Error("useWalletState must be used inside WalletStateProvider");
  }

  return value;
}
