const repositoryUrl = "https://github.com/tex8com/monero-fast-wallet";

const documentation = {
  de: {
    eyebrow: "Entwicklerdokumentation",
    title: ".mfw sicher in Anwendungen integrieren.",
    intro: "Die Monero Fast Wallet Registry löst einen öffentlichen Namen in eine Monero-Empfangsadresse auf. Sie ändert weder Monero-Adressen noch Transaktionen oder Custody.",
    statusTitle: "Kontrollierter Rollout",
    statusBody: "Ein öffentlicher Mainnet-Resolver ist live. Produktive Zahlungsauflösung und verbindliche Frei-Prüfung bleiben gesperrt, bis ein zweiter unabhängig betriebener Resolver verfügbar und geprüft ist.",
    checker: "Registry-Prüfung öffnen",
    source: "Referenzimplementierung",
    quickEyebrow: "Integrationsablauf",
    quickTitle: "Sechs Grenzen, die eine sichere Integration einhalten muss.",
    steps: [
      ["01", "Namen kanonisieren", "Kleinbuchstaben, a–z, 0–9 und innere Bindestriche; 1–63 Zeichen vor .mfw. Unicode und führende oder abschließende Bindestriche ablehnen."],
      ["02", "Resolver-Quorum abfragen", "Zwei bis vier unabhängig betriebene HTTPS-Origins parallel über denselben versionierten GET-Endpunkt abfragen."],
      ["03", "Antworten vergleichen", "Unveränderliche Record-Felder müssen identisch sein. Chain-Tips dürfen höchstens fünf Blöcke auseinanderliegen; gleiche Höhen benötigen denselben Tip-Hash."],
      ["04", "Finalität erzwingen", "Für Zahlungen nur finalized mit mindestens 15 Bestätigungen, passendem Netzwerk und expiryHeight oberhalb des konservativen Chain-Tips akzeptieren."],
      ["05", "Record nativ prüfen", "Den signierten Record gegen den erwarteten Namen und das Netzwerk prüfen und die Monero-Adresse aus den authentifizierten öffentlichen Schlüsseln ableiten."],
      ["06", "Normale Zahlung bestätigen", "Den vollständigen Namen und die vollständige abgeleitete Adresse in der normalen Transaktionsprüfung anzeigen. Die Auflösung sendet niemals selbst Geld."],
    ],
    endpointEyebrow: "HTTP Resolver API",
    endpointTitle: "Read-only, versioniert und ohne API-Key.",
    endpointBody: "Der öffentliche Endpoint dient während des Rollouts als Vorabprüfung und Referenz. Eine Produktionsintegration muss denselben Vertrag über mindestens zwei unabhängige Origins ausführen.",
    request: "Request",
    response: "Response-Felder",
    fields: [
      ["canonicalName", "Kanonischer Name einschließlich .mfw"],
      ["status", "not_found, reserved, provisional, finalized oder expired"],
      ["network", "mainnet, testnet oder stagenet"],
      ["addressKind", "0 Standardadresse, 1 Subadresse"],
      ["publicSpendKeyHex / publicViewKeyHex", "Öffentliche Monero-Adressschlüssel; bei leeren Zuständen leer"],
      ["recordHeight / confirmations", "Blockhöhe des Records und Bestätigungen am gelieferten Tip"],
      ["sourceTxidHex / recordBlockHashHex", "Kanonische Referenzen auf Transaktion und Block"],
      ["expiryHeight", "Kanonische Ablaufhöhe; keine Wanduhr-Zeit"],
      ["chainTipHeight / chainTipHashHex", "Chain-Tip, gegen den die Antwort berechnet wurde"],
      ["recordPayloadHex", "Signierter MFWN-V1-Record für die native Verifikation"],
    ],
    statusEyebrow: "Statusmodell",
    modelTitle: "Ein HTTP 200 bedeutet nicht automatisch „frei“.",
    statuses: [
      ["not_found", "Kein aktiver Record im Index. Erst ein gültiges Quorum darf dies als verfügbar behandeln."],
      ["reserved", "Durch das versionierte Reserved-Name-Manifest gesperrt."],
      ["provisional", "Record vorhanden, aber noch nicht mit 15 Bestätigungen final."],
      ["finalized", "Aktiver Eintrag. Für Zahlungen zusätzlich Signatur, Netzwerk, Ablauf und Adresse prüfen."],
      ["expired", "Historischer Record ist abgelaufen; eine Neuregistrierung benötigt erneut COMMIT und CLAIM."],
    ],
    securityEyebrow: "Sicherheits-Checkliste",
    securityTitle: "Nicht als gewöhnliche Alias-API behandeln.",
    security: [
      "Keine einzelne not_found-Antwort als verbindliche Verfügbarkeit akzeptieren.",
      "Keine Redirects, nicht-HTTPS Origins, zusätzlichen JSON-Felder oder Antworten über 16 KiB akzeptieren.",
      "Adressschlüssel nicht nur zusammenfügen: Record-Signatur und Monero-Adresskodierung nativ prüfen.",
      "Provisional, abgelaufene, falsche Netzwerk- oder widersprüchliche Records geschlossen ablehnen.",
      "Namen, vollständige Adresse, Quelle und Adressänderungswarnung vor der Zahlung sichtbar machen.",
      "Für öffentliche Identitäten eine eigene Subadresse empfehlen; die Namenshistorie bleibt öffentlich.",
    ],
    note: "Aktueller öffentlicher Preview-Origin",
  },
  en: {
    eyebrow: "Developer documentation",
    title: "Integrate .mfw safely into applications.",
    intro: "The Monero Fast Wallet Registry resolves a public name to a Monero receive address. It does not change Monero addresses, transactions, consensus, or custody.",
    statusTitle: "Controlled rollout",
    statusBody: "One public Mainnet resolver is live. Production payment resolution and binding availability remain disabled until a second independently operated resolver is available and verified.",
    checker: "Open Registry check",
    source: "Reference implementation",
    quickEyebrow: "Integration flow",
    quickTitle: "Six boundaries a safe integration must preserve.",
    steps: [
      ["01", "Canonicalize the name", "Use lowercase a–z, 0–9 and internal hyphens; 1–63 characters before .mfw. Reject Unicode and leading or trailing hyphens."],
      ["02", "Query a resolver quorum", "Query two to four independently operated HTTPS origins in parallel through the same versioned GET endpoint."],
      ["03", "Compare responses", "Immutable record fields must match. Chain tips may differ by at most five blocks; equal heights require the same tip hash."],
      ["04", "Enforce finality", "For payment, accept only finalized with at least 15 confirmations, the expected network, and expiryHeight above the conservative chain tip."],
      ["05", "Verify the record natively", "Verify the signed record against the expected name and network, then derive the Monero address from its authenticated public keys."],
      ["06", "Confirm the ordinary payment", "Show the complete name and derived address in the normal transaction review. Resolution never sends funds by itself."],
    ],
    endpointEyebrow: "HTTP Resolver API",
    endpointTitle: "Read-only, versioned, and API-key free.",
    endpointBody: "During rollout, the public endpoint is a preliminary lookup and contract reference. Production integrations must execute the same contract against at least two independent origins.",
    request: "Request",
    response: "Response fields",
    fields: [
      ["canonicalName", "Canonical name including .mfw"],
      ["status", "not_found, reserved, provisional, finalized, or expired"],
      ["network", "mainnet, testnet, or stagenet"],
      ["addressKind", "0 standard address, 1 subaddress"],
      ["publicSpendKeyHex / publicViewKeyHex", "Public Monero address keys; empty for empty states"],
      ["recordHeight / confirmations", "Record height and confirmations at the supplied tip"],
      ["sourceTxidHex / recordBlockHashHex", "Canonical transaction and block references"],
      ["expiryHeight", "Canonical expiry height, never wall-clock time"],
      ["chainTipHeight / chainTipHashHex", "Chain tip against which the answer was calculated"],
      ["recordPayloadHex", "Signed MFWN V1 record for native verification"],
    ],
    statusEyebrow: "Status model",
    modelTitle: "HTTP 200 does not automatically mean “available.”",
    statuses: [
      ["not_found", "No active record in the index. Only a valid quorum may treat this as available."],
      ["reserved", "Blocked by the versioned reserved-name manifest."],
      ["provisional", "A record exists but has not reached 15 confirmations."],
      ["finalized", "Active record. For payment, also verify signature, network, expiry, and address."],
      ["expired", "Historical record expired; registration again requires a new COMMIT and CLAIM."],
    ],
    securityEyebrow: "Security checklist",
    securityTitle: "Do not treat this as an ordinary alias API.",
    security: [
      "Never accept one not_found answer as binding availability.",
      "Reject redirects, non-HTTPS origins, extended JSON, and responses larger than 16 KiB.",
      "Do not merely concatenate address keys: verify the record signature and Monero address encoding natively.",
      "Fail closed on provisional, expired, wrong-network, or conflicting records.",
      "Show the name, full address, source, and address-change warning before payment.",
      "Recommend a dedicated subaddress for public identities; name history remains public.",
    ],
    note: "Current public preview origin",
  },
};

const exampleResponse = `{
  "canonicalName": "tex8.mfw",
  "status": "finalized",
  "network": "mainnet",
  "addressKind": 0,
  "publicSpendKeyHex": "…64 lowercase hex characters…",
  "publicViewKeyHex": "…64 lowercase hex characters…",
  "recordHeight": 3739884,
  "sourceTxidHex": "…64 lowercase hex characters…",
  "expiryHeight": 4002684,
  "chainTipHeight": 3740000,
  "confirmations": 117,
  "recordPayloadHex": "…signed MFWN V1 payload…",
  "recordBlockHashHex": "…64 lowercase hex characters…",
  "chainTipHashHex": "…64 lowercase hex characters…"
}`;

export function DeveloperPage({ language, registryHref }) {
  const text = language === "de" ? documentation.de : documentation.en;
  return (
    <main className="developer-page">
      <section className="developer-hero section">
        <div className="shell developer-hero-grid">
          <div><p className="eyebrow">{text.eyebrow}</p><h1>{text.title}</h1><p className="lead">{text.intro}</p><div className="hero-actions"><a className="button primary" href={registryHref}>{text.checker} →</a><a className="button" href={`${repositoryUrl}/tree/main/native/mfw-recipient-protocol`}>{text.source} ↗</a></div></div>
          <aside className="developer-status"><span>ROLLOUT / MAINNET</span><h2>{text.statusTitle}</h2><p>{text.statusBody}</p><small><i /> 1 / 2 independent resolvers</small></aside>
        </div>
      </section>

      <section className="section shell developer-flow"><header className="section-head"><p className="eyebrow">{text.quickEyebrow}</p><h2>{text.quickTitle}</h2></header><div className="developer-step-grid">{text.steps.map(([number, title, body]) => <article key={number}><span>{number}</span><h3>{title}</h3><p>{body}</p></article>)}</div></section>

      <section className="section developer-api"><div className="shell"><header className="section-head"><p className="eyebrow">{text.endpointEyebrow}</p><h2>{text.endpointTitle}</h2><p>{text.endpointBody}</p></header><div className="developer-api-grid"><article><h3>{text.request}</h3><div className="code-block"><span>GET</span><code>/v1/mfw/names/{"{canonicalName}"}</code></div><pre><code>{`curl --fail --silent \\\n  -H 'Accept: application/json' \\\n  'https://mfw-resolver1.tex8.com/v1/mfw/names/tex8.mfw'`}</code></pre><p className="api-origin-note">{text.note}: <code>https://mfw-resolver1.tex8.com</code></p></article><article><h3>{text.response}</h3><pre><code>{exampleResponse}</code></pre></article></div><div className="api-field-list">{text.fields.map(([field, meaning]) => <div key={field}><code>{field}</code><span>{meaning}</span></div>)}</div></div></section>

      <section className="section shell developer-status-model"><div><p className="eyebrow">{text.statusEyebrow}</p><h2>{text.modelTitle}</h2></div><div className="status-table">{text.statuses.map(([status, meaning]) => <div key={status}><code>{status}</code><p>{meaning}</p></div>)}</div></section>

      <section className="section developer-security"><div className="shell developer-security-grid"><div><p className="eyebrow">{text.securityEyebrow}</p><h2>{text.securityTitle}</h2></div><ul>{text.security.map((item) => <li key={item}>✓ <span>{item}</span></li>)}</ul></div></section>
    </main>
  );
}
