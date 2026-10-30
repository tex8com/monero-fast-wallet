import { invoke } from '@tauri-apps/api/core';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useI18n } from './i18n';
import { pushTestCanStart, receivedPushTest, type PushTestStatus } from './pushNotificationTest';

export default function FastWalletTestPushPanel({ onSetupFastWallet, onManageAlerts }: {
  onSetupFastWallet?: () => void;
  onManageAlerts?: () => void;
} = {}) {
  const { t } = useI18n();
  const [status, setStatus] = useState<PushTestStatus | null>(null);
  const [requesting, setRequesting] = useState(false);
  const [openingSettings, setOpeningSettings] = useState<'notifications' | 'focus' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [explainSetup, setExplainSetup] = useState(false);
  const setupAction = useRef<HTMLButtonElement | null>(null);
  const inFlight = useRef(false);
  const settingsInFlight = useRef(false);
  const mounted = useRef(true);
  const statusRead = useRef(0);
  const providerRecoveryError = useRef(false);
  const applyStatus = (next: PushTestStatus) => setStatus(previous =>
    previous && receivedPushTest(previous) && previous.receipt?.eventId === next.receipt?.eventId
      ? { ...next, phase: 'received', receivedAt: previous.receivedAt } : next);
  const refresh = useCallback(async () => {
    const generation = ++statusRead.current;
    try {
      const next = await invoke<PushTestStatus>('test_push_notification_status');
      if (mounted.current && generation === statusRead.current) {
        applyStatus(next);
        if (next.permissionSettingsAvailable === true || pushTestCanStart(next, false)) setExplainSetup(false);
        if (next.available && next.reason === 'ready') {
          setExplainSetup(false);
          if (providerRecoveryError.current) {
            providerRecoveryError.current = false;
            setError(null);
          }
        }
      }
    } catch {
      if (mounted.current && generation === statusRead.current) setError(t('settings.pushTestUnavailable'));
    }
  }, [t]);
  useEffect(() => {
    mounted.current = true;
    void refresh();
    const received = () => { void refresh(); };
    window.addEventListener('mfw-notification-received', received);
    window.addEventListener('focus', received);
    window.addEventListener('mfw-fast-wallet-alerts-changed', received);
    window.addEventListener('mfw-notification-registration-changed', received);
    return () => {
      mounted.current = false;
      window.removeEventListener('mfw-notification-received', received);
      window.removeEventListener('focus', received);
      window.removeEventListener('mfw-fast-wallet-alerts-changed', received);
      window.removeEventListener('mfw-notification-registration-changed', received);
    };
  }, [refresh]);
  useEffect(() => {
    if (status?.phase !== 'scheduled' || !status.receipt) return;
    const delay = Math.max(0, (status.receipt.deliverAfter + 121) * 1000 - Date.now());
    const timer = window.setTimeout(() => { void refresh(); }, Math.min(delay, 2_147_483_647));
    return () => window.clearTimeout(timer);
  }, [refresh, status?.phase, status?.receipt]);
  const macosSettings = status?.platform === 'macos' || status?.permissionSettingsAvailable === true;
  const openSystemSettings = async (target: 'notifications' | 'focus') => {
    if (inFlight.current || settingsInFlight.current || !macosSettings) return;
    settingsInFlight.current = true;
    setOpeningSettings(target); setError(null); setExplainSetup(false);
    try {
      await invoke(target === 'focus' ? 'open_focus_settings' : 'open_notification_settings');
    } catch {
      if (mounted.current) setError(t(target === 'focus' ? 'settings.pushTestOpenFocusSettingsFailed' : 'settings.pushTestOpenSettingsFailed'));
    } finally {
      settingsInFlight.current = false;
      if (mounted.current) setOpeningSettings(null);
    }
  };
  const request = async () => {
    if (inFlight.current || settingsInFlight.current || requesting || status?.phase === 'scheduled') return;
    if (status?.permissionSettingsAvailable === true) {
      await openSystemSettings('notifications');
      return;
    }
    if (!pushTestCanStart(status, requesting)) {
      setError(null);
      providerRecoveryError.current = false;
      setExplainSetup(true);
      setupAction.current?.focus();
      if (!status) void refresh();
      return;
    }
    inFlight.current = true; setRequesting(true); setError(null); setExplainSetup(false);
    providerRecoveryError.current = false;
    ++statusRead.current;
    try {
      // The request is immediate. The persistent SERVER queue owns the delay.
      const next = await invoke<PushTestStatus>('request_test_push_notification');
      if (mounted.current) {
        ++statusRead.current;
        applyStatus(next);
        // A real event can arrive while the POST response is still in flight.
        void refresh();
      }
    } catch (reason) {
      if (mounted.current) {
        const message = String(reason);
        providerRecoveryError.current = message.includes('push-test-provider-required') || message.includes('push-test-gateway-required')
          || message.includes('apns-registration-timeout') || message.includes('apns-registration-error') || message.includes('apns-registration-failed')
          || message.includes('apns-authorization-denied');
        setError(message.includes('push-test-worker-unsupported') ? t('settings.pushTestWorkerUnsupported')
          : message.includes('push-test-rate-limited') ? t('settings.pushTestRateLimited')
          : message.includes('push-test-fast-wallet-required') ? t('settings.pushTestAlertsRequired')
            : message.includes('apns-authorization-denied') ? t('settings.pushTestMacPermissionRequired')
              : providerRecoveryError.current ? t('settings.pushTestProviderRequired')
              : message.includes('push-test-unavailable') ? t('settings.pushTestUnavailable') : t('settings.pushTestFailed'));
      }
    } finally {
      inFlight.current = false;
      if (mounted.current) setRequesting(false);
    }
  };
  const setup = !status ? t('common.loading')
    : status.permissionSettingsAvailable === true ? t('settings.pushTestMacPermissionRequired')
    : status.reason === 'fast-wallet-required' ? t('settings.pushTestFastWalletRequired')
      : status.reason === 'alerts-required' ? t('settings.pushTestAlertsRequired')
        : status.reason === 'permission-required' ? t('settings.pushTestPermissionRequired')
          : status.reason === 'gateway-required' ? t('settings.pushTestGatewayRequired')
            : status.reason === 'ready' ? t('settings.pushTestHint') : t('settings.pushTestProviderRequired');
  const openingLabel = t(openingSettings === 'focus' ? 'settings.pushTestOpeningFocusSettings' : 'settings.pushTestOpeningSettings');
  const progress = openingSettings ? openingLabel : requesting ? t('settings.pushTestRequesting')
    : status?.available !== true ? setup
    : status && receivedPushTest(status) ? t('settings.pushTestReceived')
      : status?.phase === 'scheduled' ? t('settings.pushTestScheduled')
        : status?.phase === 'not-received' ? t('settings.pushTestNotReceived') : setup;
  const waiting = status?.phase === 'scheduled';
  const busy = requesting || openingSettings !== null || waiting;
  return <section className="settings-section"><header><h3>{t('settings.pushTestTitle')}</h3></header>
    <article className="settings-panel settings-wallet-actions push-test-panel">
      <div><strong>{t('settings.pushTestTitle')}</strong><p>{t('settings.pushTestHint')}{macosSettings && ` ${t('settings.pushBannerTestHint')}`}</p>
        <p className={`push-test-feedback${explainSetup ? ' is-attention' : ''}`} id="settings-push-test-feedback" aria-live="polite" role="status">
          {error ? `${status && receivedPushTest(status) ? `${t('settings.pushTestReceived')} ` : ''}${error}`
            : explainSetup ? `${t('settings.pushTestNotStarted')} ${setup}` : progress}
        </p></div>
      <div className="button-row push-test-actions">
        <button className="secondary" disabled={busy} aria-busy={busy} aria-describedby="settings-push-test-feedback" onClick={() => void request()} type="button">
          {busy && <span className="mfw-inline-spinner" aria-hidden="true" />}
          {openingSettings ? openingLabel : requesting ? t('settings.pushTestRequesting') : waiting ? t('settings.pushTestWaiting') : t('settings.testPushNotification')}
        </button>
        {status?.reason === 'fast-wallet-required' && onSetupFastWallet && <button className="primary" ref={setupAction} onClick={onSetupFastWallet} type="button">{t('settings.pushTestSetupFastWallet')}</button>}
        {status && status.reason !== 'fast-wallet-required' && onManageAlerts && <button className="primary" ref={setupAction} onClick={onManageAlerts} type="button">{t('settings.pushTestManageAlerts')}</button>}
      </div>
    </article>
    {macosSettings && <article className="settings-panel push-test-panel" aria-labelledby="settings-macos-banner-title">
      <div><strong id="settings-macos-banner-title">{t('settings.pushBannerSetupTitle')}</strong>
        <p>{t('settings.pushBannerSetupHint')}</p>
        <p>{t('settings.pushBannerFocusStep')}</p>
        <p>{t('settings.pushBannerNotificationsStep')}</p>
        <p>{t('settings.pushBannerManualCheck')}</p>
      </div>
      <div className="button-row push-test-actions">
        <button className="secondary" disabled={requesting || openingSettings !== null} aria-busy={openingSettings === 'focus'} onClick={() => void openSystemSettings('focus')} type="button">
          {openingSettings === 'focus' && <span className="mfw-inline-spinner" aria-hidden="true" />}
          {t('settings.pushTestOpenFocusSettings')}
        </button>
        <button className="secondary" disabled={requesting || openingSettings !== null} aria-busy={openingSettings === 'notifications'} onClick={() => void openSystemSettings('notifications')} type="button">
          {openingSettings === 'notifications' && <span className="mfw-inline-spinner" aria-hidden="true" />}
          {t('settings.pushTestOpenMacSettings')}
        </button>
      </div>
    </article>}
  </section>;
}
