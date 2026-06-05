import { requireNativeMoneroWallet } from "./NativeMoneroWallet";
import {
  loadActiveNodeConnectionSettings,
  normalizeNodeConnectionSettings,
} from "./NodeConnectionSettings";
import type { NodeConnectionSettings } from "./NodeConnectionSettings";
import type {
  CreateWalletInput,
  DaemonConfig,
  MoneroNetwork,
  OpenWalletInput,
  RestoreWalletInput,
  WalletSnapshot,
} from "./NativeMoneroWallet";

export interface WalletSession {
  walletId: string;
  network: MoneroNetwork;
}

export class WalletService {
  private activeSession: WalletSession | undefined;

  async linkedWithMonero(): Promise<boolean> {
    return requireNativeMoneroWallet().linkedWithMonero();
  }

  async createWallet(input: CreateWalletInput): Promise<WalletSession> {
    const nativeWallet = requireNativeMoneroWallet();
    const result = await nativeWallet.createWallet(input);
    return this.configureOpenedSession({
      walletId: result.walletId,
      network: input.network,
    });
  }

  async restoreWallet(input: RestoreWalletInput): Promise<WalletSession> {
    const nativeWallet = requireNativeMoneroWallet();
    const result = await nativeWallet.restoreWallet(input);
    return this.configureOpenedSession({
      walletId: result.walletId,
      network: input.network,
    });
  }

  async openWallet(input: OpenWalletInput): Promise<WalletSession> {
    const nativeWallet = requireNativeMoneroWallet();
    const result = await nativeWallet.openWallet(input);
    return this.configureOpenedSession({
      walletId: result.walletId,
      network: input.network,
    });
  }

  async closeWallet(session: WalletSession, store = true): Promise<void> {
    await requireNativeMoneroWallet().closeWallet(session.walletId, store);
    if (this.activeSession?.walletId === session.walletId) {
      this.activeSession = undefined;
    }
  }

  async setDaemon(
    session: WalletSession,
    config: DaemonConfig,
  ): Promise<void> {
    await requireNativeMoneroWallet().setDaemon(session.walletId, config);
  }

  async setGrpcEndpoint(
    session: WalletSession,
    endpoint: string,
  ): Promise<void> {
    await requireNativeMoneroWallet().setGrpcEndpoint(
      session.walletId,
      endpoint,
    );
  }

  async applyNodeConnection(
    session: WalletSession,
    settings?: NodeConnectionSettings,
  ): Promise<void> {
    const resolvedSettings =
      settings ?? (await loadActiveNodeConnectionSettings(session.network));

    if (resolvedSettings.network !== session.network) {
      throw new Error(
        `Node settings network ${resolvedSettings.network} does not match wallet network ${session.network}`,
      );
    }

    const normalized = normalizeNodeConnectionSettings(resolvedSettings);
    await this.setDaemon(session, normalized.daemon);
    await this.setGrpcEndpoint(session, normalized.grpcEndpoint);
  }

  async applyNodeConnectionToActive(
    settings?: NodeConnectionSettings,
  ): Promise<boolean> {
    if (!this.activeSession) {
      return false;
    }

    await this.applyNodeConnection(this.activeSession, settings);
    return true;
  }

  getActiveSession(): WalletSession | undefined {
    if (!this.activeSession) {
      return undefined;
    }

    return {
      ...this.activeSession,
    };
  }

  async startRefresh(session: WalletSession): Promise<void> {
    await requireNativeMoneroWallet().startRefresh(session.walletId);
  }

  async stopRefresh(session: WalletSession): Promise<void> {
    await requireNativeMoneroWallet().stopRefresh(session.walletId);
  }

  async snapshot(session: WalletSession): Promise<WalletSnapshot> {
    return requireNativeMoneroWallet().snapshot(session.walletId);
  }

  async getAddress(
    session: WalletSession,
    accountIndex = 0,
    addressIndex = 0,
  ): Promise<string> {
    return requireNativeMoneroWallet().getAddress(
      session.walletId,
      accountIndex,
      addressIndex,
    );
  }

  async getBalance(session: WalletSession, accountIndex = 0): Promise<string> {
    return requireNativeMoneroWallet().getBalance(
      session.walletId,
      accountIndex,
    );
  }

  async getUnlockedBalance(
    session: WalletSession,
    accountIndex = 0,
  ): Promise<string> {
    return requireNativeMoneroWallet().getUnlockedBalance(
      session.walletId,
      accountIndex,
    );
  }

  private async configureOpenedSession(
    session: WalletSession,
  ): Promise<WalletSession> {
    try {
      await this.applyNodeConnection(session);
    } catch (error) {
      await this.closeWallet(session, false).catch(() => undefined);
      throw error;
    }

    this.activeSession = {
      ...session,
    };

    return session;
  }
}

export const walletService = new WalletService();
