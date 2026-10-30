import { useI18n } from './i18n';

export type LedgerPreparationProgress = {
  stage: string;
  height: number;
  targetHeight: number;
  elapsedMs: number;
  stalledMs: number;
};

export default function LedgerPreparationStatus({ progress }: { progress: LedgerPreparationProgress }) {
  const { t } = useI18n();
  if (progress.stage === 'signing-sync' || progress.stage === 'viewing-sync') {
    return <>
      <strong>{t('send.ledgerSync')}</strong>
      <small>{t('send.ledgerSyncProgress', {
        height: progress.height.toLocaleString(),
        target: progress.targetHeight.toLocaleString(),
        remaining: Math.max(0, progress.targetHeight - progress.height).toLocaleString(),
      })}</small>
      <small>{t('send.ledgerSyncHint')}</small>
      {progress.stalledMs >= 15000 && <small>{t('send.ledgerSyncWaiting', { seconds: Math.floor(progress.stalledMs / 1000) })}</small>}
    </>;
  }
  return <>
    <strong>{t(progress.stage === 'connecting' ? 'send.ledgerConnecting' : 'send.preparing')}</strong>
    <small>{t(progress.stage === 'connecting' ? 'send.ledgerConnectHint' : 'send.ledgerHint')}</small>
  </>;
}
