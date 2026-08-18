import { useEffect, useRef, useState } from "react";
import {
  availabilityFromResolution,
  canonicalMfwName,
  estimateMfwExpiryTimestampMs,
  lookupMfwName,
  lookupMfwNameSuggestions,
  lookupPublishedMfwRegistration,
  mfwNameSuggestionPrefix,
  publishedRegistrationProgress,
} from "./mfwRegistry";

const copy = {
  de: {
    eyebrow: "Live-Vorabprüfung",
    title: "Ist dein .mfw-Name noch frei?",
    body: "Prüfe den aktuellen öffentlichen Registry-Index. Die Endung .mfw wird automatisch ergänzt.",
    label: "Gewünschter Name",
    placeholder: "mein-name",
    submit: "Namen prüfen",
    checking: "Registry wird geprüft …",
    suggestions: "Registrierte Namen",
    invalid: "Verwende 1–63 Kleinbuchstaben, Zahlen oder innere Bindestriche.",
    unavailable: "Die Registry-Prüfung ist gerade nicht erreichbar. Bitte versuche es später erneut.",
    states: {
      available: ["Vorläufig ohne Eintrag", "Der öffentliche Resolver findet keinen aktiven Eintrag für {name}."],
      available_again: ["Vorläufig wieder verfügbar", "Der frühere Eintrag für {name} ist abgelaufen."],
      reserved: ["Reserviert", "{name} ist durch die Registry-Regeln reserviert."],
      pending: ["Registrierung läuft", "Für {name} liegt bereits ein noch nicht finaler Eintrag vor."],
      taken: ["Vergeben", "{name} ist aktiv registriert."],
      commit_pending: ["COMMIT bestätigt", "Die geschützte Registrierung für {name} wartet auf die erforderlichen Bestätigungen."],
      claim_ready: ["COMMIT reif – CLAIM ausstehend", "Der COMMIT für {name} ist reif. Die ursprüngliche Wallet kann den vorbereiteten CLAIM jetzt veröffentlichen."],
      claim_broadcast: ["CLAIM gesendet", "Der CLAIM für {name} wurde veröffentlicht und wartet auf Aufnahme in einen Block."],
      commit_expired: ["COMMIT-Fenster abgelaufen", "Der veröffentlichte COMMIT für {name} kann nicht mehr für einen CLAIM verwendet werden."],
    },
    commitTxid: "COMMIT-Transaktion",
    commitBlock: "COMMIT-Block",
    commitConfirmations: "COMMIT-Bestätigungen",
    revealDeadline: "Letzter CLAIM-Block",
    claimTxid: "CLAIM-Transaktion",
    claimBlock: "CLAIM-Block",
    claimConfirmations: "CLAIM-Bestätigungen",
    mempool: "Mempool",
    expiryBlock: "Ablaufblock",
    estimatedExpiry: "Voraussichtlich gültig bis",
    estimatedExpired: "Voraussichtlich abgelaufen am",
    block: "Geprüfter Chain-Tip",
    checkedAt: "Prüfzeitpunkt",
    estimateHint: "Zeitangaben sind Schätzungen mit zwei Minuten je Block; maßgeblich ist der Ablaufblock.",
    safety: "Die Registrierung eines .mfw-Namens wird ausschließlich in der Monero Fast Wallet App möglich sein.",
  },
  en: {
    eyebrow: "Live preliminary check",
    title: "Is your .mfw name still open?",
    body: "Check the current public Registry index. The .mfw suffix is added automatically.",
    label: "Desired name",
    placeholder: "my-name",
    submit: "Check name",
    checking: "Checking the Registry …",
    suggestions: "Registered names",
    invalid: "Use 1–63 lowercase letters, numbers, or internal hyphens.",
    unavailable: "The Registry check is currently unavailable. Please try again later.",
    states: {
      available: ["Preliminary: no record", "The public resolver reports no active record for {name}."],
      available_again: ["Preliminary: open again", "The previous record for {name} has expired."],
      reserved: ["Reserved", "{name} is reserved by the Registry rules."],
      pending: ["Registration pending", "A non-final record already exists for {name}."],
      taken: ["Registered", "{name} is actively registered."],
      commit_pending: ["COMMIT confirmed", "The protected registration for {name} is waiting for the required confirmations."],
      claim_ready: ["COMMIT mature – CLAIM pending", "The COMMIT for {name} is mature. The originating wallet can now publish the prepared CLAIM."],
      claim_broadcast: ["CLAIM sent", "The CLAIM for {name} was published and is waiting to be included in a block."],
      commit_expired: ["COMMIT window expired", "The published COMMIT for {name} can no longer be used for a CLAIM."],
    },
    commitTxid: "COMMIT transaction",
    commitBlock: "COMMIT block",
    commitConfirmations: "COMMIT confirmations",
    revealDeadline: "Last CLAIM block",
    claimTxid: "CLAIM transaction",
    claimBlock: "CLAIM block",
    claimConfirmations: "CLAIM confirmations",
    mempool: "Mempool",
    expiryBlock: "Expiry block",
    estimatedExpiry: "Estimated valid until",
    estimatedExpired: "Estimated expired around",
    block: "Checked chain tip",
    checkedAt: "Checked at",
    estimateHint: "Times are estimates at the two-minute block target; the expiry block is authoritative.",
    safety: "Registering a .mfw name will only be available in the Monero Fast Wallet app.",
  },
};

export function RegistryAvailability({ language }) {
  const text = language === "de" ? copy.de : copy.en;
  const [value, setValue] = useState("");
  const [state, setState] = useState({ kind: "idle" });
  const [suggestions, setSuggestions] = useState([]);
  const request = useRef(null);
  const suggestionRequest = useRef(null);

  useEffect(() => {
    suggestionRequest.current?.abort();
    const prefix = mfwNameSuggestionPrefix(value);
    if (!prefix) {
      setSuggestions([]);
      return undefined;
    }
    const controller = new AbortController();
    suggestionRequest.current = controller;
    const timer = window.setTimeout(async () => {
      try {
        const result = await lookupMfwNameSuggestions(prefix, { signal: controller.signal });
        setSuggestions(result.names);
      } catch (error) {
        if (error?.name !== "AbortError") setSuggestions([]);
      } finally {
        if (suggestionRequest.current === controller) suggestionRequest.current = null;
      }
    }, 250);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [value]);

  const submit = async (event) => {
    event.preventDefault();
    request.current?.abort();
    let canonicalName;
    try {
      canonicalName = canonicalMfwName(value);
    } catch {
      setState({ kind: "invalid" });
      return;
    }
    const controller = new AbortController();
    request.current = controller;
    setState({ kind: "checking", canonicalName });
    try {
      const [resolution, publishedRegistration] = await Promise.all([
        lookupMfwName(canonicalName, { signal: controller.signal }),
        lookupPublishedMfwRegistration(canonicalName, { signal: controller.signal }).catch(() => undefined),
      ]);
      const progress = publishedRegistrationProgress(resolution, publishedRegistration);
      setState({
        ...(progress
          ? {
              kind: progress.stage,
              canonicalName,
              resolution,
              publishedRegistration,
              progress,
            }
          : availabilityFromResolution(resolution)),
        observedAtMs: Date.now(),
      });
    } catch (error) {
      if (error?.name !== "AbortError") setState({ kind: "error" });
    } finally {
      if (request.current === controller) request.current = null;
    }
  };

  const status = text.states[state.kind];
  const numberLocale = language === "de" ? "de-DE" : "en-US";
  const dateLocale = language === "de" ? "de-DE" : "en-US";
  const formatDateTime = (timestampMs) =>
    new Intl.DateTimeFormat(dateLocale, {
      year: "numeric",
      month: "short",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(timestampMs));
  const expiryTimestampMs = status
    ? estimateMfwExpiryTimestampMs(
        state.resolution.expiryHeight,
        state.resolution.chainTipHeight,
        state.observedAtMs,
      )
    : undefined;
  const hasExpiry = status && state.resolution.expiryHeight > 0;
  const expired = hasExpiry && state.resolution.expiryHeight <= state.resolution.chainTipHeight;
  return (
    <div className="registry-checker">
      <div className="registry-checker-copy">
        <p className="eyebrow">{text.eyebrow}</p>
        <h3>{text.title}</h3>
        <p>{text.body}</p>
      </div>
      <form className="registry-check-form" onSubmit={submit} noValidate>
        <label htmlFor="mfw-name-check">{text.label}</label>
        <div className="registry-input-row">
          <div className="registry-input-field">
            <span className="registry-input-shell"><input id="mfw-name-check" value={value} onChange={(event) => { setValue(event.target.value.replace(/\.mfw$/i, "")); setState({ kind: "idle" }); }} placeholder={text.placeholder} autoComplete="off" spellCheck="false" maxLength="63" role="combobox" aria-autocomplete="list" aria-expanded={suggestions.length > 0} aria-controls="mfw-name-suggestions" /><b>.mfw</b></span>
            {suggestions.length > 0 && (
              <div className="registry-name-suggestions" id="mfw-name-suggestions" role="listbox" aria-label={text.suggestions}>
                <small>{text.suggestions}</small>
                {suggestions.map((name) => (
                  <button key={name} type="button" role="option" aria-selected="false" onClick={() => { setValue(name.slice(0, -4)); setSuggestions([]); setState({ kind: "idle" }); }}>
                    <span>{name}</span><b aria-hidden="true">→</b>
                  </button>
                ))}
              </div>
            )}
          </div>
          <button type="submit" disabled={state.kind === "checking"}>{state.kind === "checking" ? text.checking : text.submit}</button>
        </div>
        {state.kind === "invalid" && <p className="registry-check-result is-error" role="alert">{text.invalid}</p>}
        {state.kind === "error" && <p className="registry-check-result is-error" role="alert">{text.unavailable}</p>}
        {status && (
          <div className={`registry-check-result is-${state.kind}`} role="status">
            <strong>{status[0]}</strong>
            <span>{status[1].replace("{name}", state.canonicalName)}</span>
            <dl className="registry-check-details">
              {state.publishedRegistration && state.progress && (
                <>
                  <div className="registry-check-detail-wide"><dt>{text.commitTxid}</dt><dd>{state.publishedRegistration.commitTxidHex}</dd></div>
                  <div><dt>{text.commitBlock}</dt><dd>{state.publishedRegistration.commitHeight.toLocaleString(numberLocale)}</dd></div>
                  <div><dt>{text.commitConfirmations}</dt><dd>{state.progress.confirmations.toLocaleString(numberLocale)} / {state.publishedRegistration.minimumClaimConfirmations.toLocaleString(numberLocale)}</dd></div>
                  <div><dt>{text.revealDeadline}</dt><dd>{state.progress.revealDeadlineHeight.toLocaleString(numberLocale)}</dd></div>
                  {state.publishedRegistration.claimTxidHex && (
                    <>
                      <div className="registry-check-detail-wide"><dt>{text.claimTxid}</dt><dd>{state.publishedRegistration.claimTxidHex}</dd></div>
                      <div><dt>{text.claimConfirmations}</dt><dd>{text.mempool} – 0 / 15</dd></div>
                    </>
                  )}
                </>
              )}
              {state.resolution.sourceTxidHex && (
                <>
                  <div className="registry-check-detail-wide"><dt>{text.claimTxid}</dt><dd>{state.resolution.sourceTxidHex}</dd></div>
                  <div><dt>{text.claimBlock}</dt><dd>{state.resolution.recordHeight.toLocaleString(numberLocale)}</dd></div>
                  <div><dt>{text.claimConfirmations}</dt><dd>{state.resolution.confirmations.toLocaleString(numberLocale)} / 15</dd></div>
                </>
              )}
              {hasExpiry && (
                <>
                  <div><dt>{text.expiryBlock}</dt><dd>{state.resolution.expiryHeight.toLocaleString(numberLocale)}</dd></div>
                  {expiryTimestampMs !== undefined && (
                    <div><dt>{expired ? text.estimatedExpired : text.estimatedExpiry}</dt><dd>{formatDateTime(expiryTimestampMs)}</dd></div>
                  )}
                </>
              )}
              <div><dt>{text.block}</dt><dd>{state.resolution.chainTipHeight.toLocaleString(numberLocale)}</dd></div>
              <div><dt>{text.checkedAt}</dt><dd>{formatDateTime(state.observedAtMs)}</dd></div>
            </dl>
            {hasExpiry && <small>{text.estimateHint}</small>}
          </div>
        )}
        <p className="registry-check-safety">{text.safety}</p>
      </form>
    </div>
  );
}
