export function PrivacyPage({ language }) {
  const german = language === "de";
  const tex8Privacy = german ? "https://solutions.tex8.com/de/datenschutz" : "https://solutions.tex8.com/en/privacy";
  const tex8Imprint = german ? "https://solutions.tex8.com/de/impressum" : "https://solutions.tex8.com/en/imprint";
  const content = german ? {
    eyebrow: "Datenschutz auf dieser Projektseite",
    title: "Wenige Zahlen. Keine Besucherprofile.",
    intro: "Diese Seite verwendet keine Analyse-, Werbe- oder Tracking-Cookies. Sie speichert auch keine dauerhafte Kennung im Browser.",
    controllerTitle: "Verantwortlicher",
    controller: "TEX8 betreibt diese Projektseite. Kontaktdaten und ladungsfähige Anschrift stehen im Impressum.",
    metricsTitle: "Welche Statistik wir führen",
    metrics: [
      ["Seitenaufrufe", "Pro Tag wird nur eine Gesamtzahl je Seitenbereich gespeichert."],
      ["Downloadstarts", "Gespeichert werden Tag, Produkt, Betriebssystem, Dateiformat, Version und Anzahl."],
      ["Geschätzte tägliche Besucher", "Die IP-Adresse und eine grobe Browserkennung werden nur im Arbeitsspeicher in einen nicht rückrechenbaren Statistikwert eingerechnet. Weder IP noch Kennung noch ein Besucher-Hash werden gespeichert."],
      ["Land, falls lokal verfügbar", "Die IP-Adresse kann kurz mit einer lokalen Länderdatenbank abgeglichen werden. Gespeichert wird nur die Ländersumme. Bei Tor oder fehlender Datenbank lautet das Land unbekannt."],
    ],
    meaningTitle: "Was die Downloadzahl bedeutet",
    meaning: "Gezählt wird ein gültiger Downloadstart. Die Seite kann ohne App-Telemetrie nicht feststellen, ob eine Datei vollständig geladen oder installiert wurde. Wiederholungen und automatisierte Abrufe können die Zahl erhöhen.",
    logsTitle: "Serverprotokolle",
    logs: "Für Projektseite, Statistik und Downloads sind normale Zugriffslogs deaktiviert. Kurzlebige Schutzmechanismen dürfen eine IP-Adresse im Arbeitsspeicher für Begrenzungen gegen Missbrauch verwenden; sie schreiben sie nicht in die Statistikdatenbank.",
    assistantTitle: "Optionaler TEX8-Assistent",
    assistant: "Nur wenn du den Assistenten verwendest, werden deine Eingabe, eine flüchtige Sitzungskennung und die Antwort an den TEX8-KI-Dienst übertragen. Gib dort niemals Passwörter, Seeds, Private Keys, View Keys oder andere sensible Wallet-Daten ein. Für diesen getrennten Dienst gilt ergänzend die allgemeine TEX8-Datenschutzerklärung.",
    retentionTitle: "Speicherdauer und Weitergabe",
    retention: "Anonyme Tages- und Download-Summen dürfen langfristig für die Projektentwicklung gespeichert werden. Es werden keine Statistikdaten verkauft und keine Besucherprofile an Werbepartner weitergegeben. Ein Download über den GitHub-Fallback unterliegt zusätzlich den Datenschutzregeln von GitHub.",
    rightsTitle: "Deine Rechte",
    rights: "Weil die Statistik keine Besucherkennung speichert, kann ein einzelner Statistikdatensatz später keiner Person zugeordnet werden. Für andere personenbezogene Anfragen gelten die Kontakt- und Betroffenenrechte der allgemeinen TEX8-Datenschutzerklärung.",
    privacyLink: "Allgemeine TEX8-Datenschutzerklärung",
    imprintLink: "Impressum",
  } : {
    eyebrow: "Privacy on this project site",
    title: "A few numbers. No visitor profiles.",
    intro: "This site uses no analytics, advertising, or tracking cookies. It also stores no persistent visitor identifier in the browser.",
    controllerTitle: "Controller",
    controller: "TEX8 operates this project site. Contact details and the legal address are available in the legal notice.",
    metricsTitle: "Statistics we keep",
    metrics: [
      ["Page views", "Only a daily aggregate for each page area is stored."],
      ["Download starts", "The stored fields are day, product, operating system, file format, version, and count."],
      ["Estimated daily visitors", "The IP address and a coarse browser identifier are used only in memory to update a non-reversible statistical value. No IP address, browser identifier, or visitor hash is stored."],
      ["Country, when locally available", "The IP address may be checked briefly against a local country database. Only the country total is stored. Tor traffic and missing databases are recorded as unknown."],
    ],
    meaningTitle: "What a download count means",
    meaning: "A valid download start is counted. Without app telemetry, the site cannot know whether the file was fully downloaded or installed. Retries and automated requests may increase the number.",
    logsTitle: "Server logs",
    logs: "Normal access logs are disabled for the project page, statistics, and downloads. Short-lived abuse protection may use an IP address in memory for rate limits, but does not write it to the statistics database.",
    assistantTitle: "Optional TEX8 assistant",
    assistant: "Only when you use the assistant are your message, an ephemeral session identifier, and the response sent to the TEX8 AI service. Never enter passwords, seeds, private keys, view keys, or other sensitive wallet data. The general TEX8 privacy notice also applies to this separate service.",
    retentionTitle: "Retention and sharing",
    retention: "Anonymous daily and download totals may be retained for long-term project development. Statistics are not sold and visitor profiles are not shared with advertising partners. A download through the GitHub fallback is additionally subject to GitHub's privacy terms.",
    rightsTitle: "Your rights",
    rights: "Because the statistics store no visitor identifier, an individual statistical record cannot later be linked to a person. The contact and data-subject rights in the general TEX8 privacy notice apply to other personal-data requests.",
    privacyLink: "General TEX8 privacy notice",
    imprintLink: "Legal notice",
  };

  return (
    <main className="privacy-page">
      <section className="privacy-hero shell">
        <p className="eyebrow">{content.eyebrow}</p>
        <h1>{content.title}</h1>
        <p className="lead">{content.intro}</p>
      </section>
      <section className="section shell privacy-document">
        <article><h2>{content.controllerTitle}</h2><p>{content.controller}</p></article>
        <article className="privacy-metrics"><h2>{content.metricsTitle}</h2><div>{content.metrics.map(([title, body]) => <section key={title}><h3>{title}</h3><p>{body}</p></section>)}</div></article>
        <article><h2>{content.meaningTitle}</h2><p>{content.meaning}</p></article>
        <article><h2>{content.logsTitle}</h2><p>{content.logs}</p></article>
        <article><h2>{content.assistantTitle}</h2><p>{content.assistant}</p></article>
        <article><h2>{content.retentionTitle}</h2><p>{content.retention}</p></article>
        <article><h2>{content.rightsTitle}</h2><p>{content.rights}</p></article>
        <nav className="privacy-links" aria-label={content.controllerTitle}><a className="button primary" href={tex8Privacy}>{content.privacyLink} ↗</a><a className="button" href={tex8Imprint}>{content.imprintLink} ↗</a></nav>
      </section>
    </main>
  );
}
