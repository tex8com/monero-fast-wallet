import {
  fastWalletHostingErrorTranslationKey,
  parseFastWalletHostingView,
  type FastWalletHostingView,
} from '../../../packages/wallet-shared/src/fastWalletHosting';
import { useI18n } from './i18n';

export default function FastWalletHostingPanel({ status, busy, disabled, onCheck }: {
  status?: FastWalletHostingView;
  busy: boolean;
  disabled: boolean;
  onCheck: () => void;
}) {
  const { t, language } = useI18n();
  const view = parseFastWalletHostingView(status);
  const verified = view?.verified && (view.status === 'hosted' || view.status === 'rehosted');
  const label = busy ? t('wallets.hostingChecking')
    : view?.status === 'hosted' && verified ? t('wallets.hostingHosted')
    : view?.status === 'rehosted' && verified ? t('wallets.hostingRehosted')
    : view?.status === 'missing' ? t('wallets.hostingMissing')
    : view?.status === 'blocked' ? t('wallets.hostingBlocked')
    : view?.status === 'unsupported' ? t('wallets.hostingUnsupported')
    : t('wallets.hostingUnknown');
  return <section className="fast-wallet-hosting" aria-busy={busy}>
    <div className="fast-wallet-hosting-header">
      <strong className={verified && !busy ? 'positive' : undefined} aria-live="polite">{label}</strong>
      <button className="secondary" disabled={disabled || busy} onClick={onCheck} type="button">
        {busy && <span className="mfw-inline-spinner" aria-hidden="true" />}
        {busy ? t('wallets.hostingChecking') : t('wallets.hostingCheck')}
      </button>
    </div>
    {!busy && view?.errorCode && <p role="alert">{t(fastWalletHostingErrorTranslationKey(view.errorCode))}</p>}
    {view && <small>{t(view.verified && view.checkedAt ? 'wallets.hostingCheckedAt' : 'wallets.hostingAttemptedAt', {
      time: new Date((view.verified && view.checkedAt ? view.checkedAt : view.attemptedAt) * 1000).toLocaleString(language),
    })}</small>}
    <small>{t('wallets.hostingPermissionSeparate')}</small>
  </section>;
}
