import type { TurboModule } from "react-native";
import { TurboModuleRegistry } from "react-native";

export type WalletSnapshot = {
  id: string;
  path: string;
  primaryAddress: string;
  balanceAtomic: string;
  unlockedBalanceAtomic: string;
  walletHeight: number;
  daemonHeight: number;
  daemonTargetHeight: number;
  synchronized: boolean;
};

export interface Spec extends TurboModule {
  linkedWithMonero(): Promise<boolean>;

  createWallet(
    path: string,
    password: string,
    language: string,
    network: string,
  ): Promise<string>;

  restoreWallet(
    path: string,
    password: string,
    mnemonic: string,
    seedOffset: string,
    network: string,
    restoreHeight: number,
  ): Promise<string>;

  openWallet(path: string, password: string, network: string): Promise<string>;

  closeWallet(walletId: string, storeFlag: number): Promise<void>;

  setDaemon(
    walletId: string,
    address: string,
    trustedFlag: number,
    useSslFlag: number,
    username: string,
    password: string,
    proxyAddress: string,
  ): Promise<void>;

  setGrpcEndpoint(walletId: string, endpoint: string): Promise<void>;

  startRefresh(walletId: string): Promise<void>;

  stopRefresh(walletId: string): Promise<void>;

  getAddress(
    walletId: string,
    accountIndex: number,
    addressIndex: number,
  ): Promise<string>;

  getBalance(walletId: string, accountIndex: number): Promise<string>;

  getUnlockedBalance(walletId: string, accountIndex: number): Promise<string>;

  snapshot(walletId: string): Promise<WalletSnapshot>;
}

export default TurboModuleRegistry.get<Spec>("NativeMoneroWallet");
