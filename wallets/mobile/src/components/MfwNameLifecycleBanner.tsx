import React, { useEffect, useMemo, useState } from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';

import { useI18n } from '../i18n';
import {
  cancelMfwNameClaimReminder,
  notifyMfwNameClaimReady,
  scheduleMfwNameClaimReminder,
} from '../services/MfwNameClaimReminderService';
import { configuredMfwNameGenesis } from '../services/MfwNameGenesisConfig';
import { resolveConfiguredMfwOwnedNameFinalization } from '../services/MfwNameResolutionService';
import { MFW_NAME_MIN_CONFIRMATIONS } from '../services/MfwNameRegistration';
import {
  MFW_TARGET_BLOCK_TIME_MS,
  loadMfwOwnedNames,
  mfwNameClaimWindowBlocksRemaining,
  mfwNameCommitBlocksRemaining,
  reconcileMfwNameTransactionState,
  subscribeMfwOwnedNames,
  upsertMfwOwnedName,
  type MfwOwnedNameRecord,
} from '../services/MfwNameRegistrationRegistry';
import { walletService } from '../services/WalletService';
import { useWalletState } from '../services/WalletState';
import { colors, radius, spacing } from '../theme/colors';
import { Icon } from './Icon';

type Props = { onPress: () => void };

export default function MfwNameLifecycleBanner({ onPress }: Props) {
  const { t } = useI18n();
  const {
    registeredWallet,
    session,
    snapshot,
    walletSnapshots,
  } = useWalletState();
  const [records, setRecords] = useState<MfwOwnedNameRecord[]>([]);

  useEffect(() => {
    let active = true;
    loadMfwOwnedNames()
      .then(names => {
        if (active) setRecords(names);
      })
      .catch(() => undefined);
    const unsubscribe = subscribeMfwOwnedNames(names => {
      if (active) setRecords(names);
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (!session || !registeredWallet) return;
    const genesis = configuredMfwNameGenesis(registeredWallet.network);
    if (!genesis) return;
    const candidates = records.filter(
      record =>
        record.walletRegistrationId === registeredWallet.id &&
        (record.stage === 'commit-pending' ||
          record.stage === 'reveal-ready') &&
        record.commitTxidHex,
    );
    const scheduledClaims = records.filter(
      record =>
        record.walletRegistrationId === registeredWallet.id &&
        record.stage === 'claim-pending' &&
        record.claimScheduledAt !== undefined &&
        record.sourceTxidHex &&
        record.ownerPublicKeyHex,
    );
    if (candidates.length === 0 && scheduledClaims.length === 0) return;
    let cancelled = false;
    walletService
      .getTransactionsForAllAccounts(session, 0)
      .then(async transactions => {
        for (const record of candidates) {
          if (cancelled) return;
          const reconciled = reconcileMfwNameTransactionState(
            record,
            transactions,
            genesis.commitMaturityBlocks,
            genesis.commitRevealWindowBlocks,
          );
          if (reconciled !== record) {
            await upsertMfwOwnedName(reconciled);
          }
        }
        for (const record of scheduledClaims) {
          if (cancelled) return;
          const transaction = transactions.find(
            candidate => candidate.hash.toLowerCase() === record.sourceTxidHex,
          );
          if (!transaction || transaction.pending) continue;
          if (transaction.failed) {
            await upsertMfwOwnedName({
              ...record,
              stage: 'failed',
              updatedAt: new Date().toISOString(),
            });
            continue;
          }
          if (transaction.confirmations < MFW_NAME_MIN_CONFIRMATIONS) continue;
          const resolution = await resolveConfiguredMfwOwnedNameFinalization({
            name: record.canonicalName,
            network: record.network,
            expectedAddress: record.address,
            expectedOwnerPublicKeyHex: record.ownerPublicKeyHex!,
            expectedSourceTxidHex: record.sourceTxidHex!,
            expectedSequence: 0,
            expectedStatus: 'finalized',
          });
          await upsertMfwOwnedName({
            ...record,
            stage: 'active',
            sequence: resolution.sequence,
            expiryHeight: resolution.expiryHeight,
            lastChainTipHeight: resolution.chainTipHeight,
            updatedAt: new Date().toISOString(),
          });
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [records, registeredWallet, session, snapshot?.daemonHeight]);

  useEffect(() => {
    for (const record of records) {
      if (!record.commitTxidHex) continue;
      const genesis = configuredMfwNameGenesis(record.network);
      if (!genesis) continue;
      const chainTip =
        walletSnapshots[record.walletRegistrationId]?.daemonHeight ??
        (record.walletRegistrationId === registeredWallet?.id
          ? snapshot?.daemonHeight
          : undefined) ??
        record.lastChainTipHeight;
      if (record.stage === 'commit-pending') {
        const remaining = mfwNameCommitBlocksRemaining(
          record,
          genesis.commitMaturityBlocks,
          chainTip,
        );
        const broadcastAt = Date.parse(
          record.commitBroadcastAt ?? record.updatedAt,
        );
        const triggerAtMs =
          remaining === undefined
            ? broadcastAt +
              genesis.commitMaturityBlocks * MFW_TARGET_BLOCK_TIME_MS
            : Date.now() + remaining * MFW_TARGET_BLOCK_TIME_MS;
        scheduleMfwNameClaimReminder({
          record,
          triggerAtMs,
          title: t('mfwNames.notificationTitle'),
          body: t('mfwNames.notificationCheckStepTwo'),
        }).catch(() => undefined);
      } else if (record.stage === 'reveal-ready') {
        notifyMfwNameClaimReady({
          record,
          title: t('mfwNames.notificationTitle'),
          body: t('mfwNames.notificationStepTwoReady'),
        }).catch(() => undefined);
      } else {
        cancelMfwNameClaimReminder(record).catch(() => undefined);
      }
    }
  }, [records, registeredWallet?.id, snapshot?.daemonHeight, t, walletSnapshots]);

  const record = useMemo(() => {
    const priority = (value: MfwOwnedNameRecord) =>
      value.stage === 'reveal-ready'
        ? 0
        : value.stage === 'commit-pending'
        ? 1
        : value.stage === 'claim-pending'
        ? 2
        : 9;
    return [...records]
      .filter(value => priority(value) < 9)
      .sort(
        (left, right) =>
          priority(left) - priority(right) ||
          right.updatedAt.localeCompare(left.updatedAt),
      )[0];
  }, [records]);

  if (!record) return null;
  const genesis = configuredMfwNameGenesis(record.network);
  const chainTip =
    walletSnapshots[record.walletRegistrationId]?.daemonHeight ??
    (record.walletRegistrationId === registeredWallet?.id
      ? snapshot?.daemonHeight
      : undefined) ??
    record.lastChainTipHeight;
  const remaining = genesis
    ? mfwNameCommitBlocksRemaining(
        record,
        genesis.commitMaturityBlocks,
        chainTip,
      )
    : undefined;
  const windowRemaining = genesis
    ? mfwNameClaimWindowBlocksRemaining(
        record,
        genesis.commitRevealWindowBlocks,
        chainTip,
      )
    : undefined;
  const ready = record.stage === 'reveal-ready';
  const claimPending = record.stage === 'claim-pending';
  const claimScheduled = claimPending && record.claimScheduledAt !== undefined;

  return (
    <TouchableOpacity
      accessibilityRole="button"
      activeOpacity={0.82}
      onPress={onPress}
      style={[styles.banner, ready && styles.bannerReady]}
    >
      <View style={styles.icon}>
        <Icon
          name={
            ready
              ? 'arrow-right'
              : claimScheduled
              ? 'clock'
              : claimPending
              ? 'check'
              : 'clock'
          }
          size={18}
          color={ready ? colors.orange : colors.textSecondary}
        />
      </View>
      <View style={styles.copy}>
        <Text style={styles.eyebrow}>
          {claimScheduled
            ? t('mfwNames.stepTwoScheduled')
            : claimPending
            ? t('mfwNames.stepTwoSent')
            : ready
            ? t('mfwNames.stepTwoReady')
            : t('mfwNames.stepOneComplete')}
        </Text>
        <Text style={styles.text} numberOfLines={2}>
          {claimScheduled
            ? t('mfwNames.stepTwoScheduledDescription')
            : claimPending
            ? t('mfwNames.claimPendingBanner')
            : ready
            ? t('mfwNames.claimReadyBanner', {
                blocks: windowRemaining ?? '—',
              })
            : remaining === undefined
            ? t('mfwNames.commitWaitingBanner')
            : t('mfwNames.commitBlocksBanner', { blocks: remaining })}
        </Text>
      </View>
      <Icon name="chevron-right" size={18} color={colors.orange} />
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  banner: {
    marginHorizontal: spacing.md,
    marginBottom: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.lg,
    backgroundColor: colors.surface,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  bannerReady: { borderColor: colors.orange },
  icon: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.bgElevated,
  },
  copy: { flex: 1 },
  eyebrow: { color: colors.orange, fontSize: 13, fontWeight: '800' },
  text: { color: colors.textSecondary, fontSize: 12, lineHeight: 17 },
});
