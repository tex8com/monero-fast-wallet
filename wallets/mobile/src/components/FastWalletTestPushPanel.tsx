import React, { useEffect, useRef, useState } from 'react';
import {
  AppState,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useI18n } from '../i18n';
import { FastWalletPushService } from '../services/FastWalletPushService';
import type { FastWalletTestPushReceipt } from '../services/NativeMoneroWallet';
import {
  walletDisplayName,
  type RegisteredWallet,
} from '../services/WalletRegistry';
import { walletService } from '../services/WalletService';
import { logWalletEvent } from '../services/WalletLogger';
import { colors, spacing } from '../theme/colors';

type TestStatus =
  | 'idle'
  | 'requesting'
  | 'scheduled'
  | 'received'
  | 'not-received'
  | 'error';
type EnrollmentStatus = 'idle' | 'working' | 'accepted' | 'error';
const RECEIPT_GRACE_SECONDS = 120;
const TEST_RATE_LIMIT_SECONDS = 60;

export default function FastWalletTestPushPanel({
  wallets,
}: {
  wallets: readonly RegisteredWallet[];
}) {
  const { t } = useI18n();
  const fastWalletKey = wallets
    .filter(wallet => wallet.kind === 'fast')
    .map(wallet => wallet.id)
    .join(':');
  const [ready, setReady] = useState(false);
  const [status, setStatus] = useState<TestStatus>('idle');
  const [retryAfter, setRetryAfter] = useState(0);
  const [enrollmentStatus, setEnrollmentStatus] =
    useState<EnrollmentStatus>('idle');
  const eligibleWallets = wallets.filter(
    wallet => wallet.kind === 'fast' && wallet.seedBackupStatus === 'verified',
  );
  const busy = useRef(false);
  const requested = useRef(false);
  const mounted = useRef(true);
  const receipt = useRef<FastWalletTestPushReceipt | undefined>(undefined);
  const deliveryPending = useRef(false);
  const retryDeadline = useRef(0);
  const received = useRef(new Set<string>());

  function rememberReceipt(scheduled: FastWalletTestPushReceipt) {
    receipt.current = scheduled;
    retryDeadline.current =
      (scheduled.scheduledAt + TEST_RATE_LIMIT_SECONDS) * 1000;
    setRetryAfter(
      retryDeadline.current > Date.now() ? retryDeadline.current : 0,
    );
  }

  useEffect(() => {
    mounted.current = true;
    if (!fastWalletKey) return;
    let active = true;
    const unsubscribe = FastWalletPushService.subscribe(event => {
      if (event.type !== 'monero.fast_wallet.test') return;
      received.current.add(event.eventId);
      if (received.current.size > 32)
        received.current.delete(received.current.values().next().value!);
      if (receipt.current?.eventId === event.eventId) {
        deliveryPending.current = false;
        setStatus('received');
      }
    });
    const refreshReadiness = () =>
      FastWalletPushService.testNotificationReady()
        .then(value => {
          if (active) setReady(value);
        })
        .catch(() => {
          if (active) setReady(false);
        });
    refreshReadiness();
    const appState = AppState.addEventListener('change', value => {
      if (value === 'active') refreshReadiness();
    });
    Promise.all([
      FastWalletPushService.getLastScheduledTestPush(),
      FastWalletPushService.getLastEvent(),
    ])
      .then(([previous, event]) => {
        if (!active || requested.current || receipt.current || !previous)
          return;
        rememberReceipt(previous);
        const confirmed =
          event?.type === 'monero.fast_wallet.test' &&
          event.eventId === previous.eventId;
        deliveryPending.current = !confirmed;
        setStatus(confirmed ? 'received' : 'scheduled');
      })
      .catch(() => undefined);
    return () => {
      active = false;
      mounted.current = false;
      appState.remove();
      unsubscribe();
    };
  }, [fastWalletKey, wallets]);

  useEffect(() => {
    if (!retryAfter) return;
    const timer = setTimeout(() => {
      if (retryDeadline.current === retryAfter) setRetryAfter(0);
    }, Math.max(0, retryAfter - Date.now()));
    return () => clearTimeout(timer);
  }, [retryAfter]);

  useEffect(() => {
    const scheduled = receipt.current;
    if (status !== 'scheduled' || !scheduled) return;
    const timer = setTimeout(() => {
      if (
        !mounted.current ||
        receipt.current?.eventId !== scheduled.eventId ||
        !deliveryPending.current
      )
        return;
      deliveryPending.current = false;
      const confirmed = received.current.has(scheduled.eventId);
      setStatus(confirmed ? 'received' : 'not-received');
      if (!confirmed) {
        logWalletEvent('FastWalletPush', 'testPush.receiptTimeout', {
          eventId: scheduled.eventId,
        });
        // Locked or slow local storage must not keep the UI scheduled forever.
        // A persisted genuine receipt may still correct the unconfirmed state.
        FastWalletPushService.getLastEvent()
          .then(event => {
            if (
              mounted.current &&
              receipt.current?.eventId === scheduled.eventId &&
              event?.type === 'monero.fast_wallet.test' &&
              event.eventId === scheduled.eventId
            )
              setStatus('received');
          })
          .catch(() => undefined);
      }
    }, Math.max(0, (scheduled.deliverAfter + RECEIPT_GRACE_SECONDS) * 1000 - Date.now()));
    return () => clearTimeout(timer);
  }, [status]);

  async function enableAlerts(identityId: string) {
    if (
      busy.current ||
      deliveryPending.current ||
      !eligibleWallets.some(wallet => wallet.id === identityId)
    )
      return;
    busy.current = true;
    const startedAt = Date.now();
    setEnrollmentStatus('working');
    setStatus('idle');
    logWalletEvent('FastWalletPush', 'alertsReconnect.start');
    try {
      // This explicit owner action uses the ordinary provider registration,
      // trusted remote descriptor and verified Worker enrollment workflow.
      await walletService.enableEncryptedFastWalletAlerts({ identityId });
      const available = await FastWalletPushService.testNotificationReady();
      logWalletEvent('FastWalletPush', 'alertsReconnect.success', {
        elapsedMs: Date.now() - startedAt,
        available,
        success: true,
      });
      if (!mounted.current) return;
      setReady(available);
      setEnrollmentStatus('accepted');
    } catch (error) {
      logWalletEvent('FastWalletPush', 'alertsReconnect.error', {
        elapsedMs: Date.now() - startedAt,
        error,
      });
      if (mounted.current) {
        setReady(false);
        setEnrollmentStatus('error');
      }
    } finally {
      busy.current = false;
    }
  }

  async function requestTest() {
    if (
      busy.current ||
      !ready ||
      deliveryPending.current ||
      Date.now() < retryDeadline.current
    )
      return;
    busy.current = true;
    requested.current = true;
    setStatus('requesting');
    try {
      const scheduled = await FastWalletPushService.sendTestNotification();
      if (!mounted.current) return;
      rememberReceipt(scheduled);
      const confirmed = received.current.has(scheduled.eventId);
      deliveryPending.current = !confirmed;
      setStatus(confirmed ? 'received' : 'scheduled');
      // A background message may have arrived before the HTTP response or
      // before this Settings screen mounted. Only the matching real event counts.
      const event = await FastWalletPushService.getLastEvent().catch(
        () => undefined,
      );
      if (
        mounted.current &&
        receipt.current?.eventId === scheduled.eventId &&
        event?.type === 'monero.fast_wallet.test' &&
        event.eventId === scheduled.eventId
      ) {
        deliveryPending.current = false;
        setStatus('received');
      }
    } catch {
      if (mounted.current) setStatus('error');
    } finally {
      busy.current = false;
    }
  }

  if (!fastWalletKey) return null;
  const testDisabled =
    !ready ||
    status === 'requesting' ||
    status === 'scheduled' ||
    retryAfter !== 0 ||
    enrollmentStatus === 'working';
  return (
    <View style={s.panel} testID="fast-wallet-test-push">
      <Text style={s.title}>{t('settings.testNotificationTitle')}</Text>
      <Text style={s.hint}>
        {t(
          ready
            ? 'settings.testNotificationHint'
            : 'settings.testNotificationRequirement',
        )}
      </Text>
      {!ready &&
        eligibleWallets.map(wallet => (
          <TouchableOpacity
            key={wallet.id}
            accessibilityRole="button"
            accessibilityLabel={`${t(
              'action.enableNotifications',
            )}: ${walletDisplayName(wallet)}`}
            disabled={
              enrollmentStatus === 'working' ||
              status === 'requesting' ||
              status === 'scheduled'
            }
            onPress={() => enableAlerts(wallet.id)}
            style={s.button}
            testID={`fast-wallet-enable-alerts-${wallet.id}`}
          >
            <Text style={s.label}>
              {t(
                enrollmentStatus === 'working'
                  ? 'action.working'
                  : 'action.enableNotifications',
              )}
              {`: ${walletDisplayName(wallet)}`}
            </Text>
          </TouchableOpacity>
        ))}
      {enrollmentStatus !== 'idle' && (
        <Text
          accessibilityLiveRegion="polite"
          style={s.hint}
          testID="fast-wallet-alerts-status"
        >
          {t(
            enrollmentStatus === 'working'
              ? 'setup.fastWalletTransferSending'
              : enrollmentStatus === 'accepted'
              ? 'setup.fastWalletTransferAccepted'
              : 'setup.fastWalletTransferFailed',
          )}
        </Text>
      )}
      <TouchableOpacity
        accessibilityRole="button"
        accessibilityLabel={t('settings.sendTestNotification')}
        disabled={testDisabled}
        onPress={requestTest}
        style={s.button}
        testID="fast-wallet-send-test"
      >
        <Text style={[s.label, testDisabled && s.disabled]}>
          {t(
            status === 'requesting'
              ? 'settings.sendingTestNotification'
              : 'settings.sendTestNotification',
          )}
        </Text>
      </TouchableOpacity>
      {status !== 'idle' && (
        <Text
          accessibilityLiveRegion="polite"
          style={s.hint}
          testID="test-push-status"
        >
          {t(
            status === 'requesting'
              ? 'settings.sendingTestNotification'
              : status === 'received'
              ? 'settings.testNotificationReceived'
              : status === 'scheduled'
              ? 'settings.testNotificationScheduled'
              : status === 'not-received'
              ? 'settings.testNotificationNotReceived'
              : 'settings.testNotificationFailed',
          )}
        </Text>
      )}
      {retryAfter !== 0 && status !== 'scheduled' && (
        <Text style={s.hint}>{t('settings.testNotificationRetryWaiting')}</Text>
      )}
    </View>
  );
}

const s = StyleSheet.create({
  panel: {
    marginVertical: spacing.lg,
    padding: spacing.lg,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 12,
  },
  title: {
    color: colors.textPrimary,
    fontWeight: '700',
    marginBottom: spacing.sm,
  },
  hint: { color: colors.textSecondary, fontSize: 13, lineHeight: 19 },
  button: { paddingVertical: spacing.md },
  label: { color: colors.orange, fontWeight: '700' },
  disabled: { color: colors.textMuted },
});
