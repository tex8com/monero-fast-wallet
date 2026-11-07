import { invoke } from '@tauri-apps/api/core';
import { useEffect, useState } from 'react';
import {
  mfwResolverPreferences,
  type MfwResolverPreference,
} from '../../../packages/wallet-shared/src/mfwResolverPreference';
import { useI18n, type TranslationKey } from './i18n';

export default function MfwResolverSettings() {
  const { t } = useI18n();
  const [preference, setPreference] = useState<MfwResolverPreference>();
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<TranslationKey>();

  useEffect(() => {
    let active = true;
    void invoke<MfwResolverPreference>('load_mfw_resolver_preference')
      .then(value => { if (active) setPreference(value); })
      .catch(() => { if (active) setError('settings.mfwResolverLoadFailed'); })
      .finally(() => { if (active) setBusy(false); });
    return () => { active = false; };
  }, []);

  async function save(value: MfwResolverPreference) {
    setBusy(true);
    setError(undefined);
    try {
      const saved = await invoke<MfwResolverPreference>('save_mfw_resolver_preference', {
        preference: value,
      });
      setPreference(saved);
    } catch {
      setError('settings.mfwResolverSaveFailed');
    } finally {
      setBusy(false);
    }
  }

  return <article className="settings-panel">
    <div>
      <strong id="settings-mfw-resolver-label">{t('settings.mfwResolver')}</strong>
      <p id="settings-mfw-resolver-hint">{t('settings.mfwResolverHint')}</p>
    </div>
    <div aria-busy={busy} aria-describedby="settings-mfw-resolver-hint" aria-labelledby="settings-mfw-resolver-label" className="node-mode" role="group">
      {mfwResolverPreferences.map(value => <button
        aria-pressed={preference === value}
        className={preference === value ? 'selected' : ''}
        disabled={busy}
        key={value}
        onClick={() => { if (value !== preference) void save(value); }}
        type="button"
      >{t(`settings.mfwResolver.${value}`)}</button>)}
    </div>
    {error && <p className="setup-message" role="alert">{t(error)}</p>}
  </article>;
}
