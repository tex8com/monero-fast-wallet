import NativeMoneroWalletTurbo from "../../specs/NativeMoneroWallet";
import type { WalletSnapshot } from "../../specs/NativeMoneroWallet";

export type MoneroNetwork = "mainnet" | "testnet" | "stagenet";

export interface CreateWalletInput {
  path: string;
  password: string;
  language?: string;
  network: MoneroNetwork;
}

export interface RestoreWalletInput {
  path: string;
  password: string;
  mnemonic: string;
  seedOffset?: string;
  network: MoneroNetwork;
  restoreHeight?: number;
}

export interface OpenWalletInput {
  path: string;
  password: string;
  network: MoneroNetwork;
}

export interface DaemonConfig {
  address: string;
  trusted: boolean;
  useSsl?: boolean;
  username?: string;
  password?: string;
  proxyAddress?: string;
}

export type { WalletSnapshot };

export interface NativeMoneroWalletModule {
  linkedWithMonero(): Promise<boolean>;
  createWallet(input: CreateWalletInput): Promise<{ walletId: string }>;
  restoreWallet(input: RestoreWalletInput): Promise<{ walletId: string }>;
  openWallet(input: OpenWalletInput): Promise<{ walletId: string }>;
  closeWallet(walletId: string, store?: boolean): Promise<void>;
  setDaemon(walletId: string, config: DaemonConfig): Promise<void>;
  setGrpcEndpoint(walletId: string, endpoint: string): Promise<void>;
  startRefresh(walletId: string): Promise<void>;
  stopRefresh(walletId: string): Promise<void>;
  getAddress(
    walletId: string,
    accountIndex?: number,
    addressIndex?: number,
  ): Promise<string>;
  getBalance(walletId: string, accountIndex?: number): Promise<string>;
  getUnlockedBalance(walletId: string, accountIndex?: number): Promise<string>;
  snapshot(walletId: string): Promise<WalletSnapshot>;
}

const turboModule = NativeMoneroWalletTurbo;

const nativeModule: NativeMoneroWalletModule | undefined = turboModule
  ? {
      linkedWithMonero: () => turboModule.linkedWithMonero(),
      createWallet: async input => ({
        walletId: await turboModule.createWallet(
          input.path,
          input.password,
          input.language ?? "English",
          input.network,
        ),
      }),
      restoreWallet: async input => ({
        walletId: await turboModule.restoreWallet(
          input.path,
          input.password,
          input.mnemonic,
          input.seedOffset ?? "",
          input.network,
          input.restoreHeight ?? 0,
        ),
      }),
      openWallet: async input => ({
        walletId: await turboModule.openWallet(
          input.path,
          input.password,
          input.network,
        ),
      }),
      closeWallet: (walletId, store = true) =>
        turboModule.closeWallet(walletId, store ? 1 : 0),
      setDaemon: (walletId, config) =>
        turboModule.setDaemon(
          walletId,
          config.address,
          config.trusted ? 1 : 0,
          config.useSsl ? 1 : 0,
          config.username ?? "",
          config.password ?? "",
          config.proxyAddress ?? "",
        ),
      setGrpcEndpoint: (walletId, endpoint) =>
        turboModule.setGrpcEndpoint(walletId, endpoint),
      startRefresh: walletId => turboModule.startRefresh(walletId),
      stopRefresh: walletId => turboModule.stopRefresh(walletId),
      getAddress: (walletId, accountIndex = 0, addressIndex = 0) =>
        turboModule.getAddress(
          walletId,
          accountIndex,
          addressIndex,
        ),
      getBalance: (walletId, accountIndex = 0) =>
        turboModule.getBalance(walletId, accountIndex),
      getUnlockedBalance: (walletId, accountIndex = 0) =>
        turboModule.getUnlockedBalance(walletId, accountIndex),
      snapshot: walletId => turboModule.snapshot(walletId),
    }
  : undefined;

export function requireNativeMoneroWallet(): NativeMoneroWalletModule {
  if (!nativeModule) {
    throw new Error("NativeMoneroWallet is not linked yet");
  }

  return nativeModule;
}
