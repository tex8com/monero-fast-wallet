import { invoke } from '@tauri-apps/api/core';
import { checkPermissions, getCurrentPosition, requestPermissions } from '@tauri-apps/plugin-geolocation';
import QRCode from 'qrcode';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { presentWalletSync } from '../../../packages/wallet-shared/src/walletSync';
import { useI18n } from './i18n';
import {
  desktopNotificationStatus,
  disableDesktopFastWalletSignals,
  enableDesktopFastWalletSignals,
  sendPrivacySafeNotificationTest,
  type DesktopNotificationStatus,
} from './fastWalletNotifications';
import { type MarketPoint, type MarketTimeframe, useXmrChart, useXmrPrice } from './marketData';
import { useMoneroUpdates } from './moneroUpdates';
import { restoreHeightFromStartDate, todayRestoreDate } from './restoreStart';
import { removeDesktopWalletAddresses, upsertDesktopWalletAddress } from './walletAddressRegistry';
import { loadRecipientContacts, loadRecentRecipients, rememberRecipient, type RecipientContact } from './recipientAddressBook';
import DesktopRecipientQrScanner from './DesktopRecipientQrScanner';

type Section = 'home' | 'wallets' | 'setup' | 'send' | 'receive' | 'activity' | 'community' | 'assistant' | 'settings' | 'menu';
type Network = 'mainnet' | 'testnet' | 'stagenet';
type SetupMode = 'create' | 'restore' | 'open' | 'ledger';
type WalletCoreStatus = { linked: boolean; releaseReady: boolean; backend: string; message: string };
type RegisteredWallet = { id: string; displayName?: string; walletName: string; network: Network; kind: string; seedBackupStatus: 'pending' | 'verified' | 'not-required'; restoreHeight?: number; accountIndex?: number; addressIndex?: number; role?: 'standard' | 'fast'; sourceWalletId?: string; createdAt: number; lastOpenedAt: number; isOpen?: boolean; isActive?: boolean };
type WalletOperationResponse = { walletId: string; wallet: RegisteredWallet };
type LedgerTransportStatus = { platform: string; transport: 'ble'; supported: boolean; available: boolean; permissionGranted: boolean; requiresUserAction: boolean; deviceCount: number; message: string };
type SetupRequest = { walletName: string; network: Network; mode: 'open' } | null;
type SeedBackup = { nativeWalletId: string; wallet: RegisteredWallet; seed: string };
type NativeSubaddress = { accountIndex: number; addressIndex: number; address: string; label: string };
type NativePreparedTransaction = { id: string; status: string; error: string; amountAtomic: string; dustAtomic: string; feeAtomic: string; txCount: string; txIds: string[]; subaddressAccounts: number[]; subaddressIndices: number[] };
type NativeTransaction = { hash: string; paymentId: string; description: string; label: string; direction: string; pending: boolean; failed: boolean; coinbase: boolean; amountAtomic: string; feeAtomic: string; blockHeight: string; confirmations: string; unlockTime: string; timestamp: string; subaddressAccount: number; subaddressIndices: number[]; transfers: Array<{ amountAtomic: string; address: string }> };
type NativeHardwareWalletStatus = { walletId: string; deviceName: string; deviceType: string; connected: boolean; requiresUserAction: boolean; promptKind: string; promptCode: string; progress: number; indeterminate: boolean };
type NativeWalletSnapshot = { id: string; primaryAddress: string; balanceAtomic: string; unlockedBalanceAtomic: string; walletHeight: string; daemonHeight: string; daemonTargetHeight: string; synchronized: boolean };
type CommunityProfile = { identityId: string; displayName: string; bio: string; visible: boolean; radiusKm: number };
type CommunityNearby = CommunityProfile & { approximateDistanceKm: number; relationship: 'none' | 'outgoing' | 'incoming' | 'connected' };
type CommunityContact = CommunityProfile & { status: 'outgoing' | 'incoming' | 'connected' };
type CommunityMessage = { id: string; senderId: string; recipientId: string; body: string; sentAtMs: number };
type FastWalletRecord = { id: string; label: string; address: string; network: Network; sourceRegistrationId: string; restoreHeight: number; derivationIndex: number; status: 'local-only' | 'enabled' | 'disabled' | 'registration-error' | 'server-mismatch'; scannerStatus: string; scannerUrl: string; scannerCheckedAt?: number; lastScannedHeight?: number; notificationsEnabled: boolean; createdAt: number; updatedAt: number };
type FastWalletOpenResponse = { walletId: string; wallet: FastWalletRecord };
type NodeProfile = { mode: 'optimized-grpc' | 'original-rpc' | 'custom'; network: Network; daemonAddress: string; grpcEndpoint: string; trusted: boolean; useSsl: boolean; username: string; proxyAddress: string; passwordStored: boolean; updatedAt: number };
type SettingsDiagnostic = { label: string; value: string; tone?: 'good' | 'warning' | 'neutral' };

type NavigationItem = { id: Section; label: string; icon: string };

function primarySections(t: ReturnType<typeof useI18n>['t']): NavigationItem[] { return [
  { id: 'home', label: t('nav.home'), icon: '⌂' }, { id: 'send', label: t('nav.send'), icon: '↑' },
  { id: 'receive', label: t('nav.receive'), icon: '↓' }, { id: 'community', label: t('nav.community'), icon: '◎' },
  { id: 'menu', label: t('nav.menu'), icon: '☰' },
]; }
function secondarySections(_t: ReturnType<typeof useI18n>['t']): NavigationItem[] { return []; }

function statusLabel(status: WalletCoreStatus | null, t: ReturnType<typeof useI18n>['t']) { return !status ? t('shell.coreChecking') : status.linked ? t('shell.coreReady') : t('shell.coreRequired'); }
function errorMessage(reason: unknown, fallback: string) {
  if (reason instanceof Error && reason.message.trim()) return reason.message;
  if (typeof reason === 'string' && reason.trim()) return reason;
  if (reason && typeof reason === 'object' && 'message' in reason) {
    const message = (reason as { message?: unknown }).message;
    if (typeof message === 'string' && message.trim()) return message;
  }
  return fallback;
}
function networkLabel(network: Network) { return network === 'mainnet' ? 'Mainnet' : network === 'testnet' ? 'Testnet' : 'Stagenet'; }
function walletDisplayName(wallet: Pick<RegisteredWallet, 'displayName' | 'walletName'>) { return wallet.displayName?.trim() || wallet.walletName; }
function notificationDeliveryLabel(status: DesktopNotificationStatus | null, t: ReturnType<typeof useI18n>['t']) {
  if (!status) return t('settings.deliveryChecking');
  if (status.delivery === 'closed-app-apns') return t('settings.deliveryApns');
  if (status.delivery === 'background-windows-agent') return t('settings.deliveryWindowsAgent');
  if (status.delivery === 'background-linux-agent') return t('settings.deliveryLinuxAgent');
  if (status.delivery === 'disabled') return t('settings.deliveryDisabled');
  return status.providerStatus === 'not-configured' ? t('settings.deliveryNotConfigured', { provider: status.provider }) : t('settings.deliveryLocal');
}
function parseNativeJson<T>(value: string, fallback: string): T { try { return JSON.parse(value) as T; } catch { throw new Error(fallback); } }
function nativeHeight(value: string | number | undefined) {
  const height = Number(value);
  return Number.isFinite(height) && height > 0 ? Math.floor(height) : undefined;
}
function syncLabel(snapshot: NativeWalletSnapshot | null, t?: ReturnType<typeof useI18n>['t'], startHeight?: number) {
  const sync = presentWalletSync(snapshot, { startHeight });
  if (sync.phase === 'synchronized') return `${t ? t('home.syncComplete') : 'Synchronized'} · 100%`;
  if (sync.phase === 'waiting-for-node') return t ? t('home.syncConnecting') : 'Connecting node';
  if (sync.phase === 'finalizing') return `${t ? t('home.syncUpdating') : 'Updating history'} · ${snapshot?.walletHeight ?? 0}/${sync.targetHeight}`;
  return `${t ? t('home.syncScanning') : 'Scanning blocks'} · ${snapshot?.walletHeight ?? 0}/${sync.targetHeight}`;
}
const ATOMIC_XMR = 1_000_000_000_000n;
function atomicValue(value: string | undefined) { try { return BigInt(value ?? '0'); } catch { return 0n; } }
function formatAtomicXmr(value: string | undefined, fractionDigits = 4) { const atomic = atomicValue(value); const sign = atomic < 0n ? '-' : ''; const absolute = atomic < 0n ? -atomic : atomic; const whole = absolute / ATOMIC_XMR; const fraction = (absolute % ATOMIC_XMR).toString().padStart(12, '0').slice(0, fractionDigits).replace(/0+$/, ''); return `${sign}${whole.toString()}${fraction ? `.${fraction}` : ''}`; }
function parseXmrToAtomic(value: string) { const normalized = value.trim().replace(',', '.'); if (!/^(?:0|[1-9]\d*)(?:\.\d{1,12})?$/.test(normalized)) return null; const [whole, fraction = ''] = normalized.split('.'); return (BigInt(whole) * ATOMIC_XMR + BigInt(fraction.padEnd(12, '0'))).toString(); }
function isLikelyMoneroAddress(value: string) { return /^[1-9A-HJ-NP-Za-km-z]{90,110}$/.test(value.trim()); }
function atomicXmrNumber(value: string | undefined) { return Number(atomicValue(value)) / Number(ATOMIC_XMR); }
function formatUsd(value: number) { return new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value); }
function syncProgress(snapshot: NativeWalletSnapshot | null, startHeight?: number) { return presentWalletSync(snapshot, { startHeight }).progress; }
function shortHash(value: string) { return value.length > 20 ? `${value.slice(0, 10)}…${value.slice(-8)}` : value; }
function transactionTimestamp(value: string) { const timestamp = Number(value); return Number.isFinite(timestamp) && timestamp > 0 ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(timestamp * 1000)) : 'Time not available'; }
function approximateAreaForCoordinates(latitude: number, longitude: number) { const alphabet = '0123456789bcdefghjkmnpqrstuvwxyz'; let latitudeRange: [number, number] = [-90, 90]; let longitudeRange: [number, number] = [-180, 180]; let bits = 0; let value = 0; let useLongitude = true; let result = ''; while (result.length < 5) { const range = useLongitude ? longitudeRange : latitudeRange; const coordinate = useLongitude ? longitude : latitude; const midpoint = (range[0] + range[1]) / 2; value = value * 2 + (coordinate >= midpoint ? 1 : 0); if (coordinate >= midpoint) range[0] = midpoint; else range[1] = midpoint; useLongitude = !useLongitude; bits += 1; if (bits === 5) { result += alphabet[value]; bits = 0; value = 0; } } return result; }
function communityTimestamp(value: number) { return Number.isFinite(value) && value > 0 ? new Intl.DateTimeFormat(undefined, { dateStyle: 'short', timeStyle: 'short' }).format(new Date(value)) : 'Time not available'; }

export default function App() {
  const { t } = useI18n();
  const [section, setSection] = useState<Section>('home');
  const [activeWalletId, setActiveWalletId] = useState<string | null>(null);
  const [activeWallet, setActiveWallet] = useState<RegisteredWallet | null>(null);
  const [wallets, setWallets] = useState<RegisteredWallet[]>([]);
  const [setupRequest, setSetupRequest] = useState<SetupRequest>(null);
  const [seedBackup, setSeedBackup] = useState<SeedBackup | null>(null);
  const [status, setStatus] = useState<WalletCoreStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [autoLockEnabled, setAutoLockEnabled] = useState(() => window.localStorage.getItem('tex8-monero-auto-lock') !== 'false');
  const primaryNavigation = useMemo(() => primarySections(t), [t]);
  const secondaryNavigation = useMemo(() => secondarySections(t), [t]);
  const active = useMemo(() => [...primaryNavigation, ...secondaryNavigation].find((item) => item.id === section), [primaryNavigation, secondaryNavigation, section]);

  const reloadWallets = useCallback(async () => {
    try {
      const refreshed = await invoke<RegisteredWallet[]>('list_registered_wallets');
      setWallets(refreshed);
      setActiveWallet(current =>
        current ? refreshed.find(wallet => wallet.id === current.id) ?? current : current,
      );
    }
    catch (reason) { setError(errorMessage(reason, 'The local wallet list could not be loaded.')); }
  }, []);

  useEffect(() => {
    let mounted = true;
    invoke<WalletCoreStatus>('wallet_core_status').then((value) => mounted && setStatus(value)).catch(() => mounted && setError('The desktop host could not verify the native wallet core.'));
    reloadWallets();
    return () => { mounted = false; };
  }, [reloadWallets]);

  const activateWallet = useCallback(async (result: WalletOperationResponse) => {
    setActiveWalletId(result.walletId); setActiveWallet(result.wallet); setSeedBackup(null); setError(null); setSection('home'); await reloadWallets();
  }, [reloadWallets]);
  const activateOpenWallet = async (wallet: RegisteredWallet) => {
    try { await activateWallet(await invoke<WalletOperationResponse>('activate_registered_wallet', { walletId: wallet.id })); }
    catch (reason) { setError(errorMessage(reason, 'The wallet could not be made active.')); }
  };
  const startSetup = (request: SetupRequest = null) => { setSetupRequest(request); setSection('setup'); };
  const openSavedWallet = (wallet: RegisteredWallet) => {
    if (wallet.isOpen) { void activateOpenWallet(wallet); return; }
    startSetup({ walletName: wallet.walletName, network: wallet.network, mode: 'open' });
  };
  const revealRecoverySeed = async (wallet = activeWallet, walletId = activeWalletId) => {
    if (!wallet || !walletId) return;
    try {
      const seed = await invoke<string>('wallet_recovery_seed', { input: { walletId } });
      setSeedBackup({ nativeWalletId: walletId, wallet, seed });
    } catch (reason) { setError(errorMessage(reason, 'The recovery seed could not be read from the native wallet.')); }
  };
  const createdWallet = async (result: WalletOperationResponse) => {
    await activateWallet(result);
    await revealRecoverySeed(result.wallet, result.walletId);
  };
  const confirmSeedBackup = async () => {
    if (!seedBackup) return;
    try {
      const updated = await invoke<RegisteredWallet>('mark_wallet_seed_backed_up', { walletId: seedBackup.wallet.id });
      setActiveWallet(updated); setSeedBackup(null); await reloadWallets();
    } catch (reason) { setError(errorMessage(reason, 'The seed backup status could not be saved.')); }
  };
  const closeActiveWallet = useCallback(async () => {
    if (!activeWalletId) return;
    const walletToUnlock = activeWallet;
    try {
      await invoke<void>('close_wallet', { input: { walletId: activeWalletId } });
      setActiveWalletId(null); setActiveWallet(null); setSeedBackup(null); await reloadWallets();
      // Locking must never strand the user on an unrelated overview. Go
      // straight to the small, dedicated open flow for the wallet they chose
      // to lock so reopening is a single, obvious action.
      if (walletToUnlock) {
        setSetupRequest({ walletName: walletToUnlock.walletName, network: walletToUnlock.network, mode: 'open' });
        setSection('setup');
      }
    } catch (reason) { setError(errorMessage(reason, 'The wallet could not be locked.')); }
  }, [activeWallet, activeWalletId, reloadWallets]);
  const removeWallet = useCallback(async (wallet: RegisteredWallet) => {
    const removingActiveWallet = activeWallet?.id === wallet.id;
    try {
      await invoke<void>('remove_registered_wallet', { input: { walletId: wallet.id } });
      removeDesktopWalletAddresses(wallet.id);
      if (removingActiveWallet) {
        setActiveWalletId(null);
        setActiveWallet(null);
        setSeedBackup(null);
      }
      await reloadWallets();
    } catch (reason) {
      setError(errorMessage(reason, 'The wallet could not be removed from this app.'));
      throw reason;
    }
  }, [activeWallet?.id, reloadWallets]);
  const linked = Boolean(status?.linked);

  useEffect(() => { window.localStorage.setItem('tex8-monero-auto-lock', autoLockEnabled ? 'true' : 'false'); }, [autoLockEnabled]);
  useEffect(() => {
    if (!autoLockEnabled || !activeWalletId) return;
    let timer: number | undefined;
    const cancel = () => { if (timer !== undefined) { window.clearTimeout(timer); timer = undefined; } };
    const schedule = () => { cancel(); timer = window.setTimeout(() => void closeActiveWallet(), 5 * 60 * 1000); };
    const visibility = () => { if (document.visibilityState === 'hidden') schedule(); else cancel(); };
    window.addEventListener('blur', schedule); window.addEventListener('focus', cancel); document.addEventListener('visibilitychange', visibility);
    return () => { cancel(); window.removeEventListener('blur', schedule); window.removeEventListener('focus', cancel); document.removeEventListener('visibilitychange', visibility); };
  }, [activeWalletId, autoLockEnabled, closeActiveWallet]);
  return <main className="app-shell">
    <aside className="sidebar" aria-label="Main navigation">
      <div className="brand"><img className="brand-mark" src="/monero-mark.png" alt="" /><div><strong>Monero<span>Fast Wallet</span></strong><small>{t('shell.desktop')}</small></div></div>
      <nav>{primaryNavigation.map((item) => <NavItem item={item} active={section} onSelect={setSection} key={item.id} />)}</nav>
      {secondaryNavigation.length > 0 && <><div className="sidebar-divider" /><nav>{secondaryNavigation.map((item) => <NavItem item={item} active={section} onSelect={setSection} key={item.id} />)}</nav></>}
      <p className="sidebar-note">Developed with <span aria-label="love">❤️</span> by <a href="https://solutions.tex8.com/en" target="_blank" rel="noreferrer">TEX8</a></p>
    </aside>
    <section className="content">
      {section !== 'setup' && <header className="topbar"><div><p className="eyebrow">{active?.label ?? t('common.wallet')}</p><h1>{section === 'home' ? t('shell.homeTitle') : active?.label}</h1></div><div className="topbar-actions"><DesktopWalletSwitcher wallets={wallets} activeWallet={activeWallet} onSelect={openSavedWallet} onManage={() => setSection('wallets')} /><div className="topbar-connection" title={statusLabel(status, t)}><div className={linked ? 'core-status ready' : 'core-status'}><span />{linked ? t('shell.coreOnline') : status ? t('shell.coreRequired') : t('shell.coreChecking')}</div></div></div></header>}
      {!linked && <section className="notice" role="status"><div className="notice-icon"><img src="/monero-mark.png" alt="" /></div><div><h2>{t('shell.noticeEngineTitle')}</h2><p>{error ?? status?.message ?? t('shell.noticeEngineVerifying')}</p></div></section>}
      {linked && error && <section className="notice compact-notice" role="alert"><div><h2>{t('shell.noticeActionNeeded')}</h2><p>{error}</p></div></section>}
      {section === 'home' && <Home linked={linked} walletId={activeWalletId} wallet={activeWallet} savedWallets={wallets} onSetup={startSetup} onWallets={() => setSection('wallets')} onBackup={() => void revealRecoverySeed()} onLock={() => void closeActiveWallet()} onSend={() => setSection('send')} onReceive={() => setSection('receive')} onActivity={() => setSection('activity')} />}
      {section === 'wallets' && <Wallets linked={linked} walletId={activeWalletId} wallets={wallets} activeWallet={activeWallet} onSetup={startSetup} onOpen={openSavedWallet} onOpened={(result) => void activateWallet(result)} onRenamed={() => void reloadWallets()} onRemove={removeWallet} onActivity={() => setSection('activity')} />}
      {section === 'setup' && <Setup key={setupRequest ? `${setupRequest.walletName}-${setupRequest.network}` : 'new-wallet'} linked={linked} initial={setupRequest} wallets={wallets} onSelectSaved={openSavedWallet} onOpened={(result) => void activateWallet(result)} onCreated={(result) => void createdWallet(result)} />}
      {section === 'send' && <Send linked={linked} walletId={activeWalletId} wallet={activeWallet} onActivity={() => setSection('activity')} />}
      {section === 'receive' && <Receive linked={linked} walletId={activeWalletId} wallet={activeWallet} onActivity={() => setSection('activity')} />}
      {section === 'activity' && <Activity linked={linked} walletId={activeWalletId} wallet={activeWallet} />}
      {section === 'community' && <Community />}
      {section === 'assistant' && <Assistant wallet={activeWallet} walletId={activeWalletId} onNavigate={setSection} />}
      {section === 'settings' && <LeanSettings status={status} walletId={activeWalletId} wallet={activeWallet} onRevealSeed={() => void revealRecoverySeed()} onCloseWallet={() => void closeActiveWallet()} autoLockEnabled={autoLockEnabled} onAutoLockChange={setAutoLockEnabled} />}
      {section === 'menu' && <DesktopMenu wallet={activeWallet} walletId={activeWalletId} onNavigate={setSection} />}
      {seedBackup && <RecoverySeedOverlay wallet={seedBackup.wallet} seed={seedBackup.seed} onConfirm={() => void confirmSeedBackup()} onDismiss={() => setSeedBackup(null)} />}
    </section>
  </main>;
}

function NavItem({ item, active, onSelect }: { item: { id: Section; label: string; icon: string }; active: Section; onSelect: (section: Section) => void }) { return <button className={item.id === active ? 'nav-item active' : 'nav-item'} onClick={() => onSelect(item.id)} type="button"><span>{item.icon}</span>{item.label}</button>; }

function DesktopWalletSwitcher({ wallets, activeWallet, onSelect, onManage }: { wallets: RegisteredWallet[]; activeWallet: RegisteredWallet | null; onSelect: (wallet: RegisteredWallet) => void; onManage: () => void }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const selected = activeWallet ?? wallets.find((wallet) => wallet.isActive) ?? wallets[0] ?? null;
  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false); };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, []);
  const manage = () => { setOpen(false); onManage(); };
  const selectWallet = (wallet: RegisteredWallet) => { setOpen(false); onSelect(wallet); };

  return <div className="desktop-wallet-switcher-wrap">
    <button className="desktop-wallet-switcher" aria-expanded={open} aria-haspopup="menu" onClick={() => wallets.length ? setOpen((value) => !value) : manage()} type="button">
      <img src="/monero-mark.png" alt="" />
      <span><strong>{selected ? walletDisplayName(selected) : t('home.addWallet')}</strong><small>{selected ? `${selected.kind === 'hardware' ? t('wallets.ledger') : t('wallets.software')} · ${networkLabel(selected.network)}` : t('home.noWallets')}</small></span>
      <em aria-hidden="true">⌄</em>
    </button>
    {open && <div className="desktop-wallet-menu" role="menu" aria-label={t('wallets.saved')}>
      <header><strong>{t('wallets.saved')}</strong><button className="quiet-button" onClick={manage} type="button">{t('home.manageWallets')}</button></header>
      <div className="desktop-wallet-menu-list">{wallets.map((wallet) => {
        const isActive = wallet.id === activeWallet?.id;
        const action = isActive ? t('wallets.active') : wallet.isOpen ? t('wallets.use') : t('wallets.unlock');
        return <button className={isActive ? 'desktop-wallet-menu-row active' : 'desktop-wallet-menu-row'} key={wallet.id} onClick={() => selectWallet(wallet)} role="menuitem" type="button">
          <span className="desktop-wallet-menu-mark"><img src="/monero-mark.png" alt="" /></span>
          <span className="desktop-wallet-menu-copy"><strong>{walletDisplayName(wallet)}</strong><small>{wallet.kind === 'hardware' ? t('wallets.ledger') : t('wallets.software')} · {networkLabel(wallet.network)}</small></span>
          <em>{action}</em>
        </button>;
      })}</div>
      <button className="desktop-wallet-add" onClick={manage} type="button"><span>＋</span>{t('home.addWallet')}</button>
    </div>}
  </div>;
}

function DesktopMenu({ wallet, walletId, onNavigate }: { wallet: RegisteredWallet | null; walletId: string | null; onNavigate: (section: Section) => void }) {
  const { t } = useI18n();
  const [address, setAddress] = useState<string | null>(null);
  useEffect(() => {
    let mounted = true;
    if (!walletId) { setAddress(null); return () => { mounted = false; }; }
    void invoke<string>('wallet_address', { input: { walletId, accountIndex: wallet?.accountIndex ?? 0 } })
      .then((value) => { if (mounted) setAddress(value); })
      .catch(() => { if (mounted) setAddress(null); });
    return () => { mounted = false; };
  }, [wallet?.accountIndex, walletId]);
  const items: Array<{ section: Section; icon: string; title: string; hint: string }> = [
    { section: 'wallets', icon: '◈', title: t('menu.wallets'), hint: t('menu.walletsHint') },
    { section: 'community', icon: '◎', title: t('menu.community'), hint: t('menu.communityHint') },
    { section: 'settings', icon: '⚙', title: t('menu.settings'), hint: t('menu.settingsHint') },
    { section: 'assistant', icon: '✦', title: t('menu.assistant'), hint: t('menu.assistantHint') },
    { section: 'settings', icon: '◌', title: t('menu.node'), hint: t('menu.nodeHint') },
  ];
  const addressLabel = address ? `${address.slice(0, 6)}…${address.slice(-5)}` : wallet ? t('menu.openWallet') : t('menu.noWallet');
  return <section className="desktop-menu-page"><header className="desktop-menu-profile"><img src="/monero-mark.png" alt="" /><div><h2>{wallet ? walletDisplayName(wallet) : t('menu.title')}</h2><code>{addressLabel}</code></div></header><div className="desktop-menu-list">{items.map((item, index) => <button key={`${item.section}-${index}`} onClick={() => onNavigate(item.section)} type="button"><span className="desktop-menu-icon">{item.icon}</span><span><strong>{item.title}</strong><small>{item.hint}</small></span><em>›</em></button>)}</div></section>;
}

function marketChartTimestamp(timestamp: number) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(timestamp));
}

function MarketChart({ points, positive, onRetry }: { points: MarketPoint[]; positive: boolean; onRetry: () => void }) {
  const { t } = useI18n();
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const geometry = useMemo(() => {
    if (points.length < 2) return null;
    const width = 960;
    const height = 248;
    const padding = 8;
    const prices = points.map((point) => point.price);
    const minimum = Math.min(...prices) * 0.998;
    const maximum = Math.max(...prices) * 1.002;
    const range = maximum - minimum || 1;
    const step = (width - padding * 2) / (points.length - 1);
    const yFor = (value: number) => padding + (height - padding * 2) - ((value - minimum) / range) * (height - padding * 2);
    let line = '';
    let area = '';
    points.forEach((point, index) => {
      const x = padding + index * step;
      const y = yFor(point.price);
      if (index === 0) {
        line = `M${x} ${y}`;
        area = `M${x} ${height}L${x} ${y}`;
        return;
      }
      const previousX = padding + (index - 1) * step;
      const previousY = yFor(points[index - 1].price);
      const curve = `C${previousX + step * 0.4} ${previousY} ${x - step * 0.4} ${y} ${x} ${y}`;
      line += curve;
      area += curve;
    });
    const finalX = padding + (points.length - 1) * step;
    return { area: `${area}L${finalX} ${height}Z`, line, x: finalX, y: yFor(points.at(-1)?.price ?? 0), yFor };
  }, [points]);

  if (!geometry) return <div className="market-chart-empty"><span>{t('home.chartUnavailable')}</span><button className="quiet-button" onClick={onRetry} type="button">{t('home.chartRetry')}</button></div>;
  const color = positive ? '#00d68f' : '#ff5c76';
  const activeIndex = Math.min(hoverIndex ?? points.length - 1, points.length - 1);
  const activePoint = points[activeIndex];
  const activeX = 8 + ((960 - 16) * activeIndex) / (points.length - 1);
  const activeY = geometry.yFor(activePoint.price);
  const tooltipPosition = Math.min(92, Math.max(8, (activeX / 960) * 100));
  const selectPoint = (clientX: number, bounds: DOMRect) => setHoverIndex(Math.min(points.length - 1, Math.max(0, Math.round(((clientX - bounds.left) / bounds.width) * (points.length - 1)))));
  return <div className="market-chart-interactive"><svg className="market-chart" viewBox="0 0 960 248" preserveAspectRatio="none" role="img" aria-label={t('home.chartAria')}><defs><linearGradient id="market-chart-area" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor={color} stopOpacity="0.24" /><stop offset="1" stopColor={color} stopOpacity="0" /></linearGradient></defs><path d={geometry.area} fill="url(#market-chart-area)" /><path d={geometry.line} fill="none" stroke={color} strokeWidth="3" vectorEffect="non-scaling-stroke" /><rect x="0" y="0" width="960" height="248" fill="transparent" onPointerMove={(event) => selectPoint(event.clientX, event.currentTarget.getBoundingClientRect())} onPointerLeave={() => setHoverIndex(null)} />{hoverIndex !== null && <><line x1={activeX} x2={activeX} y1="0" y2="248" stroke="#d7d0e4" strokeOpacity="0.38" strokeWidth="1" vectorEffect="non-scaling-stroke" /><circle cx={activeX} cy={activeY} r="5.5" fill="#171322" stroke={color} strokeWidth="3" vectorEffect="non-scaling-stroke" /></>}<circle cx={geometry.x} cy={geometry.y} r="5" fill={color} /></svg>{hoverIndex !== null && <div className="market-chart-tooltip" style={{ left: `${tooltipPosition}%` }} role="status"><strong>{formatUsd(activePoint.price)}</strong><span>{marketChartTimestamp(activePoint.timestamp)}</span></div>}</div>;
}

function Home({ linked, walletId, wallet, savedWallets, onSetup, onWallets, onBackup, onLock, onSend, onReceive, onActivity }: { linked: boolean; walletId: string | null; wallet: RegisteredWallet | null; savedWallets: RegisteredWallet[]; onSetup: () => void; onWallets: () => void; onBackup: () => void; onLock: () => void; onSend: () => void; onReceive: () => void; onActivity: () => void }) {
  const { t } = useI18n();
  const [timeframe, setTimeframe] = useState<MarketTimeframe>('24H');
  const [snapshot, setSnapshot] = useState<NativeWalletSnapshot | null>(null);
  const [transactions, setTransactions] = useState<NativeTransaction[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const snapshotRefreshInFlight = useRef(false);
  // A wallet can be selected repeatedly while it is already scanning. Keep a
  // per-wallet baseline so the visible progress describes this refresh, not
  // the full chain since genesis (which is what caused 97-99% on reopen).
  const walletSnapshotsRef = useRef(new Map<string, NativeWalletSnapshot>());
  const syncStartHeightsRef = useRef(new Map<string, number>());
  const { price, change24h, loading: priceLoading } = useXmrPrice();
  const { points, loading: chartLoading, refresh: refreshChart } = useXmrChart(timeframe);
  const { items: officialUpdates, loading: updatesLoading, unavailable: updatesUnavailable, refresh: refreshUpdates } = useMoneroUpdates();

  const accountIndex = wallet?.accountIndex ?? 0;
  const loadSnapshot = useCallback(async (startRefresh = false) => {
    if (!walletId) return;
    if (snapshotRefreshInFlight.current) return;
    snapshotRefreshInFlight.current = true;
    try {
      if (startRefresh) {
        const previousHeight = nativeHeight(walletSnapshotsRef.current.get(walletId)?.walletHeight);
        if (previousHeight) syncStartHeightsRef.current.set(walletId, previousHeight);
      }
      if (startRefresh) await invoke<void>('start_wallet_refresh', { input: { walletId } });
      const raw = await invoke<string>('wallet_snapshot', { input: { walletId, accountIndex } });
      const nextSnapshot = parseNativeJson<NativeWalletSnapshot>(raw, 'The native wallet snapshot was invalid.');
      walletSnapshotsRef.current.set(walletId, nextSnapshot);
      const nextHeight = nativeHeight(nextSnapshot.walletHeight);
      if (nextHeight && (nextSnapshot.synchronized || !syncStartHeightsRef.current.has(walletId))) {
        syncStartHeightsRef.current.set(walletId, nextHeight);
      }
      setSnapshot(nextSnapshot);
      setMessage(startRefresh ? 'Local wallet refresh started.' : null);
    } catch (reason) { setMessage(errorMessage(reason, 'Could not read wallet state.')); }
    finally { snapshotRefreshInFlight.current = false; }
  }, [accountIndex, walletId]);
  const loadTransactions = useCallback(async () => {
    if (!walletId) return;
    try {
      const raw = await invoke<string>('wallet_transactions', { input: { walletId, accountIndex } });
      setTransactions(parseNativeJson<NativeTransaction[]>(raw, 'The native transaction history was invalid.'));
    } catch (reason) { setMessage(errorMessage(reason, 'Could not read wallet activity.')); }
  }, [accountIndex, walletId]);
  const refreshWallet = async () => { await Promise.all([loadSnapshot(true), loadTransactions()]); };

  useEffect(() => {
    if (!walletId) { setSnapshot(null); setTransactions([]); return; }
    // Match the mobile WalletState refresh contract: start the core refresh
    // when a wallet opens, then keep the displayed snapshot live. The native
    // core remains the source of truth for the final synchronized state.
    void loadSnapshot(true);
    void loadTransactions();
    const snapshotTimer = window.setInterval(() => void loadSnapshot(), 5_000);
    const transactionTimer = window.setInterval(() => void loadTransactions(), 5_000);
    return () => { window.clearInterval(snapshotTimer); window.clearInterval(transactionTimer); };
  }, [loadSnapshot, loadTransactions, walletId]);

  const positive = timeframe === '24H' ? change24h >= 0 : points.length < 2 || points.at(-1)!.price >= points[0].price;
  const changePercent = timeframe === '24H' ? change24h : points.length >= 2 ? ((points.at(-1)!.price - points[0].price) / points[0].price) * 100 : 0;
  const changeUsd = price > 0 ? Math.abs((changePercent / 100) * price) : 0;
  const balanceAtomic = snapshot?.balanceAtomic ?? '0';
  const unlockedAtomic = snapshot?.unlockedBalanceAtomic ?? '0';
  const lockedAtomic = atomicValue(balanceAtomic) - atomicValue(unlockedAtomic);
  const balanceXmr = formatAtomicXmr(balanceAtomic);
  const lockedXmr = formatAtomicXmr(lockedAtomic.toString());
  const balanceUsd = price > 0 ? formatUsd(atomicXmrNumber(balanceAtomic) * price) : '—';
  const syncStartHeight = walletId ? syncStartHeightsRef.current.get(walletId) : undefined;
  const progress = syncProgress(snapshot, syncStartHeight);
  const sync = presentWalletSync(snapshot, { startHeight: syncStartHeight });
  const hasMeasuredProgress = sync.phase === 'syncing' && (progress ?? 0) > 1;
  const syncWorking = Boolean(walletId) && sync.phase !== 'synchronized';
  const routeToWalletAction = (action: () => void) => {
    if (walletId && linked) { action(); return; }
    if (savedWallets.length) { onWallets(); return; }
    onSetup();
  };

  return <div className="home-stack home-dashboard">
    <section className="market-card">
      <div className="market-card-head"><div><p className="eyebrow">{t('home.liveMarket')}</p><h2>{priceLoading ? t('home.priceLoading') : price > 0 ? formatUsd(price) : t('home.marketUnavailable')}</h2>{price > 0 && <p className={positive ? 'market-change positive' : 'market-change negative'}><span>{positive ? '▲' : '▼'} {Math.abs(changePercent).toFixed(2)}%</span><span>{positive ? '+' : '-'}{formatUsd(changeUsd)}</span></p>}</div><img className="market-mark" src="/monero-mark.png" alt="Monero" /></div>
      <div className="market-chart-wrap">{chartLoading && points.length < 2 ? <div className="market-chart-empty">{t('home.chartLoading')}</div> : <MarketChart points={points} positive={positive} onRetry={refreshChart} />}</div>
      <div className="market-timeframes" aria-label="Market chart timeframe">{(['24H', '7D', '1M', '1Y', 'Max'] as MarketTimeframe[]).map((item) => <button className={timeframe === item ? 'selected' : ''} onClick={() => setTimeframe(item)} key={item} type="button">{item}</button>)}</div>
    </section>

    <section className="official-updates" aria-label={t('home.updatesTitle')}>
      <header><div><p className="eyebrow">{t('home.updatesSource')}</p><h2>{t('home.updatesTitle')}</h2></div><a href="https://github.com/monero-project/monero/releases" target="_blank" rel="noreferrer">{t('home.updatesSourceLink')} ↗</a></header>
      {updatesLoading && officialUpdates.length === 0 ? <p className="official-updates-status">{t('home.updatesLoading')}</p> : updatesUnavailable && officialUpdates.length === 0 ? <div className="official-updates-status"><span>{t('home.updatesUnavailable')}</span><button className="quiet-button" onClick={refreshUpdates} type="button">{t('home.chartRetry')}</button></div> : <div className="official-updates-list">{officialUpdates.map((item) => <a href={item.url} key={item.id} target="_blank" rel="noreferrer"><strong>{item.title}</strong><small>{new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(new Date(item.publishedAt))}</small><em>›</em></a>)}</div>}
    </section>

    <div className="home-main-grid">
      <section className="wallet-overview-card">
        <div className="wallet-overview-heading"><div><p className="eyebrow">{t('home.totalBalance')}</p><h2>{walletId ? `${balanceXmr} XMR` : '— XMR'}</h2></div><strong>{walletId ? balanceUsd : t('home.openWallet')}</strong></div>
        {walletId && lockedAtomic > 0n && <p className="wallet-locked"><span />{lockedXmr} XMR locked</p>}
        <p>{walletId ? `${t('home.nativeBalance')}${wallet ? ` · ${walletDisplayName(wallet)}` : ''}.` : savedWallets.length ? t('home.savedBalance') : t('home.begin')}</p>
        {!walletId && <button className="secondary" onClick={savedWallets.length ? onWallets : onSetup} type="button">{savedWallets.length ? t('home.openWallet') : t('home.createOrImport')}</button>}
      </section>

      <section className={snapshot?.synchronized ? 'wallet-sync-card ready' : 'wallet-sync-card'}>
        <div className="wallet-sync-heading"><div><strong>{wallet ? walletDisplayName(wallet) : t('home.sync')}</strong><small>{wallet ? `${networkLabel(wallet.network)} · ${wallet.kind === 'hardware' ? t('common.ledger') : t('wallets.software')}` : t('home.noWalletOpen')}</small></div>{walletId ? <button className="quiet-button" onClick={() => void refreshWallet()} type="button">{t('common.refresh')}</button> : <button className="quiet-button" onClick={savedWallets.length ? onWallets : onSetup} type="button">{t('home.openWallet')}</button>}</div>
        <div className="sync-reading"><span className={snapshot?.synchronized ? 'sync-led ready' : 'sync-led'} /> <strong>{walletId ? syncLabel(snapshot, t, syncStartHeight) : t('home.waiting')}</strong><em className={syncWorking && !hasMeasuredProgress ? 'sync-working' : ''}>{walletId ? snapshot?.synchronized ? '100%' : hasMeasuredProgress ? `${progress}%` : '…' : ''}</em></div>
        {(snapshot?.synchronized || hasMeasuredProgress) && <div className="sync-track"><span className={snapshot?.synchronized ? 'ready' : ''} style={{ width: `${snapshot?.synchronized ? 100 : progress}%` }} /></div>}
      </section>
    </div>

    <section className="home-quick-actions" aria-label="Wallet actions"><button onClick={() => routeToWalletAction(onSend)} type="button"><span>↑</span><strong>{t('nav.send')}</strong><small>{t('home.sendDetail')}</small></button><button onClick={() => routeToWalletAction(onReceive)} type="button"><span>↓</span><strong>{t('nav.receive')}</strong><small>{t('home.receiveDetail')}</small></button></section>

    <section className="home-wallets"><header><div><p className="eyebrow">{t('home.allWallets')}</p><h2>{t('home.yourWallets')}</h2></div><button className="quiet-button" onClick={onWallets} type="button">{t('home.manageWallets')}</button></header>{savedWallets.length ? <div className="wallet-strip">{savedWallets.map((item) => { const active = item.id === wallet?.id; return <button className={active ? 'wallet-mini-card active' : 'wallet-mini-card'} onClick={onWallets} key={item.id} type="button"><span>{walletDisplayName(item)}</span><small>{item.kind === 'hardware' ? 'LEDGER' : networkLabel(item.network).toUpperCase()}</small><strong>{active && walletId ? `${balanceXmr} XMR` : item.isOpen ? t('home.openLocal') : t('home.openToCheck')}</strong></button>; })}<button className="wallet-mini-card add" onClick={onSetup} type="button"><span>＋</span><strong>{t('home.addWallet')}</strong></button></div> : <div className="home-empty"><p>{t('home.noWallets')}</p><button className="primary" onClick={onSetup} type="button">{t('home.addWallet')}</button></div>}</section>

    <RecentTransactions hasOpenWallet={Boolean(walletId)} items={transactions} onActivity={() => routeToWalletAction(onActivity)} />

    {wallet?.kind === 'hardware' && walletId && <HardwareWalletCard walletId={walletId} />}
    {wallet?.seedBackupStatus === 'pending' && walletId && <section className="backup-warning"><div><p className="eyebrow">{t('home.securityStep')}</p><h2>{t('home.backupSeed')}</h2><p>{t('home.backupNote')}</p></div><button className="primary" onClick={onBackup} type="button">{t('home.showSeed')}</button></section>}
    {walletId && <div className="home-lock-row"><button className="quiet-button" onClick={onLock} type="button">{t('home.lock', { name: wallet ? walletDisplayName(wallet) : t('common.wallet') })}</button>{message && <p className="setup-message">{message}</p>}</div>}
  </div>;
}

function RecentTransactions({ hasOpenWallet, items, onActivity }: { hasOpenWallet: boolean; items: NativeTransaction[]; onActivity: () => void }) {
  const { t } = useI18n();
  return <section className="home-transactions recent-transactions"><header><div><p className="eyebrow">{t('home.activity')}</p><h2>{t('home.transactions')}</h2></div><button className="quiet-button" onClick={onActivity} type="button">{t('home.viewMore')}</button></header>{hasOpenWallet && items.length ? <div className="home-transaction-list">{items.slice(0, 3).map((item) => <button className="home-transaction-row" key={`${item.hash}-${item.direction}-${item.timestamp}`} onClick={onActivity} type="button"><span className={item.direction === 'in' ? 'home-transaction-icon incoming' : 'home-transaction-icon'}>{item.direction === 'in' ? '↓' : '↑'}</span><span><strong>{item.direction === 'in' ? t('home.received') : t('home.sent')} · {item.direction === 'in' ? '+' : '-'}{formatAtomicXmr(item.amountAtomic)} XMR</strong><small>{shortHash(item.hash)} · {transactionTimestamp(item.timestamp)}</small></span><em>{item.failed ? t('home.failed') : item.pending ? t('home.pending') : t('home.confirmed')}</em></button>)}</div> : <div className="home-empty"><p>{hasOpenWallet ? t('home.noTransactions') : t('home.openForActivity')}</p></div>}</section>;
}

function Wallets({ linked, walletId, wallets, activeWallet, onSetup, onOpen, onOpened, onRenamed, onRemove, onActivity }: { linked: boolean; walletId: string | null; wallets: RegisteredWallet[]; activeWallet: RegisteredWallet | null; onSetup: () => void; onOpen: (wallet: RegisteredWallet) => void; onOpened: (result: WalletOperationResponse) => void; onRenamed: () => void; onRemove: (wallet: RegisteredWallet) => Promise<void>; onActivity: () => void }) {
  const { t } = useI18n();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [displayName, setDisplayName] = useState('');
  const [renaming, setRenaming] = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [removalCandidate, setRemovalCandidate] = useState<RegisteredWallet | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [transactions, setTransactions] = useState<NativeTransaction[]>([]);
  const loadTransactions = useCallback(async () => {
    if (!walletId) { setTransactions([]); return; }
    try {
      const raw = await invoke<string>('wallet_transactions', { input: { walletId, accountIndex: activeWallet?.accountIndex ?? 0 } });
      setTransactions(parseNativeJson<NativeTransaction[]>(raw, 'The native wallet transaction history was invalid.'));
    } catch (reason) { setMessage(errorMessage(reason, 'Could not read wallet activity.')); }
  }, [activeWallet?.accountIndex, walletId]);
  useEffect(() => {
    if (!linked || !walletId) return;
    void loadTransactions();
    const timer = window.setInterval(() => void loadTransactions(), 10_000);
    return () => window.clearInterval(timer);
  }, [linked, loadTransactions, walletId]);
  const startRename = (wallet: RegisteredWallet) => { setEditingId(wallet.id); setDisplayName(walletDisplayName(wallet)); setMessage(null); };
  const saveRename = async () => {
    if (!editingId || renaming) return;
    setRenaming(true); setMessage(null);
    try {
      await invoke<RegisteredWallet>('rename_wallet', { input: { walletId: editingId, displayName } });
      setEditingId(null); setDisplayName(''); onRenamed();
    } catch (reason) { setMessage(errorMessage(reason, 'The wallet name could not be updated.')); }
    finally { setRenaming(false); }
  };
  const remove = async (wallet: RegisteredWallet) => {
    if (removingId) return;
    setRemovingId(wallet.id); setMessage(null);
    try {
      await onRemove(wallet);
      if (editingId === wallet.id) { setEditingId(null); setDisplayName(''); }
      setRemovalCandidate(null);
    } catch (reason) { setMessage(errorMessage(reason, t('wallets.removeFailed'))); }
    finally { setRemovingId(null); }
  };
  if (wallets.length === 0) return <section className="empty-state"><img className="empty-mark" src="/monero-mark.png" alt="" /><h2>{linked ? t('wallets.empty') : t('wallets.protected')}</h2><p>{linked ? t('wallets.emptyText') : t('wallets.protectedText')}</p><button className="primary" onClick={onSetup} type="button">{t('wallets.openSetup')}</button></section>;
  return <section className="wallet-list-page"><header><div><h2>{t('wallets.saved')}</h2><p>{t('wallets.namesInfo')}</p></div><button className="primary" onClick={onSetup} type="button">{t('home.addWallet')}</button></header>{message && <p className="setup-message wallet-list-message" role="alert">{message}</p>}<div className="wallet-list">{wallets.map((wallet) => <div className="wallet-row-wrap" key={wallet.id}><article className={activeWallet?.id === wallet.id ? 'wallet-row active' : 'wallet-row'}><div className="wallet-row-mark"><img src="/monero-mark.png" alt="" /></div><div className="wallet-row-copy"><div><h3>{walletDisplayName(wallet)}</h3><span className={wallet.seedBackupStatus === 'pending' ? 'wallet-chip warning' : 'wallet-chip'}>{wallet.seedBackupStatus === 'pending' ? t('wallets.backupNeeded') : wallet.isOpen ? t('home.openLocal') : t('wallets.locked')}</span></div><p>{networkLabel(wallet.network)} · {wallet.kind === 'hardware' ? t('wallets.ledger') : wallet.kind === 'view-only' ? 'Ledger read-only' : t('wallets.software')}{wallet.restoreHeight ? ` · ${t('wallets.scanFrom', { height: wallet.restoreHeight })}` : ''}</p></div><div className="wallet-row-actions"><button className="quiet-button" disabled={Boolean(removingId)} onClick={() => startRename(wallet)} type="button">{t('wallets.rename')}</button><button className="secondary" disabled={!linked || Boolean(removingId)} onClick={() => onOpen(wallet)} type="button">{wallet.isOpen ? t('wallets.use') : t('wallets.unlock')}</button><button className="danger-button" disabled={Boolean(removingId)} onClick={() => { setRemovalCandidate(wallet); setEditingId(null); setDisplayName(''); setMessage(null); }} type="button">{removingId === wallet.id ? t('wallets.removing') : t('wallets.remove')}</button></div></article>{editingId === wallet.id && <div className="wallet-rename"><input autoFocus value={displayName} maxLength={64} onChange={(event) => setDisplayName(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') void saveRename(); if (event.key === 'Escape') setEditingId(null); }} placeholder={t('wallets.namePlaceholder')} /><div><button className="quiet-button" disabled={renaming || Boolean(removingId)} onClick={() => { setEditingId(null); setMessage(null); }} type="button">{t('common.cancel')}</button><button className="secondary" disabled={renaming || Boolean(removingId)} onClick={() => void saveRename()} type="button">{renaming ? t('wallets.saving') : t('wallets.saveName')}</button></div></div>}</div>)}</div>{removalCandidate && <div className="seed-overlay" role="dialog" aria-modal="true" aria-labelledby="remove-wallet-title"><section className="seed-dialog wallet-remove-dialog"><p className="eyebrow">Remove local wallet</p><h2 id="remove-wallet-title">Remove {walletDisplayName(removalCandidate)}?</h2><p>This removes the wallet only from this app. Its encrypted wallet file, recovery seed, and Ledger device are not deleted. A Ledger parent also removes its local Fast and read-only copies from this app.</p><div className="dialog-actions"><button className="quiet-button" disabled={Boolean(removingId)} onClick={() => setRemovalCandidate(null)} type="button">{t('common.cancel')}</button><button className="danger-button" disabled={Boolean(removingId)} onClick={() => void remove(removalCandidate)} type="button">{removingId === removalCandidate.id ? t('wallets.removing') : t('wallets.remove')}</button></div></section></div>}<LedgerReadOnlySetup linked={linked} walletId={walletId} activeWallet={activeWallet} wallets={wallets} onOpened={onOpened} /><RecentTransactions hasOpenWallet={Boolean(walletId)} items={transactions} onActivity={onActivity} /></section>;
}

function LedgerReadOnlySetup({ linked, walletId, activeWallet, wallets, onOpened }: { linked: boolean; walletId: string | null; activeWallet: RegisteredWallet | null; wallets: RegisteredWallet[]; onOpened: (result: WalletOperationResponse) => void }) {
  const [approved, setApproved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const isLedger = activeWallet?.kind === 'hardware' && activeWallet.role !== 'fast';
  const existing = isLedger ? wallets.find((wallet) => wallet.kind === 'view-only' && wallet.sourceWalletId === activeWallet.id) : undefined;
  if (!isLedger) return null;
  const create = async () => {
    if (!walletId || !activeWallet || !approved || busy) return;
    setBusy(true); setMessage(null);
    try {
      const result = await invoke<WalletOperationResponse>('enable_ledger_read_only', { input: { sourceWalletId: walletId, sourceRegistrationId: activeWallet.id } });
      onOpened(result);
    } catch (reason) { setMessage(errorMessage(reason, 'The Ledger read-only copy could not be created.')); }
    finally { setBusy(false); }
  };
  return <article className="ledger-read-only-card"><div><p className="eyebrow">Optional local read-only mode</p><h3>Read and sync without Ledger</h3><p>Approve <b>Export view key</b> once on the connected Ledger. We create a local read-only wallet that can receive, read and synchronize but can never spend. Its private view key is encrypted on this device only and is never uploaded.</p></div>{existing ? <p className="ledger-read-only-ready">Local read-only copy is ready: <b>{walletDisplayName(existing)}</b>.</p> : <><label className="fast-consent"><input checked={approved} onChange={(event) => setApproved(event.target.checked)} type="checkbox" />I understand this stores the private view key only in this device’s secure storage and encrypted local wallet file.</label><button className="secondary" disabled={!linked || !walletId || !approved || busy} onClick={() => void create()} type="button">{busy ? 'Waiting for Ledger…' : 'Create local read-only copy'}</button></>}{message && <p className="setup-message">{message}</p>}</article>;
}

function Setup({ linked, initial, wallets, onSelectSaved, onOpened, onCreated }: { linked: boolean; initial: SetupRequest; wallets: RegisteredWallet[]; onSelectSaved: (wallet: RegisteredWallet) => void; onOpened: (result: WalletOperationResponse) => void; onCreated: (result: WalletOperationResponse) => void }) {
  const { t } = useI18n();
  const [mode, setMode] = useState<SetupMode>(initial?.mode ?? 'create');
  const [mnemonic, setMnemonic] = useState('');
  const [restoreStartDate, setRestoreStartDate] = useState('');
  const [legacyPassword, setLegacyPassword] = useState('');
  const [needsLegacyPassword, setNeedsLegacyPassword] = useState(false);
  const [ledgerTransport, setLedgerTransport] = useState<'usb' | 'ble'>('usb');
  const [ledgerStatus, setLedgerStatus] = useState<LedgerTransportStatus | null>(null);
  const [createFastWallet, setCreateFastWallet] = useState(!initial);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const network: Network = mode === 'open' ? initial?.network ?? 'mainnet' : 'mainnet';
  // Both a Ledger spending wallet and its local read-only companion use a
  // randomly generated credential held in the OS secure store. Neither has a
  // user-created wallet password, so neither may enter the legacy prompt.
  const openingDeviceCredentialWallet = Boolean(initial && wallets.some(wallet => wallet.walletName === initial.walletName && wallet.network === initial.network && (wallet.kind === 'hardware' || wallet.kind === 'view-only')));
  const label = mode === 'create' ? t('setup.create') : mode === 'restore' ? t('setup.import') : mode === 'open' ? t('setup.open') : t('setup.ledger');
  const description = mode === 'create'
    ? t('setup.createDescription')
    : mode === 'restore'
      ? t('setup.restoreDescription')
      : mode === 'open'
        ? t('setup.openDescription', { network: networkLabel(network) })
        : t('setup.ledgerDescription');
  const openDescription = needsLegacyPassword ? t('setup.passwordRequired') : description;
  const checkLedgerBluetooth = async () => {
    if (!linked || busy) return;
    setLedgerTransport('ble'); setBusy(true); setMessage(null);
    try {
      const raw = await invoke<string>('ledger_transport_status');
      const status = parseNativeJson<LedgerTransportStatus>(raw, t('setup.bluetoothInvalid'));
      setLedgerStatus(status); setMessage(status.message);
    } catch (reason) { setMessage(errorMessage(reason, t('setup.bluetoothFailed'))); }
    finally { setBusy(false); }
  };
  const chooseMode = (next: SetupMode) => {
    setMode(next); setMessage(null); setNeedsLegacyPassword(false); setLegacyPassword('');
    // Fast Wallet is an opt-in companion created only while creating or
    // importing a software wallet.  Opening an existing wallet must never
    // offer or create another wallet as a side effect.
    setCreateFastWallet(next === 'create' || next === 'restore');
    if (next === 'ledger' && ledgerTransport === 'ble') void checkLedgerBluetooth();
  };
  useEffect(() => {
    // A Ledger wallet is authorized by reconnecting/unlocking the device, not
    // by a user-created local password. Do not even ask the legacy-password
    // probe for it, otherwise a stale secure-store entry looks like a prompt.
    if (mode !== 'open' || !initial || needsLegacyPassword || openingDeviceCredentialWallet) return;
    let mounted = true;
    invoke<boolean>('wallet_open_requires_password', {
      input: { walletName: initial.walletName, network: initial.network, restoreHeight: 0 },
    })
      .then(requiresPassword => {
        if (mounted && requiresPassword) setNeedsLegacyPassword(true);
      })
      .catch(reason => {
        if (mounted) setMessage(errorMessage(reason, t('setup.operationFailed')));
      });
    return () => { mounted = false; };
  }, [initial, mode, needsLegacyPassword, openingDeviceCredentialWallet, t]);
  const submit = async () => {
    if (!linked || busy) return;
    let restoreHeight: number | undefined;
    try {
      restoreHeight = (mode === 'restore' || mode === 'ledger')
        ? restoreHeightFromStartDate(restoreStartDate, network)
        : undefined;
    } catch { setMessage(t('setup.dateInvalid')); return; }
    if (mode === 'ledger' && ledgerTransport === 'ble' && (!ledgerStatus?.supported || !ledgerStatus.available || !ledgerStatus.permissionGranted || ledgerStatus.deviceCount < 1)) { await checkLedgerBluetooth(); return; }
    setBusy(true); setMessage(null);
    try {
      const input = mode === 'ledger'
        ? { walletName: '', password: '', network, deviceName: ledgerTransport === 'ble' ? 'Ledger:ble' : 'Ledger', restoreHeight, accountIndex: 0, role: 'standard', createFast: false }
        : { walletName: mode === 'open' ? initial?.walletName ?? '' : '', password: needsLegacyPassword ? legacyPassword : '', network, ...(mode === 'create' ? { language: 'English' } : {}), ...(mode === 'restore' ? { mnemonic, restoreHeight } : {}) };
      const command = mode === 'create' ? 'create_wallet' : mode === 'restore' ? 'restore_wallet' : mode === 'ledger' ? 'create_hardware_wallet' : 'open_wallet';
      const result = await invoke<WalletOperationResponse>(command, { input });
      if (createFastWallet && (mode === 'create' || mode === 'restore') && result.wallet.kind === 'software') {
        try {
          const existing = await invoke<FastWalletRecord[]>('list_fast_wallets');
          if (!existing.some(item => item.sourceRegistrationId === result.wallet.id)) {
            await invoke<FastWalletRecord>('create_fast_wallet', { input: { sourceWalletId: result.walletId, sourceRegistrationId: result.wallet.id, label: 'Fast Wallet', password: '', restoreHeight } });
            // A local Fast Wallet is safe to create by default. Never infer a
            // remote scanner capability from a fallback URL: uploading its
            // private view key happens later only from the explicit scanner
            // setup, with an approved configured endpoint.
          }
        } catch (reason) {
          setMessage(errorMessage(reason, 'The local Fast Wallet could not be created.'));
        }
      }
      setMnemonic(''); setLegacyPassword('');
      if (mode === 'create') onCreated(result); else onOpened(result);
    } catch (reason) {
      const detail = errorMessage(reason, t('setup.operationFailed'));
      setMessage(detail);
      if (mode === 'open' && /needs its existing password/i.test(detail)) setNeedsLegacyPassword(true);
    } finally { setBusy(false); }
  };
  const ledgerNeedsSearch = ledgerTransport === 'ble' && (!ledgerStatus?.supported || !ledgerStatus.available || !ledgerStatus.permissionGranted || ledgerStatus.deviceCount < 1);
  const actionLabel = busy ? t('setup.working') : !linked ? t('setup.coreRequired') : mode === 'ledger' ? ledgerNeedsSearch ? t('setup.searchLedger') : t('setup.createLedger') : mode === 'create' ? t('setup.create') : mode === 'restore' ? t('setup.import') : t('setup.open');
  const choices: Array<{ id: SetupMode; title: string; detail: string }> = initial?.mode === 'open'
    ? [{ id: 'open', title: t('setup.open'), detail: t('setup.openDetail') }]
    : [{ id: 'create', title: t('setup.create'), detail: t('setup.createDetail') }, { id: 'ledger', title: t('setup.ledger'), detail: t('setup.ledgerDetail') }, { id: 'restore', title: t('setup.import'), detail: t('setup.importDetail') }];
  const scanDate = <><label>{t('setup.scanStart')} <small>{t('common.optional')}</small><input value={restoreStartDate} onChange={(event) => setRestoreStartDate(event.target.value)} type="date" max={todayRestoreDate()} /></label><small className="restore-start-hint">{t('setup.scanDateHint')}</small></>;
  const fastChoice = <label className="fast-setup-choice"><input checked={createFastWallet} onChange={(event) => setCreateFastWallet(event.target.checked)} type="checkbox" /><span><strong>Fast Wallet</strong><small>A separate receive wallet is created and only its private view key is registered for private incoming-payment alerts.</small></span></label>;
  return <section className="setup-grid simple-setup"><header><p className="eyebrow">{initial?.mode === 'open' ? t('wallets.unlock') : t('setup.eyebrow')}</p><h2>{initial?.mode === 'open' ? t('setup.open') : t('setup.title')}</h2><p>{initial?.mode === 'open' && needsLegacyPassword ? t('setup.passwordRequired') : initial?.mode === 'open' ? t('setup.openDescription', { network: networkLabel(network) }) : t('setup.subtitle')}</p></header>{!initial && wallets.length > 0 && <section className="setup-saved-wallets"><strong>{t('home.yourWallets')}</strong><div>{wallets.map(wallet => <button key={wallet.id} onClick={() => onSelectSaved(wallet)} type="button"><img src="/monero-mark.png" alt="" /><span><b>{walletDisplayName(wallet)}</b><small>{wallet.kind === 'hardware' ? t('wallets.ledger') : wallet.kind === 'fast' ? 'Fast Wallet' : networkLabel(wallet.network)}</small></span></button>)}</div></section>}<div className="setup-choices" role="tablist" aria-label={t('setup.eyebrow')}>{choices.map((item) => <button className={item.id === mode ? 'selected' : ''} onClick={() => chooseMode(item.id)} type="button" key={item.id}><span>{item.id === 'create' ? '＋' : item.id === 'ledger' ? '⌁' : item.id === 'restore' ? '⇣' : '↗'}</span><strong>{item.title}</strong><small>{item.detail}</small></button>)}</div><article className="setup-option simple-setup-form"><img src="/monero-mark.png" alt="" /><div><p className="eyebrow">{mode === 'open' ? networkLabel(network) : t('common.mainnet')}</p><h2>{label}</h2><p>{openDescription}</p><div className="wallet-form">{mode === 'restore' && <><label>{t('setup.seed')}<textarea value={mnemonic} onChange={(event) => setMnemonic(event.target.value)} placeholder={t('setup.seedPlaceholder')} autoComplete="off" /></label>{scanDate}</>}{mode === 'ledger' && <><div className="setup-transport"><button className={ledgerTransport === 'usb' ? 'selected' : ''} onClick={() => { setLedgerTransport('usb'); setMessage(null); }} type="button">USB</button><button className={ledgerTransport === 'ble' ? 'selected' : ''} onClick={() => void checkLedgerBluetooth()} type="button">Bluetooth</button></div><p className={ledgerStatus?.available && ledgerStatus.deviceCount > 0 ? 'ledger-status ready' : 'ledger-status'}>{ledgerTransport === 'usb' ? t('setup.usbHint') : ledgerStatus?.message ?? t('setup.bluetoothHint')}</p>{scanDate}</>}{mode === 'open' && needsLegacyPassword && <label>{t('setup.legacyPassword')}<input autoFocus value={legacyPassword} onChange={(event) => setLegacyPassword(event.target.value)} type="password" autoComplete="current-password" /></label>}{(mode === 'create' || mode === 'restore') && fastChoice}</div><button className="primary" onClick={() => void submit()} disabled={!linked || busy || (mode === 'restore' && !mnemonic.trim()) || (mode === 'open' && needsLegacyPassword && !legacyPassword)} type="button">{actionLabel}</button>{message && <p className="setup-message">{message}</p>}</div></article></section>;
}

function FastWallets({ linked, sourceWalletId, sourceWallet }: { linked: boolean; sourceWalletId: string | null; sourceWallet: RegisteredWallet | null }) {
  const [wallets, setWallets] = useState<FastWalletRecord[]>([]); const [label, setLabel] = useState('Fast Wallet'); const [password, setPassword] = useState(''); const [restoreHeight, setRestoreHeight] = useState(''); const [scannerUrl, setScannerUrl] = useState('https://xmr.tex8.com'); const [scannerToken, setScannerToken] = useState(''); const [enableScanner, setEnableScanner] = useState(true); const [consent, setConsent] = useState(false); const [busy, setBusy] = useState(false); const [message, setMessage] = useState<string | null>(null); const [openIdentityId, setOpenIdentityId] = useState<string | null>(null); const [openWalletId, setOpenWalletId] = useState<string | null>(null); const [snapshot, setSnapshot] = useState<NativeWalletSnapshot | null>(null);
  const load = useCallback(async () => { try { setWallets(await invoke<FastWalletRecord[]>('list_fast_wallets')); } catch (reason) { setMessage(errorMessage(reason, 'The Fast Wallet list could not be loaded.')); } }, []);
  useEffect(() => { void load(); }, [load]);
  const create = async () => {
    if (!sourceWalletId || !sourceWallet || sourceWallet.kind !== 'software') return;
    const height = restoreHeight.trim() ? Number(restoreHeight) : undefined;
    if (height !== undefined && (!Number.isSafeInteger(height) || height < 0)) { setMessage('Scan height must be a non-negative whole number.'); return; }
    if (enableScanner && !consent) { setMessage('Confirm the scanner privacy choice before enabling Fast Wallet scanning.'); return; }
    setBusy(true); setMessage(null);
    try {
      const created = await invoke<FastWalletRecord>('create_fast_wallet', { input: { sourceWalletId, sourceRegistrationId: sourceWallet.id, label, password, restoreHeight: height } });
      setPassword('');
      if (enableScanner) {
        const enabled = await invoke<FastWalletRecord>('enable_fast_wallet', { input: { identityId: created.id, scannerUrl, scannerAuthToken: scannerToken.trim() || undefined } });
        setWallets((items) => [...items.filter((item) => item.id !== enabled.id), enabled]); setScannerToken(''); setMessage('Fast Wallet created and scanner registration enabled.');
      } else {
        setWallets((items) => [...items, created]); setMessage('Fast Wallet created locally. Scanner registration is off.');
      }
    } catch (reason) { setPassword(''); setScannerToken(''); setMessage(errorMessage(reason, 'The Fast Wallet could not be created.')); }
    finally { setBusy(false); }
  };
  const refresh = async (identityId: string) => { setBusy(true); try { const updated = await invoke<FastWalletRecord>('refresh_fast_wallet_status', { input: { identityId } }); setWallets((items) => items.map((item) => item.id === updated.id ? updated : item)); setMessage('Scanner status refreshed.'); } catch (reason) { setMessage(errorMessage(reason, 'The scanner status could not be refreshed.')); } finally { setBusy(false); } };
  const enable = async (identityId: string, currentUrl: string) => { if (!consent) { setMessage('Confirm the scanner privacy choice before enabling scanning.'); return; } setBusy(true); try { const updated = await invoke<FastWalletRecord>('enable_fast_wallet', { input: { identityId, scannerUrl: currentUrl || scannerUrl, scannerAuthToken: scannerToken.trim() || undefined } }); setWallets((items) => items.map((item) => item.id === updated.id ? updated : item)); setScannerToken(''); setMessage('Scanner registration enabled.'); } catch (reason) { setMessage(errorMessage(reason, 'The scanner registration could not be enabled.')); } finally { setBusy(false); } };
  const disable = async (identityId: string) => { setBusy(true); try { const updated = await invoke<FastWalletRecord>('disable_fast_wallet', { input: { identityId } }); setWallets((items) => items.map((item) => item.id === updated.id ? updated : item)); setMessage('Scanner watch removed and its local scanner credential was forgotten.'); } catch (reason) { setMessage(errorMessage(reason, 'The scanner watch could not be removed.')); } finally { setBusy(false); } };
  const openLocal = async (identityId: string) => { setBusy(true); try { if (openIdentityId && openIdentityId !== identityId) await invoke<void>('close_fast_wallet', { input: { identityId: openIdentityId } }); const opened = await invoke<FastWalletOpenResponse>('open_fast_wallet', { input: { identityId } }); await invoke<void>('start_wallet_refresh', { input: { walletId: opened.walletId } }); const raw = await invoke<string>('wallet_snapshot', { input: { walletId: opened.walletId } }); setOpenIdentityId(opened.wallet.id); setOpenWalletId(opened.walletId); setSnapshot(parseNativeJson<NativeWalletSnapshot>(raw, 'The Fast Wallet snapshot was invalid.')); setMessage('Fast Wallet opened locally for receiving and sync. Fast spending remains disabled until desktop spend reconciliation is implemented.'); } catch (reason) { setMessage(errorMessage(reason, 'The Fast Wallet could not be opened.')); } finally { setBusy(false); } };
  const closeLocal = async () => { if (!openIdentityId) return; setBusy(true); try { await invoke<void>('close_fast_wallet', { input: { identityId: openIdentityId } }); setOpenIdentityId(null); setOpenWalletId(null); setSnapshot(null); setMessage('Fast Wallet locked.'); } catch (reason) { setMessage(errorMessage(reason, 'The Fast Wallet could not be locked.')); } finally { setBusy(false); } };
  const refreshLocal = async () => { if (!openWalletId) return; setBusy(true); try { await invoke<void>('start_wallet_refresh', { input: { walletId: openWalletId } }); const raw = await invoke<string>('wallet_snapshot', { input: { walletId: openWalletId } }); setSnapshot(parseNativeJson<NativeWalletSnapshot>(raw, 'The Fast Wallet snapshot was invalid.')); setMessage('Fast Wallet refresh started.'); } catch (reason) { setMessage(errorMessage(reason, 'The Fast Wallet could not be refreshed.')); } finally { setBusy(false); } };
  if (!linked) return <WalletFeature linked={linked} title="Fast Wallet" text="Fast Wallet uses a separate locally-derived identity and needs the native Monero core." />;
  return <section className="fast-wallet-page"><header><div><p className="eyebrow">Opt-in isolated receive identity</p><h2>Fast Wallet</h2><p>Create a distinct receive wallet from an open software wallet. The scanner receives only the Fast Wallet private view key after your explicit consent – never the main-wallet seed, spend key, or private view key.</p></div><button className="secondary" disabled={busy} onClick={() => void load()} type="button">Refresh list</button></header>{sourceWallet?.kind === 'hardware' ? <article className="fast-wallet-notice"><h3>Ledger Fast Wallet is not available yet</h3><p>The shared native core cannot derive an isolated Fast Wallet from a Ledger-backed wallet. Your Ledger remains usable normally; this never falls back to sharing Ledger or main-wallet keys.</p></article> : !sourceWalletId || !sourceWallet ? <article className="fast-wallet-notice"><h3>Open a software wallet first</h3><p>Fast Wallet creation uses the currently unlocked software wallet to derive a separate local identity.</p></article> : <article className="fast-wallet-create"><div><h3>Create a Fast Wallet</h3><p>Fast scanning is selected by default. Turn it off to create the isolated local receive identity without contacting a scanner.</p></div><div className="fast-wallet-form"><label>Label<input value={label} onChange={(event) => setLabel(event.target.value)} maxLength={80} /></label><label>Scan from height (optional)<input value={restoreHeight} onChange={(event) => setRestoreHeight(event.target.value)} inputMode="numeric" placeholder={sourceWallet.restoreHeight ? String(sourceWallet.restoreHeight) : 'Native estimate'} /></label><label>New Fast Wallet password<input value={password} onChange={(event) => setPassword(event.target.value)} type="password" autoComplete="new-password" /></label><label className="checkbox"><input checked={enableScanner} onChange={(event) => setEnableScanner(event.target.checked)} type="checkbox" />Enable scanner after creation</label>{enableScanner && <><label>Scanner URL<input value={scannerUrl} onChange={(event) => setScannerUrl(event.target.value)} placeholder="https://xmr.tex8.com" autoComplete="off" /></label><label>Scanner token (optional)<input value={scannerToken} onChange={(event) => setScannerToken(event.target.value)} type="password" autoComplete="off" placeholder="Stored only in macOS Keychain" /></label><label className="fast-consent"><input checked={consent} onChange={(event) => setConsent(event.target.checked)} type="checkbox" />I understand that this sends only this new Fast Wallet’s private view key and public address to the selected scanner.</label></>}</div><button className="primary" disabled={busy || !password || (enableScanner && !consent)} onClick={() => void create()} type="button">{busy ? 'Working…' : enableScanner ? 'Create & enable Fast Wallet' : 'Create Fast Wallet locally'}</button></article>}<section className="fast-wallet-list"><h3>Your Fast Wallets</h3>{wallets.length === 0 ? <p className="community-empty">No Fast Wallet identities yet.</p> : wallets.map((wallet) => <article className="fast-wallet-row" key={wallet.id}><div className="fast-wallet-row-head"><div><strong>{wallet.label}</strong><span className={wallet.status === 'enabled' ? 'wallet-chip' : 'wallet-chip warning'}>{wallet.status}</span></div><small>{networkLabel(wallet.network)} · scanner: {wallet.scannerStatus}</small></div><code className="address-output">{wallet.address}</code><p>Derived identity {wallet.derivationIndex} · scan from {wallet.restoreHeight}{wallet.lastScannedHeight !== undefined ? ` · scanner checked through ${wallet.lastScannedHeight}` : ''}</p>{openIdentityId === wallet.id && <div className="fast-wallet-live"><strong>Local receive wallet open</strong><span>{syncLabel(snapshot)}</span><span>{snapshot ? `${snapshot.balanceAtomic} atomic · ${snapshot.unlockedBalanceAtomic} unlocked` : 'Loading native wallet state…'}</span><p>Receive and sync are active locally. Fast spending is deliberately unavailable until desktop key-image reconciliation is implemented.</p></div>}<div className="button-row">{openIdentityId === wallet.id ? <><button className="secondary" disabled={busy} onClick={() => void refreshLocal()} type="button">Refresh local wallet</button><button className="quiet-button" disabled={busy} onClick={() => void closeLocal()} type="button">Lock Fast Wallet</button></> : <button className="secondary" disabled={busy} onClick={() => void openLocal(wallet.id)} type="button">Open for receive</button>}<button className="secondary" disabled={busy || !wallet.scannerUrl} onClick={() => void refresh(wallet.id)} type="button">Refresh scanner</button>{wallet.status === 'enabled' ? <button className="danger-button" disabled={busy} onClick={() => void disable(wallet.id)} type="button">Disable scanner</button> : <button className="secondary" disabled={busy || !consent} onClick={() => void enable(wallet.id, wallet.scannerUrl)} type="button">Enable scanner</button>}</div></article>)}</section>{wallets.some((wallet) => wallet.status !== 'enabled') && <article className="fast-wallet-enable"><h3>Enable an existing Fast Wallet</h3><p>Use this only after reviewing the same scanner privacy choice. An optional token is retained in the macOS Keychain and is never shown again.</p><label>Scanner URL<input value={scannerUrl} onChange={(event) => setScannerUrl(event.target.value)} placeholder="https://xmr.tex8.com" /></label><label>Scanner token (optional)<input value={scannerToken} onChange={(event) => setScannerToken(event.target.value)} type="password" autoComplete="off" /></label><label className="fast-consent"><input checked={consent} onChange={(event) => setConsent(event.target.checked)} type="checkbox" />I approve sending the isolated Fast Wallet view key to this scanner.</label></article>}{message && <p className="setup-message">{message}</p>}</section>;
}

function WalletFeature({ linked, title, text }: { linked: boolean; title: string; text: string }) { return <section className="empty-state"><img className="empty-mark" src="/monero-mark.png" alt="" /><h2>{title}</h2><p>{text}</p>{!linked && <p className="feature-lock">Available when the local Monero engine is linked.</p>}</section>; }

function Send({ linked, walletId, wallet, onActivity }: { linked: boolean; walletId: string | null; wallet: RegisteredWallet | null; onActivity: () => void }) {
  const { t } = useI18n();
  const [address, setAddress] = useState('');
  const [amount, setAmount] = useState('');
  const [priority, setPriority] = useState<'low' | 'default' | 'medium' | 'high'>('low');
  const [sweepAll, setSweepAll] = useState(false);
  const [snapshot, setSnapshot] = useState<NativeWalletSnapshot | null>(null);
  const [review, setReview] = useState<NativePreparedTransaction | null>(null);
  const [transactions, setTransactions] = useState<NativeTransaction[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [contacts, setContacts] = useState<RecipientContact[]>(() => loadRecipientContacts());
  const [recentContacts, setRecentContacts] = useState<RecipientContact[]>(() => loadRecentRecipients());
  const [scannerOpen, setScannerOpen] = useState(false);
  const accountIndex = wallet?.accountIndex ?? 0;

  const loadSnapshot = useCallback(async (refresh = false) => {
    if (!walletId) return;
    if (refresh) await invoke<void>('start_wallet_refresh', { input: { walletId } });
    const raw = await invoke<string>('wallet_snapshot', { input: { walletId, accountIndex } });
    setSnapshot(parseNativeJson<NativeWalletSnapshot>(raw, t('send.preparationFailed')));
  }, [accountIndex, t, walletId]);
  const loadTransactions = useCallback(async () => {
    if (!walletId) { setTransactions([]); return; }
    const raw = await invoke<string>('wallet_transactions', { input: { walletId, accountIndex } });
    setTransactions(parseNativeJson<NativeTransaction[]>(raw, t('send.preparationFailed')));
  }, [accountIndex, t, walletId]);

  useEffect(() => {
    if (!linked || !walletId) return;
    void loadSnapshot();
  }, [linked, loadSnapshot, walletId]);
  useEffect(() => {
    if (!linked || !walletId) return;
    const refreshTransactions = () => void loadTransactions().catch((reason) => setMessage(errorMessage(reason, t('send.preparationFailed'))));
    refreshTransactions();
    const timer = window.setInterval(refreshTransactions, 10_000);
    return () => window.clearInterval(timer);
  }, [linked, loadTransactions, t, walletId]);

  const selectRecipient = (contact: RecipientContact) => {
    setAddress(contact.address);
    setReview(null);
    setMessage(null);
  };

  const prepare = async () => {
    if (!walletId) { setMessage(t('send.openWallet')); return; }
    if (!snapshot || !snapshot.synchronized) { setMessage(t('send.waitForSync')); return; }
    const recipient = address.trim();
    if (!recipient) { setMessage(t('send.recipientRequired')); return; }
    if (!isLikelyMoneroAddress(recipient)) { setMessage(t('send.invalidRecipient')); return; }
    const amountAtomic = parseXmrToAtomic(amount);
    if ((!sweepAll && (!amountAtomic || atomicValue(amountAtomic) <= 0n)) || (sweepAll && atomicValue(snapshot?.unlockedBalanceAtomic) <= 0n)) { setMessage(t('send.validAmount')); return; }
    if (!sweepAll && snapshot && atomicValue(amountAtomic ?? undefined) > atomicValue(snapshot.unlockedBalanceAtomic)) { setMessage(t('send.insufficient')); return; }
    setBusy(true); setMessage(null);
    try {
      const raw = await invoke<string>('prepare_transaction', { input: { walletId, address: recipient, amountAtomic: sweepAll ? '' : amountAtomic ?? '', priority, accountIndex } });
      const prepared = parseNativeJson<NativePreparedTransaction>(raw, t('send.preparationFailed'));
      if (prepared.status !== 'ok') throw new Error(prepared.error || t('send.preparationFailed'));
      setReview(prepared);
      if (sweepAll) setAmount(formatAtomicXmr(prepared.amountAtomic, 12));
    } catch (reason) { setMessage(errorMessage(reason, t('send.preparationFailed'))); }
    finally { setBusy(false); }
  };

  const commit = async () => {
    if (!walletId || !review) return;
    setBusy(true); setMessage(null);
    try {
      const raw = await invoke<string>('commit_transaction', { input: { walletId, pendingId: review.id } });
      const result = parseNativeJson<NativePreparedTransaction>(raw, t('send.broadcastFailed'));
      if (result.status !== 'ok') throw new Error(result.error || t('send.broadcastFailed'));
      setReview(null); setAmount(''); setSweepAll(false); setMessage(t('send.sent'));
      setRecentContacts(rememberRecipient(address.trim(), contacts));
      setAddress('');
      await Promise.all([loadSnapshot(true), loadTransactions()]);
    } catch (reason) { setMessage(errorMessage(reason, t('send.broadcastFailed'))); }
    finally { setBusy(false); }
  };

  const useMaximum = () => {
    if (!snapshot) return;
    setAmount(formatAtomicXmr(snapshot.unlockedBalanceAtomic, 12));
    setSweepAll(true);
    setReview(null); setMessage(null);
  };
  const amountAtomic = parseXmrToAtomic(amount) ?? '0';
  const totalAtomic = review ? atomicValue(review.amountAtomic) + atomicValue(review.feeAtomic) + atomicValue(review.dustAtomic) : 0n;

  if (!linked || !walletId) return <WalletFeature linked={linked} title={t('send.title')} text={t('send.openWallet')} />;
  return <section className="transaction-form transaction-page">
    <header><p className="eyebrow">{t('send.from')}</p><h2>{t('send.title')}</h2><p>{t('send.subtitle')}</p></header>
    <div className="transaction-summary"><span>{wallet ? walletDisplayName(wallet) : t('common.wallet')}</span><strong>{snapshot ? `${formatAtomicXmr(snapshot.unlockedBalanceAtomic, 12)} XMR` : t('common.loading')}</strong><small>{t('send.available')} · {snapshot ? syncLabel(snapshot) : t('common.loading')}</small></div>
    <label>{t('send.recipient')}<span className="recipient-address-input"><input value={address} onChange={(event) => { setAddress(event.target.value); setReview(null); }} placeholder={t('send.recipientPlaceholder')} autoComplete="off" spellCheck="false" /><button className="recipient-qr-button" aria-label={t('send.scanAddress')} onClick={() => setScannerOpen(true)} title={t('send.scanAddress')} type="button">⌗</button></span></label>
    <section className="recipient-picker" aria-label="Address book">
      {contacts.length > 0 && <div><strong>{t('send.addressBook')}</strong><div className="recipient-chips">{contacts.map((contact) => <button className={contact.donor ? 'recipient-chip donor' : 'recipient-chip'} key={contact.id} onClick={() => selectRecipient(contact)} type="button"><b>{contact.label}</b><small>{shortHash(contact.address)}</small></button>)}</div></div>}
      {recentContacts.length > 0 && <div><strong>{t('send.recentContacts')}</strong><div className="recipient-chips">{recentContacts.map((contact) => <button className="recipient-chip" key={contact.id} onClick={() => selectRecipient(contact)} type="button"><b>{contact.label}</b><small>{shortHash(contact.address)}</small></button>)}</div></div>}
    </section>
    <div className="transaction-form-grid"><label>{t('send.amount')}<span className="amount-field"><input value={amount} onChange={(event) => { setAmount(event.target.value); setSweepAll(false); setReview(null); }} inputMode="decimal" placeholder={t('send.amountPlaceholder')} /><em>XMR</em></span></label><button className="secondary amount-max" disabled={!snapshot || busy} onClick={useMaximum} type="button">{t('send.max')}</button></div>
    {sweepAll && !review && <p className="transaction-note">{t('send.sweepAll')}</p>}
    <div className="priority-choice"><span>{t('send.priority')}</span><div>{([['low', t('send.low')], ['default', t('send.normal')], ['medium', t('send.medium')], ['high', t('send.high')]] as const).map(([value, label]) => <button className={priority === value ? 'selected' : ''} onClick={() => { setPriority(value); setReview(null); }} key={value} type="button">{label}</button>)}</div></div>
    {wallet?.kind === 'hardware' && <p className="transaction-note">{t('send.ledgerHint')}</p>}
    {!review ? <button className="primary" disabled={busy} onClick={() => void prepare()} type="button">{busy ? t('send.preparing') : t('send.review')}</button> : <section className="review-card"><header><strong>{t('send.reviewTitle')}</strong><p>{t('send.reviewSubtitle')}</p></header><code>{address.trim()}</code><dl className="review-details"><div><dt>{t('send.amount')}</dt><dd>{formatAtomicXmr(review.amountAtomic, 12)} XMR</dd></div><div><dt>{t('send.networkFee')}</dt><dd>{formatAtomicXmr(review.feeAtomic, 12)} XMR</dd></div><div><dt>{t('send.total')}</dt><dd>{formatAtomicXmr(totalAtomic.toString(), 12)} XMR</dd></div><div><dt>{t('send.account')}</dt><dd>{accountIndex}</dd></div></dl>{review.error && <p className="setup-message">{review.error}</p>}<div className="button-row"><button className="quiet-button" disabled={busy} onClick={() => setReview(null)} type="button">{t('common.cancel')}</button><button className="primary" disabled={busy} onClick={() => void commit()} type="button">{busy ? t('send.sending') : t('send.confirm')}</button></div></section>}
    {message && <p className="setup-message">{message}</p>}
    {amount && !review && parseXmrToAtomic(amount) && <small className="amount-preview">{formatAtomicXmr(amountAtomic, 12)} XMR</small>}
    <RecentTransactions hasOpenWallet items={transactions} onActivity={onActivity} />
    <DesktopRecipientQrScanner open={scannerOpen} onClose={() => setScannerOpen(false)} onScanned={(scannedAddress) => { setAddress(scannedAddress); setReview(null); setMessage(null); setScannerOpen(false); }} />
  </section>;
}

function Receive({ linked, walletId, wallet, onActivity }: { linked: boolean; walletId: string | null; wallet: RegisteredWallet | null; onActivity: () => void }) {
  const { t } = useI18n();
  const [address, setAddress] = useState<string | null>(null);
  const [addressIndex, setAddressIndex] = useState(wallet?.addressIndex ?? 0);
  const [label, setLabel] = useState('');
  const [subaddresses, setSubaddresses] = useState<NativeSubaddress[]>([]);
  const [transactions, setTransactions] = useState<NativeTransaction[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [qrCode, setQrCode] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const accountIndex = wallet?.accountIndex ?? 0;

  const load = useCallback(async () => {
    if (!walletId) return;
    setBusy(true);
    try {
      const primaryAddress = await invoke<string>('wallet_address', { input: { walletId, accountIndex } });
      const primaryIndex = wallet?.addressIndex ?? 0;
      setAddress(primaryAddress); setAddressIndex(primaryIndex);
      const storedAddresses = upsertDesktopWalletAddress({ walletId, accountIndex, addressIndex: primaryIndex, address: primaryAddress, label: t('receive.primaryAddress') });
      setSubaddresses(storedAddresses.map((item) => ({ accountIndex: item.accountIndex, addressIndex: item.addressIndex, address: item.address, label: item.label })));
      setMessage(null);
    }
    catch (reason) { setMessage(errorMessage(reason, t('receive.addressUnavailable'))); }
    finally { setBusy(false); }
  }, [accountIndex, t, wallet?.addressIndex, walletId]);
  const loadTransactions = useCallback(async () => {
    if (!walletId) { setTransactions([]); return; }
    const raw = await invoke<string>('wallet_transactions', { input: { walletId, accountIndex } });
    setTransactions(parseNativeJson<NativeTransaction[]>(raw, t('receive.addressUnavailable')));
  }, [accountIndex, t, walletId]);

  useEffect(() => { if (linked && walletId) void load(); }, [linked, load, walletId]);
  useEffect(() => {
    if (!linked || !walletId) return;
    const refreshTransactions = () => void loadTransactions().catch((reason) => setMessage(errorMessage(reason, t('receive.addressUnavailable'))));
    refreshTransactions();
    const timer = window.setInterval(refreshTransactions, 10_000);
    return () => window.clearInterval(timer);
  }, [linked, loadTransactions, t, walletId]);
  useEffect(() => {
    let mounted = true;
    if (!address) { setQrCode(null); return () => { mounted = false; }; }
    QRCode.toDataURL(address, { errorCorrectionLevel: 'M', margin: 2, width: 300, color: { dark: '#08070d', light: '#ffffff' } })
      .then((image) => { if (mounted) setQrCode(image); })
      .catch(() => { if (mounted) setMessage(t('receive.addressUnavailable')); });
    return () => { mounted = false; };
  }, [address, t]);

  const copy = async () => {
    if (!address) return;
    try { await navigator.clipboard.writeText(address); setMessage(t('receive.copied')); }
    catch { setMessage(t('receive.copyFailed')); }
  };
  const share = async () => {
    if (!address) return;
    try {
      if (navigator.share) {
        await navigator.share({ title: 'Monero address', text: address });
        setMessage(t('receive.shared'));
      } else {
        await navigator.clipboard.writeText(address);
        setMessage(t('receive.copied'));
      }
    } catch (reason) {
      if (reason instanceof DOMException && reason.name === 'AbortError') return;
      setMessage(t('receive.shareFailed'));
    }
  };
  const subaddress = async () => {
    if (!walletId) return;
    setBusy(true);
    try {
      const raw = await invoke<string>('create_subaddress', { input: { walletId, label: label.trim(), accountIndex } });
      const created = parseNativeJson<NativeSubaddress>(raw, t('receive.subaddressFailed'));
      setAddress(created.address); setAddressIndex(created.addressIndex);
      setSubaddresses(upsertDesktopWalletAddress({ walletId, accountIndex: created.accountIndex, addressIndex: created.addressIndex, address: created.address, label: created.label || label.trim() }).map((item) => ({ accountIndex: item.accountIndex, addressIndex: item.addressIndex, address: item.address, label: item.label })));
      setLabel('');
      setMessage(t('receive.subaddressCreated', { account: created.accountIndex, index: created.addressIndex }));
    } catch (reason) { setMessage(errorMessage(reason, t('receive.subaddressFailed'))); }
    finally { setBusy(false); }
  };
  const showOnLedger = async () => {
    if (!walletId) return;
    setBusy(true);
    try {
      const raw = await invoke<string>('show_hardware_wallet_address', { input: { walletId, accountIndex, addressIndex } });
      const status = parseNativeJson<NativeHardwareWalletStatus>(raw, t('receive.ledgerFailed'));
      setMessage(status.connected ? t('receive.ledgerConfirm') : t('receive.ledgerDisconnected'));
    } catch (reason) { setMessage(errorMessage(reason, t('receive.ledgerFailed'))); }
    finally { setBusy(false); }
  };

  if (!linked || !walletId) return <WalletFeature linked={linked} title={t('receive.title')} text={t('send.openWallet')} />;
  return <section className="transaction-form transaction-page receive-page">
    <header><p className="eyebrow">{t('receive.primaryAddress')}</p><h2>{t('receive.title')}</h2><p>{t('receive.subtitle')}</p></header>
    {!address ? <button className="primary" disabled={busy} onClick={() => void load()} type="button">{busy ? t('common.loading') : t('receive.showAddress')}</button> : <><section className="receive-address-card"><code className="address-output">{address}</code><div className="receive-actions"><button className="secondary" onClick={() => void copy()} type="button">{t('receive.copyAddress')}</button><button className="secondary" onClick={() => void share()} type="button">{t('receive.shareAddress')}</button>{wallet?.kind === 'hardware' && <button className="secondary" disabled={busy} onClick={() => void showOnLedger()} type="button">{t('receive.verifyLedger')}</button>}</div></section><div className="receive-qr"><div>{qrCode ? <img src={qrCode} alt="QR code for the displayed Monero receive address" /> : <span>{t('common.loading')}</span>}</div><p>{wallet?.kind === 'hardware' ? t('receive.ledgerHint') : t('receive.qrHint')}</p></div></>}
    <section className="subaddress-section"><div><strong>{t('receive.newSubaddress')}</strong><p>{t('receive.qrHint')}</p></div><label>{t('receive.subaddressLabel')}<input value={label} onChange={(event) => setLabel(event.target.value)} placeholder={t('receive.subaddressPlaceholder')} maxLength={80} /></label><button className="secondary" disabled={busy} onClick={() => void subaddress()} type="button">{t('receive.createSubaddress')}</button></section>
    {subaddresses.some((item) => item.address !== address) && <section className="subaddress-list">{subaddresses.filter((item) => item.address !== address).map((item) => <button key={`${item.accountIndex}-${item.addressIndex}`} onClick={() => { setAddress(item.address); setAddressIndex(item.addressIndex); setMessage(null); }} type="button"><span><strong>{item.label || `${t('receive.primaryAddress')} ${item.accountIndex}/${item.addressIndex}`}</strong><small>{item.address}</small></span><em>{item.accountIndex}/{item.addressIndex}</em></button>)}</section>}
    <RecentTransactions hasOpenWallet items={transactions} onActivity={onActivity} />
    {message && <p className="setup-message">{message}</p>}
  </section>;
}

function HardwareWalletCard({ walletId }: { walletId: string }) {
  const [status, setStatus] = useState<NativeHardwareWalletStatus | null>(null); const [message, setMessage] = useState<string | null>(null);
  const load = useCallback(async () => { try { const raw = await invoke<string>('wallet_hardware_status', { input: { walletId } }); setStatus(parseNativeJson<NativeHardwareWalletStatus>(raw, 'The Ledger status response was invalid.')); } catch (reason) { setMessage(errorMessage(reason, 'Could not read the Ledger connection status.')); } }, [walletId]);
  useEffect(() => { void load(); }, [load]);
  const reconnect = async () => { try { const raw = await invoke<string>('reconnect_hardware_wallet', { input: { walletId } }); setStatus(parseNativeJson<NativeHardwareWalletStatus>(raw, 'The Ledger reconnect response was invalid.')); setMessage(null); } catch (reason) { setMessage(errorMessage(reason, 'Ledger could not reconnect. Unlock it and open the Monero app, then try again.')); } };
  return <section className="hardware-card"><div><p className="eyebrow">Hardware wallet</p><h2>{status?.deviceName || 'Ledger'}</h2><p>{status ? status.connected ? `Connected · ${status.promptKind || 'ready'}` : 'Disconnected. Unlock it and open the Monero app.' : 'Checking the native hardware-wallet state.'}</p></div><button className="secondary" onClick={() => void reconnect()} type="button">Reconnect Ledger</button>{message && <p className="setup-message">{message}</p>}</section>;
}

function Activity({ linked, walletId, wallet }: { linked: boolean; walletId: string | null; wallet: RegisteredWallet | null }) {
  const { t } = useI18n();
  const [items, setItems] = useState<NativeTransaction[]>([]); const [message, setMessage] = useState<string | null>(null); const [selected, setSelected] = useState<NativeTransaction | null>(null);
  const load = useCallback(async () => { if (!walletId) return; try { const raw = await invoke<string>('wallet_transactions', { input: { walletId, accountIndex: wallet?.accountIndex ?? 0 } }); setItems(parseNativeJson<NativeTransaction[]>(raw, 'The native transaction history was invalid.')); setMessage(null); } catch (reason) { setMessage(errorMessage(reason, 'Could not load activity.')); } }, [walletId, wallet?.accountIndex]);
  useEffect(() => {
    if (!linked || !walletId) return;
    void load();
    const timer = window.setInterval(() => void load(), 10_000);
    return () => window.clearInterval(timer);
  }, [linked, walletId, load]);
  if (!linked || !walletId) return <WalletFeature linked={linked} title={t('activity.title')} text={t('home.openForActivity')} />;
  return <section className="activity-page"><header><div><h2>{t('activity.title')}</h2><p>{t('activity.subtitle')}</p></div></header>{items.length === 0 ? <div className="activity-empty">{t('activity.empty')}</div> : <div className="transaction-list">{items.map((item) => <button className={selected === item ? 'transaction-row selected' : 'transaction-row'} key={`${item.hash}-${item.direction}-${item.timestamp}`} onClick={() => setSelected(item)} type="button"><span className={item.direction === 'in' ? 'tx-direction incoming' : 'tx-direction'}>{item.direction === 'in' ? '↓' : '↑'}</span><div><strong>{item.direction === 'in' ? t('activity.received') : t('activity.sent')} · {formatAtomicXmr(item.amountAtomic, 12)} XMR</strong><small>{item.hash} · {item.confirmations} {t('activity.confirmations').toLowerCase()}{item.label ? ` · ${item.label}` : ''}</small></div><em>{item.failed ? t('activity.failed') : item.pending ? t('activity.pending') : t('activity.confirmed')}</em></button>)}</div>}{selected && <article className="transaction-detail"><header><div><p className="eyebrow">{t('activity.detail')}</p><h2>{selected.direction === 'in' ? t('activity.receivedMonero') : t('activity.sentMonero')}</h2></div><button className="quiet-button" onClick={() => setSelected(null)} type="button">{t('common.close')}</button></header><dl className="transaction-detail-grid"><div><dt>{t('activity.status')}</dt><dd>{selected.failed ? t('activity.failed') : selected.pending ? t('activity.pending') : t('activity.confirmed')}</dd></div><div><dt>{t('activity.amount')}</dt><dd>{formatAtomicXmr(selected.amountAtomic, 12)} XMR</dd></div><div><dt>{t('activity.fee')}</dt><dd>{formatAtomicXmr(selected.feeAtomic, 12)} XMR</dd></div><div><dt>{t('activity.confirmations')}</dt><dd>{selected.confirmations}</dd></div><div><dt>{t('activity.blockHeight')}</dt><dd>{selected.blockHeight || t('activity.notIncluded')}</dd></div><div><dt>{t('activity.time')}</dt><dd>{transactionTimestamp(selected.timestamp)}</dd></div><div><dt>{t('activity.account')}</dt><dd>{selected.subaddressAccount}</dd></div><div><dt>{t('activity.indices')}</dt><dd>{selected.subaddressIndices.length ? selected.subaddressIndices.join(', ') : t('activity.notSpecified')}</dd></div></dl>{selected.label && <p><strong>{t('activity.label')}:</strong> {selected.label}</p>}{selected.description && <p><strong>{t('activity.description')}:</strong> {selected.description}</p>}{selected.paymentId && <p><strong>{t('activity.paymentId')}:</strong> <code>{selected.paymentId}</code></p>}<div className="transaction-hash"><strong>{t('activity.hash')}</strong><code>{selected.hash}</code></div>{selected.transfers.length > 0 && <div className="transaction-transfers"><strong>{selected.direction === 'in' ? t('activity.incoming') : t('activity.recipients')}</strong>{selected.transfers.map((transfer, index) => <p key={`${transfer.address}-${index}`}><code>{transfer.address}</code><span>{formatAtomicXmr(transfer.amountAtomic, 12)} XMR</span></p>)}</div>}</article>}{message && <p className="setup-message">{message}</p>}</section>;
}

type AssistantMessage = { id: string; sender: 'assistant' | 'user'; text: string; destination?: Section };
function assistantReply(input: string, wallet: RegisteredWallet | null, walletId: string | null, fastWallets: FastWalletRecord[]): Omit<AssistantMessage, 'id' | 'sender'> {
  const normalized = input.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  if (/(ledger|nano|hardware|device)/.test(normalized)) return { text: wallet?.kind === 'hardware' && walletId ? 'The open wallet is Ledger-backed. Use the native reconnect and address-confirmation controls; signing authority stays on the Ledger.' : 'Connect and unlock the Ledger Nano, open its Monero app, then use Wallet Setup. Desktop uses the native USB/HID path.', destination: 'setup' };
  if (/(fast|hosted|scanner|view key|viewkey|notification)/.test(normalized)) { const enabled = fastWallets.filter((item) => item.status === 'enabled').length; return { text: `Fast Wallet is opt-in. ${fastWallets.length} local isolated identit${fastWallets.length === 1 ? 'y exists' : 'ies exist'}, ${enabled} scanner-enabled. A scanner can receive only a Fast Wallet private view key after explicit consent; it never receives the main-wallet key or any spend key.`, destination: 'wallets' }; }
  if (/(send|pay|transfer|zahlung)/.test(normalized)) return { text: walletId ? 'Send uses a two-step native review and explicit commit. Review the recipient and fee before committing.' : 'Open a wallet first, then Send can prepare and review a native Monero transaction.', destination: 'send' };
  if (/(receive|address|qr|empfang)/.test(normalized)) return { text: walletId ? 'Receive can show the verified local address, create a subaddress, and render its QR locally.' : 'Open a wallet first to read a verified receive address from the native wallet.', destination: 'receive' };
  if (/(community|enthusiast|nearby|meet|treffen)/.test(normalized)) return { text: 'Monero Enthusiasts is optional. It uses only an approximate area for discovery; exact location and wallet data are never sent.', destination: 'community' };
  if (/(privacy|seed|spend|key|private)/.test(normalized)) return { text: 'Seeds, wallet files, private spend keys, and the main wallet private view key remain local. Only the explicit recovery-seed backup view can disclose a seed to this device’s user.', destination: 'settings' };
  return { text: `I can help route Wallet, Send, Receive, Ledger, Fast Wallet, privacy, and Monero Enthusiasts. ${wallet ? `Current wallet: ${walletDisplayName(wallet)} on ${networkLabel(wallet.network)}.` : 'No wallet is currently open.'}` };
}
function Assistant({ wallet, walletId, onNavigate }: { wallet: RegisteredWallet | null; walletId: string | null; onNavigate: (section: Section) => void }) {
  const [input, setInput] = useState(''); const [fastWallets, setFastWallets] = useState<FastWalletRecord[]>([]); const [messages, setMessages] = useState<AssistantMessage[]>([{ id: 'welcome', sender: 'assistant', text: 'Tex8 Assistant can route local wallet features. It never receives wallet keys, seeds, passwords, or transaction authority.' }]);
  useEffect(() => { void invoke<FastWalletRecord[]>('list_fast_wallets').then(setFastWallets).catch(() => undefined); }, []);
  const send = (value: string) => { const text = value.trim(); if (!text) return; const answer = assistantReply(text, wallet, walletId, fastWallets); setMessages((items) => [...items, { id: `user-${Date.now()}`, sender: 'user', text }, { id: `assistant-${Date.now()}`, sender: 'assistant', ...answer }]); setInput(''); };
  const prompts = ['Ledger Nano status', 'Fast Wallet privacy', 'Receive address', 'Send XMR', 'Monero enthusiasts'];
  return <section className="assistant-page"><header><div><p className="eyebrow">Tex8 Shared · local routing</p><h2>Assistant</h2><p>Answers use only the visible desktop state and provide navigation. No prompt is sent to a remote model by this feature.</p></div></header><div className="assistant-messages">{messages.map((message) => <article className={message.sender === 'user' ? 'assistant-message user' : 'assistant-message'} key={message.id}><p>{message.text}</p>{message.destination && <button className="secondary" onClick={() => onNavigate(message.destination!)} type="button">Open {message.destination === 'setup' ? 'Wallet Setup' : message.destination[0].toUpperCase() + message.destination.slice(1)}</button>}</article>)}</div><div className="assistant-prompts">{prompts.map((prompt) => <button className="quiet-button" onClick={() => send(prompt)} key={prompt} type="button">{prompt}</button>)}</div><div className="assistant-composer"><textarea value={input} onChange={(event) => setInput(event.target.value)} placeholder="Ask about wallet features…" maxLength={1000} /><button className="primary" disabled={!input.trim()} onClick={() => send(input)} type="button">Ask</button></div></section>;
}
function CommunityConversation({ peer, ownIdentityId, onClose, onBlocked }: { peer: CommunityContact; ownIdentityId: string; onClose: () => void; onBlocked: () => void }) {
  const [messages, setMessages] = useState<CommunityMessage[]>([]); const [body, setBody] = useState(''); const [message, setMessage] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  const load = useCallback(async () => { try { setMessages(await invoke<CommunityMessage[]>('community_list_messages', { input: { peerId: peer.identityId, afterMs: 0 } })); setMessage(null); } catch (reason) { setMessage(errorMessage(reason, 'Could not load the private conversation.')); } }, [peer.identityId]);
  useEffect(() => { void load(); }, [load]);
  const send = async () => { if (!body.trim()) return; setBusy(true); try { await invoke<CommunityMessage>('community_send_message', { input: { peerId: peer.identityId, body } }); setBody(''); await load(); } catch (reason) { setMessage(errorMessage(reason, 'Could not send the message.')); } finally { setBusy(false); } };
  const block = async () => { try { await invoke<void>('community_block_profile', { input: { peerId: peer.identityId } }); onBlocked(); } catch (reason) { setMessage(errorMessage(reason, 'Could not block this profile.')); } };
  return <article className="community-conversation"><header><div><p className="eyebrow">Private Community chat</p><h2>{peer.displayName}</h2></div><button className="quiet-button" onClick={onClose} type="button">Close chat</button></header><p className="community-chat-note">Messages are Community content only. Never share a recovery seed, private key, wallet password, or wallet address here.</p><div className="community-messages">{messages.length === 0 ? <p>No messages yet. Say hello when you are ready.</p> : messages.map((item) => <article className={item.senderId === ownIdentityId ? 'community-message own' : 'community-message'} key={item.id}><p>{item.body}</p><small>{item.senderId === ownIdentityId ? 'You' : peer.displayName} · {communityTimestamp(item.sentAtMs)}</small></article>)}</div><div className="community-composer"><textarea value={body} onChange={(event) => setBody(event.target.value)} maxLength={1200} placeholder="Message" /><div><button className="secondary" onClick={() => void load()} type="button">Refresh</button><button className="primary" disabled={busy || !body.trim()} onClick={() => void send()} type="button">{busy ? 'Sending…' : 'Send'}</button></div></div><button className="danger-button" onClick={() => void block()} type="button">Block profile</button>{message && <p className="setup-message">{message}</p>}</article>;
}

function Community() {
  const { t } = useI18n();
  const [profile, setProfile] = useState<CommunityProfile | null>(null); const [nearby, setNearby] = useState<CommunityNearby[]>([]); const [contacts, setContacts] = useState<CommunityContact[]>([]); const [displayName, setDisplayName] = useState(''); const [bio, setBio] = useState(''); const [radiusKm, setRadiusKm] = useState(10); const [areaId, setAreaId] = useState<string | null>(null); const [message, setMessage] = useState<string | null>(null); const [busy, setBusy] = useState(false); const [chatPeer, setChatPeer] = useState<CommunityContact | null>(null); const [reportPeer, setReportPeer] = useState<CommunityProfile | null>(null); const [reportReason, setReportReason] = useState('');
  const refresh = useCallback(async () => { setBusy(true); try { const nextProfile = await invoke<CommunityProfile>('community_load_profile'); const [nextNearby, nextContacts] = await Promise.all([invoke<CommunityNearby[]>('community_list_nearby', { input: { radiusKm: nextProfile.radiusKm } }), invoke<CommunityContact[]>('community_list_contacts')]); setProfile(nextProfile); setDisplayName(nextProfile.displayName); setBio(nextProfile.bio); setRadiusKm(nextProfile.radiusKm); setNearby(nextNearby); setContacts(nextContacts); setMessage(nextProfile.visible ? 'Visibility needs a fresh approximate location after every desktop restart.' : null); } catch { setMessage(t('community.offline')); } finally { setBusy(false); } }, [t]);
  useEffect(() => { void refresh(); }, [refresh]);
  const saveProfile = async (visible: boolean, nextAreaId: string | null) => { setBusy(true); try { const next = await invoke<CommunityProfile>('community_update_profile', { input: { displayName, bio, areaId: visible ? nextAreaId : null, visible, radiusKm } }); setProfile(next); if (!visible) setAreaId(null); await refresh(); } catch (reason) { setMessage(errorMessage(reason, 'Could not update the Community profile.')); } finally { setBusy(false); } };
  const enableVisibility = async () => { setBusy(true); try { let permissions = await checkPermissions(); if (permissions.location !== 'granted') permissions = await requestPermissions(['location']); if (permissions.location !== 'granted') throw new Error('Approximate location permission is required before you can become visible.'); const position = await getCurrentPosition({ enableHighAccuracy: false, timeout: 10_000, maximumAge: 60_000 }); const approximateArea = approximateAreaForCoordinates(position.coords.latitude, position.coords.longitude); setAreaId(approximateArea); await saveProfile(true, approximateArea); setMessage('Visible in one broad approximate area. Exact coordinates were discarded.'); } catch (reason) { setMessage(errorMessage(reason, 'Approximate location could not be used.')); } finally { setBusy(false); } };
  const requestContact = async (person: CommunityNearby) => { try { if (person.relationship === 'incoming') await invoke<void>('community_accept_contact', { input: { peerId: person.identityId } }); else await invoke<void>('community_request_contact', { input: { peerId: person.identityId } }); await refresh(); } catch (reason) { setMessage(errorMessage(reason, 'Could not update the connection request.')); } };
  const submitReport = async () => { if (!reportPeer) return; try { await invoke<void>('community_report_profile', { input: { peerId: reportPeer.identityId, reason: reportReason } }); setReportPeer(null); setReportReason(''); setMessage('Report sent to the Community service.'); } catch (reason) { setMessage(errorMessage(reason, 'Could not send the report.')); } };
  if (chatPeer && profile) return <CommunityConversation peer={chatPeer} ownIdentityId={profile.identityId} onClose={() => setChatPeer(null)} onBlocked={() => { setChatPeer(null); void refresh(); }} />;
  return <section className="community-page"><header><div><p className="eyebrow">Optional private discovery</p><h2>Monero enthusiasts</h2><p>Only an anonymous profile and one broad five-character area are sent to the Community service. Wallet addresses, balances, transactions, seeds, and exact coordinates are never included.</p></div><button className="secondary" disabled={busy} onClick={() => void refresh()} type="button">{busy ? 'Working…' : 'Refresh'}</button></header><article className="community-profile-card"><div><h3>Visible nearby</h3><p>{profile?.visible && areaId ? 'Visible in this desktop session within a broad area.' : profile?.visible ? 'Previously visible. Share a fresh approximate area to renew visibility.' : 'Not visible to others.'}</p></div><button className={profile?.visible && areaId ? 'secondary' : 'primary'} disabled={busy} onClick={() => { if (profile?.visible && areaId) void saveProfile(false, null); else void enableVisibility(); }} type="button">{profile?.visible && areaId ? 'Stop visibility' : 'Use approximate location'}</button></article><article className="community-settings"><label>Your public alias<input value={displayName} onChange={(event) => setDisplayName(event.target.value)} maxLength={80} /></label><label>Short public bio (optional)<textarea value={bio} onChange={(event) => setBio(event.target.value)} maxLength={280} /></label><label>Search area<select value={radiusKm} onChange={(event) => setRadiusKm(Number(event.target.value))}><option value={5}>5 km</option><option value={10}>10 km</option><option value={25}>25 km</option></select></label><button className="secondary" disabled={busy || (profile?.visible === true && !areaId)} onClick={() => void saveProfile(Boolean(profile?.visible && areaId), areaId)} type="button">Save public profile</button>{profile?.visible && !areaId && <p className="feature-lock">Share approximate location again before changing a visible profile.</p>}</article><section className="community-section"><h3>Connections</h3>{contacts.length === 0 ? <p className="community-empty">No accepted contacts yet.</p> : <div className="community-people">{contacts.map((person) => <article key={person.identityId}><div><strong>{person.displayName}</strong><p>{person.status === 'connected' ? 'Accepted contact' : person.status === 'incoming' ? 'Wants to connect' : 'Request sent'}</p></div>{person.status === 'connected' ? <button className="secondary" onClick={() => setChatPeer(person)} type="button">Chat</button> : person.status === 'incoming' ? <button className="secondary" onClick={() => void requestContact({ ...person, approximateDistanceKm: 0, relationship: 'incoming' })} type="button">Accept</button> : null}</article>)}</div>}</section><section className="community-section"><h3>Nearby</h3>{nearby.length === 0 ? <p className="community-empty">No one nearby yet. People appear only when they choose the same broad approximate area.</p> : <div className="community-people">{nearby.map((person) => <article key={person.identityId}><div><strong>{person.displayName}</strong><p>About {person.approximateDistanceKm} km away · {person.relationship === 'connected' ? 'Accepted contact' : person.relationship === 'incoming' ? 'Wants to connect' : person.relationship === 'outgoing' ? 'Request sent' : 'New profile'}</p></div><div className="community-actions">{person.relationship === 'connected' ? <button className="secondary" onClick={() => setChatPeer({ ...person, status: 'connected' })} type="button">Chat</button> : person.relationship === 'outgoing' ? null : <button className="secondary" onClick={() => void requestContact(person)} type="button">{person.relationship === 'incoming' ? 'Accept' : 'Connect'}</button>}<button className="quiet-button" onClick={() => setReportPeer(person)} type="button">Report</button></div></article>)}</div>}</section>{reportPeer && <article className="community-report"><h3>Report {reportPeer.displayName}</h3><textarea value={reportReason} onChange={(event) => setReportReason(event.target.value)} maxLength={500} placeholder="Why are you reporting this profile?" /><div><button className="quiet-button" onClick={() => setReportPeer(null)} type="button">Cancel</button><button className="danger-button" disabled={!reportReason.trim()} onClick={() => void submitReport()} type="button">Send report</button></div></article>}<article className="community-delete"><div><h3>Delete Community profile</h3><p>This removes the anonymous profile, contacts, and messages from the Community server. It never affects wallet files or wallet data.</p></div><button className="danger-button" disabled={busy || !profile} onClick={() => { if (window.confirm('Delete the anonymous Community profile, contacts, and messages?')) void invoke<void>('community_delete_identity').then(() => { setProfile(null); setNearby([]); setContacts([]); setAreaId(null); setDisplayName(''); setBio(''); setMessage('Community profile deleted.'); }).catch((reason) => setMessage(errorMessage(reason, 'Could not delete the Community profile.'))); }} type="button">Delete profile</button></article>{message && <p className="setup-message">{message}</p>}</section>;
}

function settingsProfileSignature(profile: NodeProfile | null) { return profile ? JSON.stringify({ mode: profile.mode, network: profile.network, daemonAddress: profile.daemonAddress, grpcEndpoint: profile.grpcEndpoint, trusted: profile.trusted, useSsl: profile.useSsl, username: profile.username, proxyAddress: profile.proxyAddress, passwordStored: profile.passwordStored }) : ''; }
function defaultNodeProfile(network: Network, mode: NodeProfile['mode'] = 'optimized-grpc'): NodeProfile { const ports: Record<Network, { daemon: number; rpc: number; grpc: number }> = { mainnet: { daemon: 18089, rpc: 18081, grpc: 18091 }, testnet: { daemon: 28089, rpc: 28081, grpc: 28091 }, stagenet: { daemon: 38089, rpc: 38081, grpc: 38091 } }; const values = ports[network]; return { mode, network, daemonAddress: `xmr.tex8.com:${mode === 'original-rpc' ? values.rpc : values.daemon}`, grpcEndpoint: mode === 'original-rpc' ? '' : `xmr.tex8.com:${values.grpc}`, trusted: true, useSsl: false, username: '', proxyAddress: '', passwordStored: false, updatedAt: 0 }; }
function Settings({ status, walletId, wallet, onRevealSeed, onCloseWallet, autoLockEnabled, onAutoLockChange }: { status: WalletCoreStatus | null; walletId: string | null; wallet: RegisteredWallet | null; onRevealSeed: () => void; onCloseWallet: () => void; autoLockEnabled: boolean; onAutoLockChange: (value: boolean) => void }) {
  const [network, setNetwork] = useState<Network>(wallet?.network ?? 'mainnet'); const [profile, setProfile] = useState<NodeProfile | null>(null); const [savedProfile, setSavedProfile] = useState<NodeProfile | null>(null); const [password, setPassword] = useState(''); const [clearPassword, setClearPassword] = useState(false); const [message, setMessage] = useState<string | null>(null); const [busy, setBusy] = useState(false); const [diagnostics, setDiagnostics] = useState<SettingsDiagnostic[]>([]); const [diagnosing, setDiagnosing] = useState(false); const [newPassword, setNewPassword] = useState(''); const [confirmPassword, setConfirmPassword] = useState(''); const [changingPassword, setChangingPassword] = useState(false);
  useEffect(() => { if (wallet?.network) setNetwork(wallet.network); }, [wallet?.network]);
  const load = useCallback(async () => { try { const saved = await invoke<NodeProfile>('load_node_settings', { network }); setProfile(saved); setSavedProfile(saved); setPassword(''); setClearPassword(false); } catch (reason) { setMessage(errorMessage(reason, 'Could not load saved node settings.')); } }, [network]);
  useEffect(() => { void load(); }, [load]);
  const changed = settingsProfileSignature(profile) !== settingsProfileSignature(savedProfile) || Boolean(password) || clearPassword;
  const changeMode = (mode: NodeProfile['mode']) => { if (!profile) return; if (mode === 'custom') { setProfile({ ...profile, mode }); return; } const defaults = defaultNodeProfile(profile.network, mode); setProfile({ ...profile, ...defaults, username: profile.username, proxyAddress: profile.proxyAddress, passwordStored: profile.passwordStored }); };
  const reset = () => { setProfile(defaultNodeProfile(network)); setPassword(''); setClearPassword(false); };
  const save = async () => { if (!profile) return; setBusy(true); try { const appliesToOpenWallet = wallet?.network === profile.network ? walletId : null; const saved = await invoke<NodeProfile>('save_node_settings', { input: { walletId: appliesToOpenWallet, mode: profile.mode, network: profile.network, daemonAddress: profile.daemonAddress, grpcEndpoint: profile.grpcEndpoint, trusted: profile.trusted, useSsl: profile.useSsl, username: profile.username, password, proxyAddress: profile.proxyAddress, clearPassword } }); setProfile(saved); setSavedProfile(saved); setPassword(''); setClearPassword(false); setMessage(appliesToOpenWallet ? 'Node profile saved and applied to the open wallet.' : `Node profile for ${networkLabel(saved.network)} saved.`); } catch (reason) { setPassword(''); setMessage(errorMessage(reason, 'Could not save node settings.')); } finally { setBusy(false); } };
  const runDiagnostics = async () => { setDiagnosing(true); try { const [core, fastWallets] = await Promise.all([invoke<WalletCoreStatus>('wallet_core_status'), invoke<FastWalletRecord[]>('list_fast_wallets').catch(() => [])]); let sync = 'No wallet open'; if (walletId) { try { sync = syncLabel(parseNativeJson<NativeWalletSnapshot>(await invoke<string>('wallet_snapshot', { input: { walletId } }), 'Invalid wallet snapshot.')); } catch { sync = 'Wallet snapshot unavailable'; } } setDiagnostics([{ label: 'Native wallet core', value: core.linked ? 'Linked' : 'Not linked', tone: core.linked ? 'good' : 'warning' }, { label: 'Active wallet', value: wallet ? `${wallet.walletName} · ${networkLabel(wallet.network)}` : 'None', tone: wallet ? 'good' : 'neutral' }, { label: 'Sync', value: sync, tone: sync.startsWith('Synchronized') ? 'good' : 'neutral' }, { label: 'Node', value: profile ? `${profile.mode} · ${profile.daemonAddress}` : 'Loading', tone: profile ? 'good' : 'warning' }, { label: 'gRPC', value: profile?.grpcEndpoint || 'Disabled', tone: profile?.grpcEndpoint ? 'good' : 'neutral' }, { label: 'Fast Wallet identities', value: String(fastWallets.length), tone: 'neutral' }, { label: 'Secrets', value: 'macOS Keychain', tone: 'good' }]); } catch (reason) { setMessage(errorMessage(reason, 'Could not run diagnostics.')); } finally { setDiagnosing(false); } };
  const saveNewPassword = async () => { if (!walletId || !newPassword) { setMessage('Open a wallet and choose a new password first.'); return; } if (newPassword !== confirmPassword) { setMessage('The new passwords do not match.'); return; } setChangingPassword(true); try { await invoke<void>('change_wallet_password', { input: { walletId, newPassword } }); setNewPassword(''); setConfirmPassword(''); setMessage('Wallet password changed. The new password is not stored by the desktop app.'); } catch (reason) { setMessage(errorMessage(reason, 'Could not change the wallet password.')); } finally { setChangingPassword(false); } };
  const torEnabled = profile?.proxyAddress === '127.0.0.1:9050';
  return <section className="settings-page"><header className="settings-header"><img src="/monero-mark.png" alt="" /><div><p className="eyebrow">Monero Fast Wallet</p><h2>Settings</h2><p>Desktop wallet controls mirror the mobile app while keeping keys and credentials local.</p></div><span>Desktop</span></header><section className="settings-section"><header><h3>Wallet</h3><small>{wallet ? `${wallet.walletName} · ${networkLabel(wallet.network)} · ${wallet.kind}` : 'No wallet open'}</small></header><article className="settings-panel settings-wallet-actions"><div><div><strong>Recovery seed</strong><p>{wallet?.kind === 'hardware' ? 'The recovery seed remains on the Ledger device.' : 'Reveal only while this local wallet is open.'}</p></div></div><button className="secondary" disabled={!walletId || wallet?.kind === 'hardware'} onClick={onRevealSeed} type="button">Show recovery seed</button></article><article className="settings-panel password-change"><div><strong>Change wallet password</strong><p>Changing the password requires the wallet to be open. The new password is never saved by this app.</p></div><div className="password-fields"><input value={newPassword} onChange={(event) => setNewPassword(event.target.value)} type="password" autoComplete="new-password" placeholder="New wallet password" /><input value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} type="password" autoComplete="new-password" placeholder="Confirm new password" /><button className="secondary" disabled={!walletId || changingPassword || !newPassword || !confirmPassword} onClick={() => void saveNewPassword()} type="button">{changingPassword ? 'Changing…' : 'Change password'}</button></div></article></section><section className="settings-section"><header><h3>Security</h3><small>Local controls</small></header><article className="settings-panel settings-toggle-row"><div><strong>Auto-lock after 5 minutes</strong><p>Locks the open wallet after the desktop app has been in the background for five minutes.</p></div><label className="toggle"><input checked={autoLockEnabled} onChange={(event) => onAutoLockChange(event.target.checked)} type="checkbox" /><span /></label></article><article className="settings-panel settings-info-row"><div><strong>Secure storage</strong><p>Node credentials and Fast Wallet scanner credentials stay in macOS Keychain. Recovery seeds and spend keys are never stored in this settings view.</p></div><span className="status-good">Keychain</span></article></section><section className="settings-section"><header><h3>Node</h3><small>{changed ? 'Unsaved changes' : savedProfile ? 'Saved' : 'Loading'}</small></header><article className="settings-panel node-settings"><p>{wallet ? `${wallet.walletName} uses its ${networkLabel(wallet.network)} profile when you save that network.` : 'Configure a network profile before opening a wallet.'}</p>{profile && <><div className="settings-field"><span>Network</span><div className="node-mode">{(['mainnet', 'testnet', 'stagenet'] as Network[]).map((item) => <button className={network === item ? 'selected' : ''} onClick={() => setNetwork(item)} key={item} type="button">{networkLabel(item)}</button>)}</div></div><div className="settings-field"><span>Connection</span><div className="node-mode">{([['optimized-grpc', 'Optimized'], ['original-rpc', 'Original RPC'], ['custom', 'Custom']] as const).map(([mode, label]) => <button className={profile.mode === mode ? 'selected' : ''} onClick={() => changeMode(mode)} key={mode} type="button">{label}</button>)}</div></div><div className="node-hint">{profile.mode === 'original-rpc' ? 'Original Monero daemon RPC. gRPC is disabled for this profile.' : profile.mode === 'optimized-grpc' ? 'Optimized Cuprate gRPC profile, matching the mobile default.' : 'Custom node endpoints remain local to this device.'}</div><div className="settings-form-grid"><label>Daemon address<input value={profile.daemonAddress} onChange={(event) => setProfile({ ...profile, daemonAddress: event.target.value })} placeholder="node.example:18089" autoComplete="off" /></label>{profile.mode !== 'original-rpc' && <label>Cuprate gRPC endpoint<input value={profile.grpcEndpoint} onChange={(event) => setProfile({ ...profile, grpcEndpoint: event.target.value })} placeholder="node.example:18091" autoComplete="off" /></label>}<label>Node username <small>Optional</small><input value={profile.username} onChange={(event) => setProfile({ ...profile, username: event.target.value })} autoComplete="off" /></label><label>Node password <small>Optional · Keychain only</small><input value={password} onChange={(event) => { setPassword(event.target.value); setClearPassword(false); }} type="password" autoComplete="new-password" placeholder={profile.passwordStored ? 'Password stored in Keychain' : 'Stored only in Keychain'} /></label><label>SOCKS5 proxy <small>Optional</small><input value={profile.proxyAddress} onChange={(event) => setProfile({ ...profile, proxyAddress: event.target.value })} placeholder="127.0.0.1:9050" autoComplete="off" /></label></div><div className="settings-checkboxes"><label className="checkbox"><input checked={profile.trusted} onChange={(event) => setProfile({ ...profile, trusted: event.target.checked })} type="checkbox" />Trusted node</label><label className="checkbox"><input checked={profile.useSsl} onChange={(event) => setProfile({ ...profile, useSsl: event.target.checked })} type="checkbox" />Use SSL/TLS for daemon RPC</label><label className="checkbox"><input checked={torEnabled} onChange={(event) => setProfile({ ...profile, proxyAddress: event.target.checked ? '127.0.0.1:9050' : '' })} type="checkbox" />Use Tor via local SOCKS5</label>{profile.passwordStored && <label className="checkbox"><input checked={clearPassword} onChange={(event) => setClearPassword(event.target.checked)} type="checkbox" />Forget stored node password</label>}</div><div className="settings-actions"><button className="secondary" onClick={reset} type="button">Reset defaults</button><button className="primary" disabled={busy || !changed} onClick={() => void save()} type="button">{busy ? 'Saving…' : wallet?.network === profile.network && walletId ? 'Save & apply node' : 'Save node profile'}</button></div></>}</article></section><section className="settings-section"><header><h3>Diagnostics</h3><small>{diagnosing ? 'Running…' : diagnostics.length ? 'Updated' : 'Ready'}</small></header><article className="settings-panel">{diagnostics.length > 0 && <div className="settings-diagnostics">{diagnostics.map((item) => <div key={item.label}><span>{item.label}</span><strong className={item.tone ?? 'neutral'}>{item.value}</strong></div>)}</div>}<button className="primary" disabled={diagnosing} onClick={() => void runDiagnostics()} type="button">{diagnosing ? 'Running diagnostics…' : 'Run diagnostics'}</button></article></section><section className="settings-section settings-about"><header><h3>About</h3><small>Local desktop build</small></header><article className="settings-panel"><div><strong>Privacy by design</strong><p>The packaged interface contains no remote web content. Wallet keys, passwords, transaction signing, and recovery seeds remain in the native Monero core.</p></div><div><strong>Market display</strong><p>Dashboard values use XMR/USD, the same default display as the mobile wallet.</p></div><div><strong>Open-source components</strong><p>Built with Tauri, React, Rust, and the pinned fork of Monero libwallet_api.</p></div></article></section><button className="danger-button settings-lock" disabled={!walletId} onClick={onCloseWallet} type="button">Close wallet</button>{message && <p className="setup-message">{message}</p>}</section>;
}

function LeanSettings({ status, walletId, wallet, onRevealSeed, onCloseWallet, autoLockEnabled, onAutoLockChange }: { status: WalletCoreStatus | null; walletId: string | null; wallet: RegisteredWallet | null; onRevealSeed: () => void; onCloseWallet: () => void; autoLockEnabled: boolean; onAutoLockChange: (value: boolean) => void }) {
  const { language, setLanguage, t } = useI18n();
  const [network, setNetwork] = useState<Network>(wallet?.network ?? 'mainnet');
  const [profile, setProfile] = useState<NodeProfile | null>(null);
  const [savedProfile, setSavedProfile] = useState<NodeProfile | null>(null);
  const [nodePassword, setNodePassword] = useState('');
  const [clearPassword, setClearPassword] = useState(false);
  const [walletPassword, setWalletPassword] = useState('');
  const [confirmWalletPassword, setConfirmWalletPassword] = useState('');
  const [changingWalletPassword, setChangingWalletPassword] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notificationState, setNotificationState] = useState<DesktopNotificationStatus | null>(null);
  const [notificationBusy, setNotificationBusy] = useState(false);

  useEffect(() => { if (wallet?.network) setNetwork(wallet.network); }, [wallet?.network]);
  const load = useCallback(async () => {
    try {
      const loaded = await invoke<NodeProfile>('load_node_settings', { network });
      setProfile(loaded); setSavedProfile(loaded); setNodePassword(''); setClearPassword(false);
    } catch (reason) { setMessage(errorMessage(reason, t('settings.nodeLoadFailed'))); }
  }, [network, t]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { void desktopNotificationStatus().then(setNotificationState); }, []);

  const changed = profile ? settingsProfileSignature(profile) !== settingsProfileSignature(savedProfile) || Boolean(nodePassword) || clearPassword : false;
  const useMode = (mode: NodeProfile['mode']) => {
    if (!profile) return;
    if (mode === 'custom') { setProfile({ ...profile, mode }); return; }
    const defaults = defaultNodeProfile(profile.network, mode);
    setProfile({ ...profile, ...defaults, username: profile.username, proxyAddress: profile.proxyAddress, passwordStored: profile.passwordStored });
  };
  const save = async () => {
    if (!profile) return;
    setBusy(true); setMessage(null);
    try {
      const saved = await invoke<NodeProfile>('save_node_settings', { input: {
        walletId: wallet?.network === profile.network ? walletId : null,
        mode: profile.mode, network: profile.network, daemonAddress: profile.daemonAddress,
        grpcEndpoint: profile.grpcEndpoint, trusted: profile.trusted, useSsl: profile.useSsl,
        username: profile.username, password: nodePassword, proxyAddress: profile.proxyAddress, clearPassword,
      } });
      setProfile(saved); setSavedProfile(saved); setNodePassword(''); setClearPassword(false);
      setMessage(wallet?.network === saved.network && walletId ? t('settings.nodeApplied') : t('settings.nodeSaved', { network: networkLabel(saved.network) }));
    } catch (reason) { setNodePassword(''); setMessage(errorMessage(reason, t('settings.nodeSaveFailed'))); }
    finally { setBusy(false); }
  };
  const setFastWalletNotifications = async (enabled: boolean) => {
    setNotificationBusy(true); setMessage(null);
    try {
      const next = enabled ? await enableDesktopFastWalletSignals() : await disableDesktopFastWalletSignals();
      setNotificationState(next);
      setMessage(enabled
        ? next.permission === 'granted' ? t('settings.notificationsEnabled') : t('settings.notificationsDenied')
        : t('settings.notificationsDisabled'));
    } catch (reason) { setMessage(errorMessage(reason, t('settings.notificationsError'))); }
    finally { setNotificationBusy(false); }
  };
  const testFastWalletNotification = async () => {
    setNotificationBusy(true); setMessage(null);
    try {
      const shown = await sendPrivacySafeNotificationTest();
      setNotificationState(await desktopNotificationStatus());
      setMessage(shown ? t('settings.notificationTestSent') : t('settings.notificationTestUnavailable'));
    } catch (reason) { setMessage(errorMessage(reason, t('settings.notificationsError'))); }
    finally { setNotificationBusy(false); }
  };
  const changeWalletPassword = async () => {
    if (!walletId || !wallet || wallet.kind === 'hardware') return;
    if (walletPassword.length < 8) { setMessage(t('settings.passwordMinimum')); return; }
    if (walletPassword !== confirmWalletPassword) { setMessage(t('settings.passwordMismatch')); return; }
    setChangingWalletPassword(true); setMessage(null);
    try {
      await invoke<void>('change_wallet_password', { input: { walletId, newPassword: walletPassword } });
      setWalletPassword(''); setConfirmWalletPassword(''); setMessage(t('settings.passwordChanged'));
    } catch (reason) { setMessage(errorMessage(reason, t('setup.operationFailed'))); }
    finally { setChangingWalletPassword(false); }
  };

  return <section className="settings-page">
    <header className="settings-header"><img src="/monero-mark.png" alt="" /><div><p className="eyebrow">Monero Fast Wallet</p><h2>{t('settings.title')}</h2><p>{t('settings.subtitle')}</p></div><span>{status?.linked ? t('settings.ready') : t('settings.checking')}</span></header>
    <section className="settings-section"><header><h3>{t('settings.language')}</h3><small>{t('settings.languageHint')}</small></header>
      <article className="settings-panel settings-language"><button className={language === 'de' ? 'selected' : ''} onClick={() => setLanguage('de')} type="button">Deutsch</button><button className={language === 'en' ? 'selected' : ''} onClick={() => setLanguage('en')} type="button">English</button></article>
    </section>
    <section className="settings-section"><header><h3>{t('settings.wallet')}</h3><small>{wallet ? `${walletDisplayName(wallet)} · ${networkLabel(wallet.network)}` : t('settings.noWalletOpen')}</small></header>
      <article className="settings-panel settings-wallet-actions"><div><strong>{t('settings.recoverySeed')}</strong><p>{wallet?.kind === 'hardware' ? t('settings.seedHardware') : t('settings.seedHint')}</p></div><button className="secondary" disabled={!walletId || wallet?.kind === 'hardware'} onClick={onRevealSeed} type="button">{t('settings.showRecoverySeed')}</button></article>
      <article className="settings-panel password-change"><div><strong>{t('settings.changePassword')}</strong><p>{wallet?.kind === 'hardware' ? t('settings.passwordHardware') : t('settings.passwordHint')}</p></div>{wallet && wallet.kind !== 'hardware' && <div className="password-fields"><input value={walletPassword} onChange={(event) => setWalletPassword(event.target.value)} type="password" autoComplete="new-password" placeholder={t('settings.newWalletPassword')} /><input value={confirmWalletPassword} onChange={(event) => setConfirmWalletPassword(event.target.value)} type="password" autoComplete="new-password" placeholder={t('settings.confirmWalletPassword')} /><button className="secondary" disabled={!walletId || changingWalletPassword || !walletPassword || !confirmWalletPassword} onClick={() => void changeWalletPassword()} type="button">{changingWalletPassword ? t('settings.changingPassword') : t('settings.changePassword')}</button></div>}</article>
      <article className="settings-panel settings-info-row"><div><strong>{t('settings.unlock')}</strong><p>{t('settings.unlockHint')}</p></div><span className="status-good">{t('settings.keychain')}</span></article>
    </section>
    <section className="settings-section"><header><h3>{t('settings.security')}</h3><small>{t('settings.localDevice')}</small></header>
      <article className="settings-panel settings-toggle-row"><div><strong>{t('settings.autoLock')}</strong><p>{t('settings.autoLockHint')}</p></div><label className="toggle"><input checked={autoLockEnabled} onChange={(event) => onAutoLockChange(event.target.checked)} type="checkbox" /><span /></label></article>
    </section>
    <section className="settings-section"><header><h3>{t('settings.notifications')}</h3><small>{notificationState?.permission === 'granted' ? t('settings.notificationsReady') : t('settings.notificationsOff')}</small></header>
      <article className="settings-panel settings-toggle-row"><div><strong>{t('settings.fastWalletSignals')}</strong><p>{t('settings.fastWalletSignalsHint')}</p></div><label className="toggle"><input checked={notificationState?.fastWalletSignalsEnabled === true} disabled={notificationBusy} onChange={(event) => void setFastWalletNotifications(event.target.checked)} type="checkbox" /><span /></label></article>
      <article className="settings-panel notification-privacy"><div><strong>{t('settings.notificationPrivacy')}</strong><p>{t('settings.notificationPrivacyHint')}</p><small>{t('settings.remotePushNotice')} · {notificationDeliveryLabel(notificationState, t)}</small>{notificationState?.backgroundAgentConfigPath && <small>{notificationState.backgroundAgentConfigPath}</small>}</div><button className="secondary" disabled={notificationBusy || notificationState?.fastWalletSignalsEnabled !== true || notificationState?.permission !== 'granted'} onClick={() => void testFastWalletNotification()} type="button">{t('settings.testNotification')}</button></article>
    </section>
    <section className="settings-section"><header><h3>{t('settings.node')}</h3><small>{changed ? t('settings.unsaved') : savedProfile ? t('settings.saved') : t('settings.loading')}</small></header>
      <article className="settings-panel node-settings">{profile && <>
        <p>{wallet ? t('settings.nodeForWallet', { name: walletDisplayName(wallet), network: networkLabel(profile.network) }) : t('settings.nodeChoose')}</p>
        <div className="settings-field"><span>{t('settings.network')}</span><div className="node-mode">{(['mainnet', 'testnet', 'stagenet'] as Network[]).map((item) => <button className={network === item ? 'selected' : ''} onClick={() => setNetwork(item)} key={item} type="button">{networkLabel(item)}</button>)}</div></div>
        <div className="settings-field"><span>{t('settings.connection')}</span><div className="node-mode">{([['optimized-grpc', t('settings.optimized')], ['original-rpc', t('settings.originalRpc')], ['custom', t('settings.custom')]] as const).map(([mode, title]) => <button className={profile.mode === mode ? 'selected' : ''} onClick={() => useMode(mode)} key={mode} type="button">{title}</button>)}</div></div>
        <div className="settings-form-grid"><label>{t('settings.daemonAddress')}<input value={profile.daemonAddress} onChange={(event) => setProfile({ ...profile, daemonAddress: event.target.value })} autoComplete="off" /></label>{profile.mode !== 'original-rpc' && <label>{t('settings.grpcEndpoint')}<input value={profile.grpcEndpoint} onChange={(event) => setProfile({ ...profile, grpcEndpoint: event.target.value })} autoComplete="off" /></label>}<label>{t('settings.nodeUsername')} <small>{t('common.optional')}</small><input value={profile.username} onChange={(event) => setProfile({ ...profile, username: event.target.value })} autoComplete="off" /></label><label>{t('settings.nodePassword')} <small>{t('settings.optionalKeychain')}</small><input value={nodePassword} onChange={(event) => { setNodePassword(event.target.value); setClearPassword(false); }} type="password" autoComplete="new-password" placeholder={profile.passwordStored ? t('settings.passwordStored') : t('settings.passwordKeychain')} /></label><label>{t('settings.socks5Proxy')} <small>{t('common.optional')}</small><input value={profile.proxyAddress} onChange={(event) => setProfile({ ...profile, proxyAddress: event.target.value })} placeholder="127.0.0.1:9050" autoComplete="off" /></label></div>
        <div className="settings-checkboxes"><label className="checkbox"><input checked={profile.trusted} onChange={(event) => setProfile({ ...profile, trusted: event.target.checked })} type="checkbox" />{t('settings.trustedNode')}</label><label className="checkbox"><input checked={profile.useSsl} onChange={(event) => setProfile({ ...profile, useSsl: event.target.checked })} type="checkbox" />{t('settings.tls')}</label>{profile.passwordStored && <label className="checkbox"><input checked={clearPassword} onChange={(event) => setClearPassword(event.target.checked)} type="checkbox" />{t('settings.forgetNodePassword')}</label>}</div>
        <div className="settings-actions"><button className="secondary" onClick={() => { setProfile(defaultNodeProfile(network)); setNodePassword(''); setClearPassword(false); }} type="button">{t('settings.resetDefaults')}</button><button className="primary" disabled={busy || !changed} onClick={() => void save()} type="button">{busy ? t('settings.saving') : t('settings.saveNode')}</button></div>
      </>}</article>
    </section>
    <section className="settings-section settings-about"><header><h3>{t('settings.about')}</h3><small>{t('settings.localDesktop')}</small></header><article className="settings-panel"><div><strong>{t('settings.privacyByDesign')}</strong><p>{t('settings.privacyText')}</p></div><div><strong>{t('settings.marketDisplay')}</strong><p>{t('settings.marketText')}</p></div></article></section>
    <button className="danger-button settings-lock" disabled={!walletId} onClick={onCloseWallet} type="button">{t('settings.closeWallet')}</button>
    {message && <p className="setup-message">{message}</p>}
  </section>;
}

function RecoverySeedOverlay({ wallet, seed, onConfirm, onDismiss }: { wallet: RegisteredWallet; seed: string; onConfirm: () => void; onDismiss: () => void }) {
  const [confirmed, setConfirmed] = useState(false);
  return <div className="seed-overlay" role="dialog" aria-modal="true" aria-labelledby="recovery-seed-title"><section className="seed-dialog"><p className="eyebrow">Offline backup</p><h2 id="recovery-seed-title">Write down the recovery seed</h2><p>This is the recovery seed for <strong>{walletDisplayName(wallet)}</strong>. Keep it offline, in the correct order, and never share it. This view is not saved in the desktop wallet list.</p><code className="seed-output">{seed}</code><label className="checkbox seed-confirm"><input checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} type="checkbox" />I wrote down the complete seed and stored it safely.</label><div className="dialog-actions"><button className="quiet-button" onClick={onDismiss} type="button">Close without confirming</button><button className="primary" disabled={!confirmed} onClick={onConfirm} type="button">Mark backup complete</button></div></section></div>;
}
