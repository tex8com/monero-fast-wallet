import { useEffect, useMemo, useRef, useState } from "react";
import { AssistantDock } from "./AssistantDock";
import { copy, localeMetadata, repositoryUrl } from "./content";
import { DeveloperPage } from "./DeveloperPage";
import { PrivacyPage } from "./PrivacyPage";
import { RegistryAvailability } from "./RegistryAvailability";

const badgeBase = "https://commons.wikimedia.org/wiki/Special:Redirect/file/";
const releaseUpdatesUrl = "https://x.com/roland_kk";
const donationAddress = String(import.meta.env.VITE_TEX8_DONOR_MONERO_ADDRESS ?? "").trim();
const donationAddressIsVerified = /^4[123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz]{94}$/.test(donationAddress);
const serviceAddresses = [
  { kind: "public", name: "TEX8", address: "xmr.tex8.com", href: "https://xmr.tex8.com/" },
  { kind: "public", name: "Community", address: "mfw-resolver2.tex8.com", href: "https://mfw-resolver2.tex8.com/" },
  { kind: "onion", name: "TEX8 Onion", vanity: "fastrelayrpc", address: "fastrelayrpcf3hbc4qvykjgbpwpmcuq5dpcsdxoe7gwfh2zxdib3eid.onion", href: "http://fastrelayrpcf3hbc4qvykjgbpwpmcuq5dpcsdxoe7gwfh2zxdib3eid.onion/" },
  { kind: "onion", name: "Community Onion", vanity: "quietportrpc", address: "quietportrpccujodzxhwcfefbmhftof5i6oiq7rrx5tnzna7rxirhqd.onion", href: "http://quietportrpccujodzxhwcfefbmhftof5i6oiq7rrx5tnzna7rxirhqd.onion/" },
];
const languageFlags = {
  en: "🇬🇧",
  de: "🇩🇪",
  es: "🇪🇸",
  "pt-BR": "🇧🇷",
  ru: "🇷🇺",
  vi: "🇻🇳",
  id: "🇮🇩",
  uk: "🇺🇦",
  tr: "🇹🇷",
  hi: "🇮🇳",
  ur: "🇵🇰",
  fr: "🇫🇷",
  fil: "🇵🇭",
  ja: "🇯🇵",
  ko: "🇰🇷",
  ar: "🇸🇦",
  "zh-CN": "🇨🇳",
  "zh-TW": "🇹🇼",
};

function Mark() {
  return <img className="monero-mark" src="/monero-wallet-logo.svg" alt="" aria-hidden="true" />;
}

function ServiceAddressStrip() {
  return (
    <nav className="service-address-strip shell" aria-label="Public and Onion addresses">
      {serviceAddresses.map((service) => (
        <a className={service.kind} href={service.href} target="_blank" rel="noreferrer" key={service.address} title={service.address}>
          <b>{service.name}</b><span>{service.vanity ? <><strong className="onion-vanity">{service.vanity}</strong>{service.address.slice(service.vanity.length)}</> : service.address}</span>
        </a>
      ))}
    </nav>
  );
}

function ReleaseFollow({ product, language }) {
  const german = language === "de";
  return (
    <p className="release-follow">
      <strong>{product} · {german ? "Noch nicht released." : "Not released yet."}</strong>
      <span>{german ? "Folge mir für Updates auf" : "Follow me for updates on"} <a href={releaseUpdatesUrl} target="_blank" rel="noreferrer">X @roland_kk ↗</a></span>
    </p>
  );
}

function localizedPath(language, subpage = "") {
  if (subpage === "developers") return language === "de" ? "/de/developers/" : "/developers/";
  if (subpage === "privacy") return language === "de" ? "/de/datenschutz/" : "/privacy/";
  const route = localeMetadata[language].route;
  return route ? `/${route}/${subpage ? `${subpage}/` : ""}` : subpage ? `/${subpage}/` : "/";
}

function LanguageCarousel({ language, text, subpage, open }) {
  const locales = subpage ? Object.entries(localeMetadata).filter(([code]) => code === "en" || code === "de") : Object.entries(localeMetadata);
  const trackRef = useRef(null);
  const dragRef = useRef(null);
  const suppressClickRef = useRef(false);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    if (!open) return;
    const frame = window.requestAnimationFrame(() => {
      const track = trackRef.current;
      const selected = [...(track?.children ?? [])].find((item) => item.dataset.language === language);
      if (!track || !selected) return;
      track.scrollTo({ left: selected.offsetLeft - (track.clientWidth - selected.clientWidth) / 2, behavior: "smooth" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [language, open, subpage]);

  const move = (direction) => {
    const track = trackRef.current;
    if (!track) return;
    track.scrollBy({ left: direction * Math.max(210, track.clientWidth * .72), behavior: "smooth" });
  };

  const startDrag = (event) => {
    if (event.pointerType !== "mouse" || event.button !== 0) return;
    dragRef.current = { pointerId: event.pointerId, startX: event.clientX, startScroll: event.currentTarget.scrollLeft, moved: false };
  };

  const drag = (event) => {
    const state = dragRef.current;
    if (!state || state.pointerId !== event.pointerId) return;
    const distance = event.clientX - state.startX;
    if (!state.moved && Math.abs(distance) > 5) {
      state.moved = true;
      event.currentTarget.setPointerCapture(event.pointerId);
      setDragging(true);
    }
    if (!state.moved) return;
    event.currentTarget.scrollLeft = state.startScroll - distance;
  };

  const finishDrag = (event) => {
    const state = dragRef.current;
    if (!state || state.pointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    dragRef.current = null;
    setDragging(false);
    if (!state.moved) return;
    suppressClickRef.current = true;
    window.setTimeout(() => { suppressClickRef.current = false; }, 0);
  };

  const protectLinksAfterDrag = (event) => {
    if (!suppressClickRef.current) return;
    event.preventDefault();
    event.stopPropagation();
  };

  return (
    <section className="menu-language-carousel" aria-label={text.switchLabel}>
      <button className="menu-language-arrow previous" type="button" onClick={() => move(-1)} aria-label={`${text.switchLabel} ←`}>‹</button>
      <div
        className={`menu-language-track ${dragging ? "is-dragging" : ""}`}
        ref={trackRef}
        dir="ltr"
        onPointerDown={startDrag}
        onPointerMove={drag}
        onPointerUp={finishDrag}
        onPointerCancel={finishDrag}
        onClickCapture={protectLinksAfterDrag}
      >
        {locales.map(([code, locale]) => (
          <a className={code === language ? "selected" : ""} href={localizedPath(code, subpage)} lang={locale.tag} dir={locale.direction} aria-current={code === language ? "page" : undefined} data-language={code} draggable={false} key={code}>
            <span className="menu-language-flag" aria-hidden="true">{languageFlags[code]}</span>
            <span className="menu-language-name">{locale.nativeName}</span>
            <span className="menu-language-status" aria-hidden="true">{code === language ? "✓" : "↗"}</span>
          </a>
        ))}
      </div>
      <button className="menu-language-arrow next" type="button" onClick={() => move(1)} aria-label={`${text.switchLabel} →`}>›</button>
    </section>
  );
}

function Header({ language, text, subpage }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const homePath = localizedPath(language);
  const developerPath = localizedPath(language, "developers");
  const standalonePage = Boolean(subpage);
  const homeLink = (anchor) => standalonePage ? `${homePath}${anchor}` : anchor;
  const menu = language === "de" ? {
    primary: [
      ["#wallet", "MFW", "Monero Fast Wallet", "App, Vorteile und Plattformen"],
      ["#mfn", "MFN", "Monero Fast Node", "Node, Datenweg und Betrieb"],
      ["#benchmarks", "MESSWERTE", "Leistung", "Sync und Hardware-Beschleunigung"],
    ],
    groups: [
      ["Wallet", [["#features", "Vorteile & Funktionen"], ["#fast-wallet", "Optionale Fast Wallet"], ["#downloads", "Downloads"]]],
      ["Node & Technik", [["#mfn", "Monero Fast Node"], ["#benchmarks", "Benchmarks"], ["#services", "Alle Bausteine"]]],
      ["Dienste", [["#registry", "Monero Registry"], ["#relay", "Relay Service"], ["#worker", "Fast Wallet Worker"]]],
      ["Projekt", [["#enthusiast", "Monero Enthusiast"], ["#open-source", "Open Source"], ["#roadmap", "Roadmap & unterstützen"], ["#funding", "Finanzierung"], ["#privacy-tor", "Privacy & Tor"]]],
    ],
    source: "Quellcode",
    developers: "Entwickler",
  } : {
    primary: [
      ["#wallet", "MFW", "Monero Fast Wallet", "App, benefits, and platforms"],
      ["#mfn", "MFN", "Monero Fast Node", "Node, data path, and operation"],
      ["#benchmarks", "MEASUREMENTS", "Performance", "Sync and hardware acceleration"],
    ],
    groups: [
      ["Wallet", [["#features", "Benefits & features"], ["#fast-wallet", "Optional Fast Wallet"], ["#downloads", "Downloads"]]],
      ["Node & technology", [["#mfn", "Monero Fast Node"], ["#benchmarks", "Benchmarks"], ["#services", "All building blocks"]]],
      ["Services", [["#registry", "Monero Registry"], ["#relay", "Relay Service"], ["#worker", "Fast Wallet Worker"]]],
      ["Project", [["#enthusiast", "Monero Enthusiast"], ["#open-source", "Open source"], ["#roadmap", "Roadmap & support"], ["#funding", "Funding"], ["#privacy-tor", "Privacy & Tor"]]],
    ],
    source: "Source",
    developers: "Developers",
  };
  useEffect(() => {
    const close = (event) => event.key === "Escape" && setMenuOpen(false);
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, []);
  return (
    <header className="site-header">
      <div className="shell nav-row">
        <a className="brand" href={standalonePage ? homePath : "#top"} aria-label="Monero Fast Wallet Home"><Mark /><span className="brand-name">Monero <em>Fast Wallet</em></span></a>
        <div className="nav-actions">
          <a className="download-button" href={homeLink("#downloads")} aria-label={`${text.download} App`}><span className="download-arrow" aria-hidden="true">↓</span><b>{text.download}</b><span className="mobile-download-label">APP</span></a>
          <button className="burger" type="button" aria-expanded={menuOpen} aria-controls="site-menu" aria-label={menuOpen ? text.close : text.menu} onClick={() => setMenuOpen((value) => !value)}><span /><span /><span /></button>
        </div>
      </div>
      <ServiceAddressStrip />
      <nav id="site-menu" className={`menu-panel ${menuOpen ? "is-open" : ""}`} aria-hidden={!menuOpen}>
        <div className="shell menu-links">
          <LanguageCarousel language={language} text={text} subpage={subpage} open={menuOpen} />
          <div className="menu-primary">{menu.primary.map(([href, code, label, description]) => <a href={homeLink(href)} key={href} onClick={() => setMenuOpen(false)}><small>{code}</small><b>{label}</b><p>{description}</p><span aria-hidden="true">↓</span></a>)}</div>
          <div className="menu-groups">{menu.groups.map(([group, links]) => <section key={group}><h2>{group}</h2><div>{links.map(([href, label]) => <a href={homeLink(href)} key={href} onClick={() => setMenuOpen(false)}>{label}<span aria-hidden="true">→</span></a>)}</div></section>)}</div>
          <div className="menu-secondary"><a href={developerPath} aria-current={subpage === "developers" ? "page" : undefined} onClick={() => setMenuOpen(false)}>{menu.developers}</a><a href={repositoryUrl}>{menu.source} ↗</a></div>
        </div>
      </nav>
    </header>
  );
}

function PhonePlaceholder({ text }) {
  return (
    <div className="phone-placeholder" aria-label={text.preview}>
      <div className="phone-notch" />
      <div className="phone-ui">
        <div className="phone-header"><Mark /><span>● 100%</span></div>
        <p>MONERO / USD</p><strong>US$356.24</strong>
        <svg viewBox="0 0 260 110" role="presentation"><path d="M0 82 C22 68 31 89 49 58 S81 31 99 51 S132 85 151 56 S184 16 202 34 S226 66 260 17" fill="none" stroke="#19d99a" strokeWidth="4" strokeLinecap="round" /></svg>
        <div className="phone-buttons"><span>↑<small>Send</small></span><span>↓<small>Receive</small></span></div>
      </div>
      <span className="placeholder-note">{text.preview}</span>
    </div>
  );
}

function DesktopPlaceholder({ text }) {
  return (
    <div className="desktop-placeholder" aria-label={text.preview}>
      <div className="desktop-bar"><i /><i /><i /></div>
      <div className="desktop-layout"><aside><Mark /><span /><span /><span /><span /></aside><main><h4>Monero Fast Wallet</h4><div className="desktop-balance"><b>0.000 XMR</b><span>● Synchronized</span></div><svg viewBox="0 0 500 150" role="presentation"><path d="M0 117 C42 82 58 126 90 77 S147 45 181 74 S236 124 269 80 S336 17 370 53 S427 104 500 22" fill="none" stroke="#19d99a" strokeWidth="5" strokeLinecap="round" /></svg><div className="desktop-actions"><i /><i /></div></main></div>
      <span className="placeholder-note">{text.preview}</span>
    </div>
  );
}

function Hero({ text }) {
  const [slide, setSlide] = useState(0);
  const [direction, setDirection] = useState("forward");
  const [manualChange, setManualChange] = useState(0);
  const swipeStart = useRef(null);
  const suppressClick = useRef(false);
  const interactionActive = useRef(false);
  const moveSlide = (step) => {
    interactionActive.current = true;
    setDirection(step > 0 ? "forward" : "backward");
    setSlide((value) => (value + step + text.heroSlides.length) % text.heroSlides.length);
    setManualChange((value) => value + 1);
  };
  const selectSlide = (index) => {
    interactionActive.current = true;
    setDirection(index >= slide ? "forward" : "backward");
    setSlide(index);
    setManualChange((value) => value + 1);
  };
  const startSwipe = (event) => {
    if (!event.isPrimary || event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    interactionActive.current = true;
    suppressClick.current = false;
    swipeStart.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
  };
  const finishSwipe = (event) => {
    const start = swipeStart.current;
    swipeStart.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (!start || start.pointerId !== event.pointerId) return;
    const horizontal = event.clientX - start.x;
    const vertical = event.clientY - start.y;
    if (Math.abs(horizontal) < 48 || Math.abs(horizontal) <= Math.abs(vertical) * 1.2) return;
    suppressClick.current = true;
    moveSlide(horizontal < 0 ? 1 : -1);
    window.setTimeout(() => { suppressClick.current = false; }, 0);
  };
  const protectLinksAfterSwipe = (event) => {
    if (!suppressClick.current) return;
    event.preventDefault();
    event.stopPropagation();
  };
  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return undefined;
    interactionActive.current = false;
    const timer = window.setInterval(() => {
      if (interactionActive.current) {
        interactionActive.current = false;
        return;
      }
      setDirection("forward");
      setSlide((value) => (value + 1) % text.heroSlides.length);
    }, 7000);
    return () => window.clearInterval(timer);
  }, [manualChange, text.heroSlides.length]);
  const item = text.heroSlides[slide];
  const primaryHref = slide === 2 ? "#mfn" : "#downloads";
  const secondaryHref = slide === 2 ? "#benchmarks" : "#features";
  return (
    <section
      className="hero shell"
      id="wallet"
      role="region"
      aria-roledescription="carousel"
      aria-label={text.heroCarouselLabel}
      data-slide={slide}
      onPointerDown={startSwipe}
      onPointerUp={finishSwipe}
      onPointerCancel={() => { swipeStart.current = null; }}
      onClickCapture={protectLinksAfterSwipe}
      onDragStart={(event) => event.preventDefault()}
    >
      <div className={`hero-copy slide-${direction}`} key={`${text.lang}-${slide}`} aria-live="polite" aria-atomic="true">
        <p className="eyebrow">{item.eyebrow}</p>
        <h1>{item.title[0]} <span>{item.title[1]}</span></h1>
        <p className="hero-body">{item.body}</p>
        <div className="hero-actions"><a className="button primary" href={primaryHref}>{item.primary} →</a><a className="button" href={secondaryHref}>{item.secondary}</a></div>
        <div className="trust-row">{text.trust.map((proof) => <span key={proof}>✓ {proof}</span>)}</div>
      </div>
      <div className="hero-visual"><DesktopPlaceholder text={text} /><PhonePlaceholder text={text} /></div>
      <div className="slider-controls" aria-label={text.heroCarouselLabel}>
        <button type="button" onClick={() => moveSlide(-1)} aria-label={text.previousSlide}>←</button>
        <div>{text.heroSlides.map((_, index) => <button type="button" className={index === slide ? "active" : ""} onClick={() => selectSlide(index)} key={index} aria-label={`${text.slideLabel} ${index + 1}`} aria-current={index === slide ? "true" : undefined} />)}</div>
        <button type="button" onClick={() => moveSlide(1)} aria-label={text.nextSlide}>→</button>
      </div>
    </section>
  );
}

function ProductFocus({ language }) {
  const content = language === "de" ? {
    eyebrow: "Wallet und Node im Mittelpunkt",
    title: "Eine einfache Wallet. Ein schneller Datenweg.",
    body: "Monero Fast Wallet ist die App für deine Coins. Monero Fast Node liefert ihr öffentliche Blockchain-Daten schneller. Die Wallet prüft weiterhin lokal, was dir gehört.",
    wallet: {
      code: "MFW · APP",
      status: "Release in Prüfung",
      title: "Monero Fast Wallet",
      body: "Monero senden, empfangen und mit Ledger nutzen – auf Mobilgerät und Desktop, mit demselben nativen Wallet-Core.",
      points: ["Selbstverwahrt: deine Schlüssel bleiben bei dir", "Eine Oberfläche für Software- und Ledger-Wallets", "Guthaben und Transaktionen werden lokal geprüft"],
      metric: "5 Plattformen",
      metricText: "iOS · Android · macOS · Windows · Linux",
      primary: "Wallet-Vorteile",
      secondary: "Downloads",
    },
    node: {
      code: "MFN · NODE",
      status: "Dienste live",
      title: "Monero Fast Node",
      body: "Ein Monero-kompatibler Node-Datenweg für schnelle Blockstreams und vorbereitete ScanPacks – ohne Wallet-Schlüssel am Daten-Node.",
      points: ["Öffentliche Blockdaten effizient streamen", "Ein Download, lokale Verteilung an mehrere Wallets", "Offen dokumentiert und selbst betreibbar"],
      metric: "2.802 Blöcke/s",
      metricText: "kontrollierter ScanPack-Test · 161.523 Blöcke",
      primary: "Node verstehen",
      secondary: "Messwerte",
    },
    bridge: "MFN liefert öffentliche Blockdaten",
    verify: "MFW prüft lokal Guthaben und Transaktionen",
  } : {
    eyebrow: "Wallet and Node first",
    title: "A simple wallet. A faster data path.",
    body: "Monero Fast Wallet is the app for your coins. Monero Fast Node delivers public blockchain data faster. The wallet still verifies locally what belongs to you.",
    wallet: {
      code: "MFW · APP",
      status: "Release review",
      title: "Monero Fast Wallet",
      body: "Send, receive, and use Monero with Ledger on mobile and desktop, powered by the same native wallet core.",
      points: ["Self-custodial: your keys stay with you", "One experience for software and Ledger wallets", "Balances and transactions are verified locally"],
      metric: "5 platforms",
      metricText: "iOS · Android · macOS · Windows · Linux",
      primary: "Wallet benefits",
      secondary: "Downloads",
    },
    node: {
      code: "MFN · NODE",
      status: "Services live",
      title: "Monero Fast Node",
      body: "A Monero-compatible data path for fast block streams and prepared ScanPacks, without wallet keys at the data node.",
      points: ["Stream public block data efficiently", "One download, local distribution to several wallets", "Openly documented and self-hostable"],
      metric: "2,802 blocks/s",
      metricText: "controlled ScanPack test · 161,523 blocks",
      primary: "Understand the Node",
      secondary: "Review measurements",
    },
    bridge: "MFN delivers public block data",
    verify: "MFW verifies balances and transactions locally",
  };
  const products = [
    ["wallet", content.wallet, "#features", "#downloads"],
    ["node", content.node, "#mfn", "#benchmarks"],
  ];
  return (
    <section className="section product-focus-section" id="products">
      <div className="shell">
        <header className="section-head product-focus-head"><p className="eyebrow">{content.eyebrow}</p><h2>{content.title}</h2><p>{content.body}</p></header>
        <div className="product-focus-grid">{products.map(([kind, product, primaryHref, secondaryHref]) => <article className={`product-focus-card ${kind}`} key={kind}><div className="product-focus-top"><span>{product.code}</span><small>{product.status}</small></div><h3>{product.title}</h3><p>{product.body}</p><ul>{product.points.map((point) => <li key={point}>{point}</li>)}</ul><div className="product-proof"><strong>{product.metric}</strong><span>{product.metricText}</span></div><div className="product-focus-actions"><a className="button primary" href={primaryHref}>{product.primary} →</a><a className="button" href={secondaryHref}>{product.secondary}</a></div></article>)}</div>
        <div className="product-connection"><span className="node-dot">MFN</span><b>{content.bridge}</b><i aria-hidden="true">→</i><b>{content.verify}</b><span className="wallet-dot">MFW</span></div>
      </div>
    </section>
  );
}

function ServiceOverview({ language }) {
  const content = language === "de" ? {
    eyebrow: "Die Technik hinter Wallet und Node",
    title: "Fünf Bausteine. Klare Aufgaben.",
    body: "Wallet und Node sind die Hauptprodukte. Relay, Worker und Registry ergänzen sie für optionale Fast-Wallet-Hinweise und leicht lesbare Empfängernamen.",
    details: "Mehr erfahren",
    services: [
      ["wallet", "▣", "MFW", "Monero Fast Wallet", "Die selbstverwahrte App. Sie verwaltet deine Wallet und prüft lokal, welche Ausgaben dir gehören.", "Release in Prüfung"],
      ["mfn", "◇", "MFN", "Monero Fast Node", "Liefert öffentliche Blockchain-Daten schnell an die Wallet und an berechtigte Worker.", "Dienste live"],
      ["relay", "↔", "RELAY", "Relay Service", "Nimmt nur fest große, verschlüsselte Aufträge an und reicht sie an den ausgewählten Worker weiter.", "V1 vorbereitet"],
      ["worker", "⚙", "WORKER", "Fast Wallet Worker", "Entschlüsselt ausschließlich seinen Auftrag und sucht für die getrennte Fast Wallet nach Eingängen.", "V1 vorbereitet"],
      ["registry", ".", ".MFW", "Monero Registry", "Verknüpft einen öffentlichen Namen wie alice.mfw nach kryptografischer Prüfung mit einer Empfangsadresse.", "Resolver live"],
    ],
  } : {
    eyebrow: "The technology behind Wallet and Node",
    title: "Five building blocks. Clear responsibilities.",
    body: "Wallet and Node are the main products. Relay, Worker, and Registry add optional Fast Wallet alerts and readable recipient names.",
    details: "Learn more",
    services: [
      ["wallet", "▣", "MFW", "Monero Fast Wallet", "The self-custodial app. It manages your wallet and locally checks which outputs belong to you.", "Release review"],
      ["mfn", "◇", "MFN", "Monero Fast Node", "Delivers public blockchain data quickly to the wallet and authorised Workers.", "Services live"],
      ["relay", "↔", "RELAY", "Relay Service", "Accepts only fixed-size encrypted jobs and passes each one to the selected Worker.", "V1 prepared"],
      ["worker", "⚙", "WORKER", "Fast Wallet Worker", "Decrypts only its own job and looks for incoming payments to the separate Fast Wallet.", "V1 prepared"],
      ["registry", ".", ".MFW", "Monero Registry", "Links a public name such as alice.mfw to a receive address after cryptographic verification.", "Resolvers live"],
    ],
  };
  return (
    <section className="section services-overview" id="services">
      <div className="shell">
        <header className="section-head"><p className="eyebrow">{content.eyebrow}</p><h2>{content.title}</h2><p>{content.body}</p></header>
        <div className="service-overview-grid">{content.services.map(([target, icon, code, title, body, status]) => <a href={`#${target}`} className="service-overview-card" key={code}><div><span className="service-overview-icon" aria-hidden="true">{icon}</span><small>{status}</small></div><b>{code}</b><h3>{title}</h3><p>{body}</p><em>{content.details} ↓</em></a>)}</div>
      </div>
    </section>
  );
}

function RelayWorker({ language }) {
  const content = language === "de" ? {
    eyebrow: "Optionale Fast-Wallet-Hinweise",
    title: "Relay und Worker bleiben bewusst getrennt.",
    body: "Nur eine eigens angelegte Fast Wallet kann diesen Weg nutzen. Die Hauptwallet bleibt lokal und funktioniert auch ohne Relay oder Worker.",
    steps: [
      ["1", "Die Wallet verschlüsselt", "Die App verschlüsselt Adresse, Private View Key und Starthöhe der getrennten Fast Wallet direkt für den ausgewählten Worker."],
      ["2", "Das Relay transportiert", "Das Relay sieht nur einen fest großen verschlüsselten Umschlag, die Worker-ID und kurzlebige Zustellinformationen. Es kann den Inhalt nicht lesen."],
      ["3", "Der Worker sucht", "Der Worker holt den Auftrag selbst ab, entschlüsselt ihn lokal und nutzt öffentliche ScanPack-Daten des Monero Fast Node."],
      ["4", "Die Wallet bestätigt", "Bei einem möglichen Eingang erhält die App nur einen allgemeinen Hinweis und prüft Guthaben und Transaktion anschließend selbst."],
    ],
    relayTitle: "Relay Service",
    relayBody: "Ein verschlüsselter Briefkasten. Er ordnet den Umschlag dem ausgewählten Worker zu, kennt aber weder Adresse noch View Key, Betrag oder Transaktion.",
    relayPoint: "Kein Klartext-Auftrag · kein Wallet-Seed · kein Spend Key",
    workerTitle: "Fast Wallet Worker",
    workerBody: "Der einzige Baustein, der den Umschlag öffnen kann. Er hat keinen öffentlichen Listener: Verbindungen zu Relay, Directory und Node werden vom Worker nach außen aufgebaut.",
    workerPoint: "Worker frei wählbar · eigener Worker möglich · V1 noch release-gated",
  } : {
    eyebrow: "Optional Fast Wallet alerts",
    title: "Relay and Worker stay deliberately separate.",
    body: "Only a separately created Fast Wallet can use this path. The main wallet remains local and continues to work without the Relay or a Worker.",
    steps: [
      ["1", "The wallet encrypts", "The app encrypts the separate Fast Wallet address, private view key, and restore height directly to the selected Worker."],
      ["2", "The Relay transports", "The Relay sees only a fixed-size encrypted envelope, the Worker ID, and short-lived delivery data. It cannot read the contents."],
      ["3", "The Worker scans", "The Worker pulls the job, decrypts it locally, and uses public ScanPack data from Monero Fast Node."],
      ["4", "The wallet verifies", "After a possible incoming payment, the app receives only a generic alert and verifies the balance and transaction itself."],
    ],
    relayTitle: "Relay Service",
    relayBody: "An encrypted mailbox. It routes the envelope to the selected Worker but knows no address, view key, amount, or transaction.",
    relayPoint: "No plaintext job · no wallet seed · no spend key",
    workerTitle: "Fast Wallet Worker",
    workerBody: "The only building block able to open its envelope. It has no public listener: connections to the Relay, Directory, and Node are initiated outbound by the Worker.",
    workerPoint: "Selectable Worker · self-hosted Worker supported · V1 still release-gated",
  };
  return (
    <section className="section relay-worker-section">
      <div className="shell">
        <header className="section-head"><p className="eyebrow">{content.eyebrow}</p><h2>{content.title}</h2><p>{content.body}</p></header>
        <div className="relay-worker-flow">{content.steps.map(([number, title, body]) => <article key={number}><span>{number}</span><h3>{title}</h3><p>{body}</p></article>)}</div>
        <div className="relay-worker-detail"><article id="relay"><span className="service-detail-icon" aria-hidden="true">↔</span><div><p className="eyebrow">RELAY</p><h3>{content.relayTitle}</h3><p>{content.relayBody}</p><small>{content.relayPoint}</small></div></article><article id="worker"><span className="service-detail-icon" aria-hidden="true">⚙</span><div><p className="eyebrow">WORKER</p><h3>{content.workerTitle}</h3><p>{content.workerBody}</p><small>{content.workerPoint}</small></div></article></div>
      </div>
    </section>
  );
}

function PrivacyTor({ language }) {
  const content = language === "de" ? {
    eyebrow: "Live-Infrastruktur und Privacy",
    title: "Was bereits über Tor läuft.",
    body: "Jeder Onion-Dienst nutzt eine lokale Kopie. Server 2 leitet öffentliche Inhalte nicht an Server 1 weiter. Fällt ein Ursprung aus, bleibt der andere unabhängig erreichbar.",
    headers: ["Dienst", "Öffentlich", "Tor", "Status"],
    torRows: [
      ["Landingpage", "2× HTTPS", "2× Onion", "Live"],
      ["News", "2× HTTPS", "2× Onion", "Live"],
      ["Preis & Chart", "2× HTTPS", "2× Onion", "Live"],
      ["Katalog & Suchdaten", "2× HTTPS", "2× Onion", "Live"],
      ["MFW Registry Lookup", "2× HTTPS", "2× Onion", "Live"],
      ["Eingeschränkter Node-RPC", "2× Port 18089", "2× Onion · 18089", "Live"],
      ["Wallet-Blockstream (gRPC)", "Öffentlich", "Noch nicht", "Nicht über Tor"],
      ["Werbekatalog", "Vorbereitet", "Vorbereitet", "Noch nicht aktiv"],
    ],
    improvementTitle: "Privacy-Verbesserungen im aktuellen TEX8-Aufbau",
    improvementNote: "Das ist kein pauschaler Vergleich mit Moneros Protokoll. Verglichen werden frühere beziehungsweise einfache Dienstanbindungen mit dem aktuellen TEX8-Aufbau.",
    improvementHeaders: ["Vorher / einfach", "Heute", "Privacy-Effekt"],
    improvements: [
      ["Öffentliche Inhalte von einem Ursprung", "Zwei lokale, hash-geprüfte Spiegel plus zwei Onion-Ursprünge", "Kein Proxy von Server 2 zu Server 1 und weniger zentrale Beobachtung"],
      ["Mehrere Wallet-Downloads pro Netzwerk", "Eine globale öffentliche Verbindung; alle Wallets scannen lokal", "Weniger Verbindungsmetadaten und kein View Key für den Daten-Node"],
      ["Wallet-spezifische Spent-RPC-Abfrage", "Key-Image-Zustand wird lokal aufgebaut und abgeglichen", "Kein Satz eigener Key Images wird an den Node gesendet"],
      ["Serverseitige Suche und Sortierung", "Signierter Katalog; Suche und persönliches Ranking auf dem Gerät", "Kein serverseitiges Interessenprofil für Community oder Werbung"],
      ["Gehostete Beobachtung könnte die Hauptwallet betreffen", "Fast Wallet nutzt eine eigene Identität und ist ausdrücklich optional", "Der Private View Key der Hauptwallet bleibt lokal"],
    ],
  } : {
    eyebrow: "Live infrastructure and privacy",
    title: "What already runs over Tor.",
    body: "Each Onion service uses a local copy. Server 2 does not forward public content to Server 1. If one origin fails, the other remains independently reachable.",
    headers: ["Service", "Public", "Tor", "Status"],
    torRows: [
      ["Landing page", "2× HTTPS", "2× Onion", "Live"],
      ["News", "2× HTTPS", "2× Onion", "Live"],
      ["Price & chart", "2× HTTPS", "2× Onion", "Live"],
      ["Catalog & search data", "2× HTTPS", "2× Onion", "Live"],
      ["MFW Registry lookup", "2× HTTPS", "2× Onion", "Live"],
      ["Restricted node RPC", "2× port 18089", "2× Onion · 18089", "Live"],
      ["Wallet block stream (gRPC)", "Public", "Not yet", "Not over Tor"],
      ["Advertising catalog", "Prepared", "Prepared", "Not active yet"],
    ],
    improvementTitle: "Privacy improvements in the current TEX8 architecture",
    improvementNote: "This is not a blanket comparison with the Monero protocol. It compares earlier or simple service connections with the current TEX8 architecture.",
    improvementHeaders: ["Before / simple", "Current", "Privacy effect"],
    improvements: [
      ["Public content from one origin", "Two local hash-verified mirrors plus two Onion origins", "No Server 2 proxy to Server 1 and less central observation"],
      ["Several wallet downloads per network", "One global public connection; every wallet scans locally", "Less connection metadata and no view key for the data node"],
      ["Wallet-specific spent-status RPC", "Key-image state is built and matched locally", "No set of owned key images is sent to the node"],
      ["Server-side search and ranking", "Signed catalog; search and personal ranking on device", "No server-side interest profile for community or advertising"],
      ["Hosted observation could cover the main wallet", "Fast Wallet uses a separate identity and is explicitly optional", "The main wallet private view key stays local"],
    ],
  };
  return (
    <section className="section privacy-tor-section" id="privacy-tor">
      <div className="shell privacy-tor-layout">
        <header className="section-head"><p className="eyebrow">{content.eyebrow}</p><h2>{content.title}</h2><p>{content.body}</p></header>
        <div className="simple-table tor-table" role="table" aria-label={content.title}><div className="simple-table-head" role="row">{content.headers.map((header) => <b role="columnheader" key={header}>{header}</b>)}</div>{content.torRows.map((row) => <div className="simple-table-row" role="row" key={row[0]}>{row.map((cell, index) => <span role="cell" data-label={content.headers[index]} key={`${row[0]}-${index}`}>{cell}</span>)}</div>)}</div>
        <div className="privacy-improvements"><div><h3>{content.improvementTitle}</h3><p>{content.improvementNote}</p></div><div className="simple-table improvement-table" role="table" aria-label={content.improvementTitle}><div className="simple-table-head" role="row">{content.improvementHeaders.map((header) => <b role="columnheader" key={header}>{header}</b>)}</div>{content.improvements.map((row) => <div className="simple-table-row" role="row" key={row[0]}>{row.map((cell, index) => <span role="cell" data-label={content.improvementHeaders[index]} key={`${row[0]}-${index}`}>{cell}</span>)}</div>)}</div></div>
      </div>
    </section>
  );
}

function Funding({ language }) {
  const content = language === "de" ? {
    eyebrow: "Kostenlose Wallet, klare Finanzierung",
    title: "Finanziert ohne Verkauf von Wallet-Daten.",
    body: "Die Verbraucher-Wallet bleibt kostenlos. Die geplante laufende Finanzierung stützt sich auf direkte Werbepartner und die öffentliche MFW Name Registry – nicht auf Transaktionsprovisionen oder Datenhandel.",
    partnerTitle: "Direkte Werbepartner",
    partnerBody: "Wenige, geprüfte und klar als Werbung markierte Partnerplätze. Auswahl nach Sprache, Region oder gewählter Inhaltskategorie – niemals nach Guthaben, Zahlungen, Kontakten oder Transaktionszeitpunkt.",
    partnerStatus: "Backend vorbereitet · öffentliche Aktivierung noch gesperrt",
    registryTitle: "MFW Name Registry",
    registryBody: "Registrierung und Verlängerung eines öffentlichen .mfw-Namens kosten protokollseitig 0,01 XMR pro Jahr. Der Name und seine Historie sind bewusst öffentlich; die Wallet zeigt diesen Privacy-Hinweis vor der Registrierung.",
    registryStatus: "Resolver live · Registrierung in der App release-gated",
    vanityLabel: "Separate Premium-Beta · Roadmap",
    vanityTitle: "Onion Vanity-Adressen",
    vanityBody: "Geplant ist buchbare GPU-Rechenzeit für einen gewünschten Onion-Präfix. Es gibt keine Treffer-Garantie. Der endgültige private Schlüssel darf dem Worker oder TEX8 niemals unverschlüsselt vorliegen.",
    vanityStatus: "Noch nicht veröffentlicht",
  } : {
    eyebrow: "A free wallet with clear funding",
    title: "Funded without selling wallet data.",
    body: "The consumer wallet stays free. Planned recurring funding relies on direct advertising partners and the public MFW Name Registry—not transaction percentages or data trading.",
    partnerTitle: "Direct advertising partners",
    partnerBody: "A small number of reviewed placements, always clearly labelled as advertising. Selection may use language, region, or a chosen content category—never balance, payments, contacts, or transaction timing.",
    partnerStatus: "Backend prepared · public activation still gated",
    registryTitle: "MFW Name Registry",
    registryBody: "Registering or renewing a public .mfw name costs a protocol fee of 0.01 XMR per year. The name and its history are intentionally public; the wallet displays that privacy notice before registration.",
    registryStatus: "Resolvers live · in-app registration release-gated",
    vanityLabel: "Separate premium beta · roadmap",
    vanityTitle: "Onion vanity addresses",
    vanityBody: "The roadmap offers bookable GPU compute for a requested Onion prefix. A match is not guaranteed. The final private key must never be available unencrypted to the worker or TEX8.",
    vanityStatus: "Not released yet",
  };
  return (
    <section className="section funding-section" id="funding"><div className="shell"><header className="section-head"><p className="eyebrow">{content.eyebrow}</p><h2>{content.title}</h2><p>{content.body}</p></header><div className="funding-grid"><article><span className="funding-icon" aria-hidden="true">AD</span><h3>{content.partnerTitle}</h3><p>{content.partnerBody}</p><small>{content.partnerStatus}</small></article><article><span className="funding-icon" aria-hidden="true">.MFW</span><h3>{content.registryTitle}</h3><p>{content.registryBody}</p><small>{content.registryStatus}</small></article></div><aside className="vanity-card"><div><p className="eyebrow">{content.vanityLabel}</p><h3>{content.vanityTitle}</h3><p>{content.vanityBody}</p></div><strong>{content.vanityStatus}</strong></aside></div></section>
  );
}

function RoadmapSupport({ language }) {
  const content = language === "de" ? {
    eyebrow: "Offene Roadmap",
    title: "Was fertig ist – und was bis zum Release fehlt.",
    body: "Die Reihenfolge folgt Sicherheits- und Abnahmekriterien, nicht einem erfundenen Datum. Ein Punkt wird erst als fertig markiert, wenn die zugehörigen Tests und Nachweise bestehen.",
    steps: [
      ["done", "BASIS STEHT", "Gemeinsamer Wallet-Core", "CLI, React Native und Tauri nutzen denselben Produkt-Core. Globaler Blockdownload, lokale Wallet-Scans und Hardware-Beschleunigung sind integriert und gemessen."],
      ["active", "JETZT", "V1 sicher veröffentlichen", "Physische Ledger-Abnahme, reproduzierbare signierte Pakete, unabhängige Prüfung und klare Release-Dokumentation für Wallet und Node."],
      ["next", "DANACH", "Ausfallsicherheit und Last", "Reorg, Failover sowie reale 10- und 100-Wallet-Tests. Weitere unabhängige Resolver und Worker werden erst nach bestandener Sicherheitsabnahme aktiviert."],
      ["later", "SPÄTER", "Ökosystem behutsam öffnen", "Monero Enthusiast, wenige direkte Werbepartner und Onion-Vanity-Rechenzeit folgen nur mit den dokumentierten Privacy-, Moderations- und Release-Grenzen."],
    ],
    supportEyebrow: "Open Source unterstützen",
    supportTitle: "Hilf, die unabhängige V1-Abnahme zu finanzieren.",
    supportBody: "Unterstützung fließt in Sicherheitsprüfungen, reproduzierbare Release-Builds, reale Geräte-Tests und öffentliche Test-Infrastruktur – nicht in bezahlte Produktpriorität.",
    supportPoints: ["Keine Wallet- oder Transaktionsdaten als Gegenleistung", "Keine Funktion oder Rendite für eine Spende", "Keine Behauptung einer steuerlich absetzbaren Spende"],
    donate: "XMR spenden",
    waiting: "Geprüfte XMR-Adresse folgt",
    warning: "Noch keine offizielle Spendenadresse veröffentlicht. Sende niemals an Adressen aus Kommentaren, Direktnachrichten oder inoffiziellen Kopien.",
    source: "Am Code mitarbeiten",
    updates: "Release-Updates",
  } : {
    eyebrow: "Open roadmap",
    title: "What is ready—and what remains before release.",
    body: "The order follows security and acceptance evidence, not an invented date. An item is complete only after its required tests and evidence pass.",
    steps: [
      ["done", "FOUNDATION READY", "One shared wallet core", "CLI, React Native, and Tauri use the same product core. Global block download, local wallet scans, and hardware acceleration are integrated and measured."],
      ["active", "NOW", "Release V1 safely", "Physical Ledger acceptance, reproducible signed packages, independent review, and clear release documentation for Wallet and Node."],
      ["next", "NEXT", "Resilience and load", "Reorg, failover, and real 10- and 100-wallet tests. More independent resolvers and Workers activate only after security acceptance."],
      ["later", "LATER", "Open the ecosystem carefully", "Monero Enthusiast, a small number of direct partners, and Onion vanity compute follow only with the documented privacy, moderation, and release gates."],
    ],
    supportEyebrow: "Support open source",
    supportTitle: "Help fund independent V1 acceptance.",
    supportBody: "Support funds security reviews, reproducible release builds, real-device testing, and public test infrastructure—not paid product priority.",
    supportPoints: ["No wallet or transaction data in return", "No feature or financial return for a donation", "No claim that support is tax-deductible"],
    donate: "Donate XMR",
    waiting: "Verified XMR address pending",
    warning: "No official donation address has been published yet. Never send to addresses in comments, direct messages, or unofficial copies.",
    source: "Contribute code",
    updates: "Release updates",
  };
  return (
    <section className="section roadmap-section" id="roadmap">
      <div className="shell">
        <header className="section-head"><p className="eyebrow">{content.eyebrow}</p><h2>{content.title}</h2><p>{content.body}</p></header>
        <div className="roadmap-grid">{content.steps.map(([kind, status, title, body], index) => <article className={kind} key={status}><div><span>{String(index + 1).padStart(2, "0")}</span><small>{status}</small></div><h3>{title}</h3><p>{body}</p></article>)}</div>
        <aside className="support-card"><div><p className="eyebrow">{content.supportEyebrow}</p><h3>{content.supportTitle}</h3><p>{content.supportBody}</p><ul>{content.supportPoints.map((point) => <li key={point}>{point}</li>)}</ul></div><div className="support-actions">{donationAddressIsVerified ? <><a className="button primary" href={`monero:${donationAddress}`}>{content.donate} →</a><code title={donationAddress}>{`${donationAddress.slice(0, 12)}…${donationAddress.slice(-12)}`}</code></> : <><span className="button primary is-disabled">{content.waiting}</span><small>{content.warning}</small></>}<a className="button" href={repositoryUrl}>{content.source} ↗</a><a className="button" href={releaseUpdatesUrl}>{content.updates} ↗</a></div></aside>
      </div>
    </section>
  );
}

function Features({ text }) {
  const featureIcons = ["↑", "↓", "↻", "◆", "◈", "+"];
  return (
    <section className="section shell" id="features">
      <header className="section-head"><p className="eyebrow">{text.simpleEyebrow}</p><h2>{text.simpleTitle}</h2><p>{text.simpleBody}</p></header>
      <div className="feature-grid">{text.features.map(([title, body], index) => <article key={title}><div className="feature-icon" aria-hidden="true">{featureIcons[index]}</div><div className="feature-copy"><span className="feature-index">{String(index + 1).padStart(2, "0")}</span><h3>{title}</h3><p>{body}</p></div></article>)}</div>
    </section>
  );
}

function Modes({ text }) {
  return (
    <section className="section modes-section" id="fast-wallet"><div className="shell modes-grid"><div className="mode-options"><article><i /><div><b>{text.privacy}</b><p>{text.privacyText}</p></div></article><article className="selected"><i /><div><b>{text.comfort}</b><p>{text.comfortText}</p></div></article></div><div><p className="eyebrow">{text.modeEyebrow}</p><h2>{text.modeTitle}</h2><p className="lead">{text.modeBody}</p><ul>{text.modePoints.map((point) => <li key={point}>{point}</li>)}</ul></div></div></section>
  );
}

function RegistrySection({ text, language }) {
  const registry = text.lang === "de" ? {
    eyebrow: "Monero Fast Wallet Registry · öffentliche Empfängernamen",
    title: "Was ist eine .mfw-Adresse?",
    body: "alice.mfw ist keine neue Coin- oder Adressart. Es ist ein kurzer öffentlicher Name, der auf eine ganz normale Monero-Empfangsadresse zeigt. Die lange Monero-Adresse bleibt technisch maßgeblich.",
    howTitle: "So funktioniert das Bezahlen",
    how: [["1", "Namen eingeben", "Statt 95 Zeichen tippst oder scannst du zum Beispiel alice.mfw."], ["2", "Eintrag sicher prüfen", "Die Wallet lädt den öffentlichen Registry-Eintrag und prüft Signatur, Netzwerk und Blockchain-Verankerung."], ["3", "Monero-Adresse bestätigen", "Vor dem Senden zeigt die Wallet die aufgelöste normale Monero-Adresse zur Kontrolle an."]],
    publicTitle: "Wichtig: Der Name ist öffentlich",
    publicBody: "Name, zugeordnete öffentliche Adressdaten und Änderungshistorie sind öffentlich. Guthaben, Transaktionsverlauf, Seed sowie private View- und Spend-Keys gehören niemals in die Registry.",
    mapping: "Öffentlicher .mfw-Name",
    address: "Monero-Empfangsadresse",
    operations: ["Commit + Registrierung", "Aktualisieren + verlängern", "Widerrufen + Ablauf"],
    status: "Mainnet-Resolver live · öffentliche Freigabe bleibt bis zu einem zweiten unabhängigen Resolver und der unabhängigen Prüfung gesperrt",
  } : {
    eyebrow: "Monero Fast Wallet Registry · public recipient names",
    title: "What is a .mfw address?",
    body: "alice.mfw is not a new coin or address format. It is a short public name pointing to a normal Monero receive address. The full Monero address remains technically authoritative.",
    howTitle: "How payment works",
    how: [["1", "Enter the name", "Instead of 95 characters, enter or scan a name such as alice.mfw."], ["2", "Verify the record", "The wallet retrieves the public Registry record and verifies its signature, network, and blockchain anchor."], ["3", "Confirm the Monero address", "Before sending, the wallet shows the resolved standard Monero address for review."]],
    publicTitle: "Important: the name is public",
    publicBody: "The name, assigned public address data, and change history are public. Balance, transaction history, seed, private view key, and spend key never belong in the Registry.",
    mapping: "Public .mfw name",
    address: "Monero receive address",
    operations: ["Commit + claim", "Update + renew", "Revoke + expiry"],
    status: "Mainnet resolver live · public release remains gated on a second independent resolver and independent review",
  };
  return (
    <section className="section registry-section" id="registry">
      <div className="shell registry-grid">
        <div className="registry-copy">
          <p className="eyebrow">{registry.eyebrow}</p>
          <h2>{registry.title}</h2>
          <p className="lead">{registry.body}</p>
          <div className="registry-how"><h3>{registry.howTitle}</h3>{registry.how.map(([number, title, body]) => <article key={number}><span>{number}</span><div><b>{title}</b><p>{body}</p></div></article>)}</div>
          <p className="registry-status"><i />{registry.status}</p>
        </div>
        <div className="registry-card" aria-label={registry.title}>
          <div className="registry-name"><span>alice.mfw</span><small>{registry.mapping}</small></div>
          <div className="registry-arrow" aria-hidden="true">↓</div>
          <div className="registry-address"><strong>4A••••••••••••••••••••••••</strong><small>{registry.address}</small></div>
          <div className="registry-operations">{registry.operations.map((operation) => <span key={operation}>✓ {operation}</span>)}</div>
          <aside className="registry-public-note"><strong>{registry.publicTitle}</strong><p>{registry.publicBody}</p></aside>
        </div>
        <RegistryAvailability language={language} />
      </div>
    </section>
  );
}

function Enthusiast({ text }) {
  const icons = ["⌕", "✓", "↔", "◇"];
  return (
    <section className="section enthusiast-section" id="enthusiast">
      <div className="shell enthusiast-layout">
        <div className="enthusiast-copy">
          <p className="eyebrow">{text.enthusiastEyebrow}</p>
          <h2>{text.enthusiastTitle}</h2>
          <p className="lead">{text.enthusiastBody}</p>
          <div className="enthusiast-points">
            {text.enthusiastPoints.map(([title, body], index) => <article key={title}><span aria-hidden="true">{icons[index]}</span><div><h3>{title}</h3><p>{body}</p></div></article>)}
          </div>
          <div className="enthusiast-actions"><a className="button primary" href="#downloads">{text.enthusiastDownload} ↓</a><a className="button" href={`${repositoryUrl}/blob/main/docs/PRIVACY.md`}>{text.enthusiastPrivacyLink} ↗</a></div>
          <p className="enthusiast-status"><i />{text.enthusiastStatus}</p>
        </div>
        <div className="community-preview" aria-label={text.enthusiastPreviewLabel}>
          <div className="community-preview-head"><div><Mark /><span><b>Monero Enthusiast</b><small>{text.enthusiastPreviewLabel}</small></span></div><em>LOCAL</em></div>
          <div className="community-search"><span aria-hidden="true">⌕</span><p>{text.enthusiastPreviewPlaceholder}</p><kbd>⌘ K</kbd></div>
          <div className="community-results">{text.enthusiastPreviewResults.map(([kind, title, meta], index) => <article key={title}><div className={`community-result-icon tone-${index}`} aria-hidden="true">{index + 1}</div><div><span>{kind}</span><h3>{title}</h3><p>{meta}</p></div><b aria-hidden="true">→</b></article>)}</div>
          <aside className="community-privacy"><span aria-hidden="true">◇</span><div><b>{text.enthusiastPrivacyLabel}</b><p>{text.enthusiastPrivacyText}</p></div></aside>
        </div>
      </div>
    </section>
  );
}

function Benchmark({ text }) {
  return (
    <section className="section shell" id="benchmarks">
      <header className="section-head"><p className="eyebrow">{text.benchmarkEyebrow}</p><h2>{text.benchmarkTitle}</h2><p>{text.benchmarkBody}</p></header>
      <div className="benchmark">
        <div className="benchmark-metric"><strong><span className="benchmark-value">13.03</span><span className="benchmark-times" aria-label="times">×</span></strong><span>{text.faster}</span><small>{text.benchmarkPending}</small></div>
        <div className="benchmark-bars">{text.benchmarkRows.map(([label, value, width], index) => <div className="benchmark-row" key={label}><div><b>{label}</b><span>{value}</span></div><i><em style={{ width }} className={`tone-${index}`} /></i></div>)}</div>
        <footer><p><b>{text.important}:</b> {text.benchmarkNote}</p><a href={`${repositoryUrl}/blob/main/tools/wallet-testbench/README.md`}>{text.method} ↗</a></footer>
      </div>
      <div className="acceleration">
        <header><div><p className="eyebrow">{text.derivationEyebrow}</p><h3>{text.derivationTitle}</h3></div><p>{text.derivationBody}</p></header>
        <div className="acceleration-grid">{text.derivationRows.map((item) => <article key={item.title} className={`acceleration-card ${item.kind}`}><div><span>{item.platform}</span><small>{item.status}</small></div><h4>{item.title}</h4><strong>{item.rate}</strong><p>{text.derivationUnit}</p><em>{item.comparison}</em></article>)}</div>
        <footer><p>{text.derivationNote}</p><a href={`${repositoryUrl}/blob/main/tools/xmrig-cpu-testbench/README.md`}>{text.derivationMethod} ↗</a></footer>
      </div>
    </section>
  );
}

const platforms = [
  { id: "android", title: "Android", badge: "Google_Play_Store_badge_EN.svg", alt: "Get it on Google Play", packages: ["apk"] },
  { id: "ios", title: "iPhone & iPad", badge: "Download_on_the_App_Store_RGB_blk.svg", alt: "Download on the App Store", packages: ["appstore"] },
  { id: "macos", title: "macOS", badge: "Download_on_the_Mac_App_Store_Badge_US-UK_RGB_wht.svg", alt: "Download on the Mac App Store", packages: ["dmg"] },
  { id: "windows", title: "Windows", badge: "Get_it_from_Microsoft_Badge.svg", alt: "Get it from Microsoft", packages: ["exe"] },
  { id: "linux", title: "Linux", badge: "Linux_tux_circle_logo.svg", alt: "Tux Linux mascot", packages: ["rpm", "deb", "appimage"] },
];

function Downloads({ text, releases }) {
  const available = new Map(releases.filter((release) => release.product === "mfw").map((release) => [`${release.platform}:${release.package}`, release]));
  const badge = (platform) => <span className="badge-visual">{platform.id === "linux" ? <span className="linux-badge"><img src={`${badgeBase}${platform.badge}`} alt={platform.alt} /><span><small>Download for</small><b>Linux</b></span></span> : <img src={`${badgeBase}${platform.badge}`} alt={platform.alt} />}</span>;
  return (
    <section className="section download-section shell" id="downloads"><header className="section-head centered"><p className="eyebrow">{text.downloadEyebrow}</p><h2>{text.downloadTitle}</h2><p>{text.downloadBody}</p><ReleaseFollow product="MFW" language={text.lang} /></header><div className="download-grid">{platforms.map((platform) => { const primaryKind = platform.packages.includes("appimage") ? "appimage" : platform.packages[0]; const primary = available.get(`${platform.id}:${primaryKind}`); return <article className="download-card" key={platform.id}><h3>{platform.title}</h3>{primary ? <a className="store-badge is-live" href={primary.download_path} aria-label={`${platform.title}: ${primary.version}`}>{badge(platform)}</a> : <div className="store-badge" aria-label={`${platform.title}: ${text.coming}`}>{badge(platform)}</div>}<div className="package-links">{platform.packages.map((kind) => { const release = available.get(`${platform.id}:${kind}`); const label = kind === "appstore" ? "App Store" : text.packages[kind]; return release ? <a href={release.download_path} key={kind}>{label} ↓</a> : <span key={kind}>{label}</span>; })}</div></article>; })}</div><p className="release-note">● {available.size ? (text.lang === "de" ? "Veröffentlichte Dateien werden über den datensparsamen TEX8-Downloadpfad ausgeliefert." : "Published files use the privacy-minimised TEX8 download path.") : text.releaseGate}</p></section>
  );
}

function NodeSection({ text, releases }) {
  const nodeReleases = releases.filter((release) => release.product === "mfn");
  const primaryRelease = nodeReleases.find((release) => release.package === "appimage") || nodeReleases[0];
  return (
    <section className="section node-section" id="mfn"><div className="shell node-grid"><div><p className="eyebrow">{text.nodeEyebrow}</p><h2>{text.nodeTitle}</h2><p className="lead">{text.nodeBody}</p><ReleaseFollow product="MFN" language={text.lang} /><div className="node-card"><div className="node-orbit"><i /><i /><i /></div><div className="node-label"><strong>MFN</strong><span>Monero Fast Node</span></div></div></div><div className="node-side"><div className="node-steps">{text.nodeSteps.map(([number, title, body]) => <article key={number}><span>{number}</span><div><h3>{title}</h3><p>{body}</p></div></article>)}</div><aside className="node-download-card"><p>{text.nodeDownloadEyebrow}</p><h3>{text.nodeDownloadTitle}</h3><div className="node-download-actions">{primaryRelease ? <a className="button primary" href={primaryRelease.download_path}>{text.nodeDownload}</a> : <span className="button primary is-disabled">{text.nodeDownload}</span>}<span className="button is-disabled">{text.nodeSource}</span></div>{nodeReleases.length ? <div className="node-package-links">{nodeReleases.map((release) => <a href={release.download_path} key={`${release.platform}-${release.package}`}>{release.platform} · {release.package}</a>)}</div> : <small>{text.nodeReleaseGate}</small>}</aside></div></div></section>
  );
}

function OpenSource({ text }) {
  return (
    <section className="section shell" id="open-source"><div className="open-source-card"><a className="osi-logo" href={repositoryUrl} aria-label={text.viewSource}><img src={`${badgeBase}Open_Source_Initiative.svg`} alt={text.osiAlt} /></a><div><p className="eyebrow">{text.openEyebrow}</p><h2>{text.openTitle}</h2><p>{text.openBody}</p><div className="open-actions"><a className="button primary" href={repositoryUrl}>{text.viewSource} ↗</a><a className="button" href={`${repositoryUrl}/blob/main/LICENSE`}>Licenses ↗</a></div><small>{text.osiNote}</small></div></div></section>
  );
}

function FAQ({ text }) {
  return <section className="section shell"><header className="section-head"><p className="eyebrow">{text.faqEyebrow}</p><h2>{text.faqTitle}</h2></header><div className="faq-list">{text.faqs.map(([question, answer]) => <details key={question}><summary>{question}<span>+</span></summary><p>{answer}</p></details>)}</div></section>;
}

function Footer({ text }) {
  const [status, setStatus] = useState("checking");
  useEffect(() => { fetch("/healthz", { cache: "no-store" }).then((response) => response.ok ? setStatus("online") : setStatus("offline")).catch(() => setStatus("offline")); }, []);
  const statusText = status === "online" ? text.statusOnline : status === "offline" ? text.statusOffline : text.statusChecking;
  const legal = text.lang === "de"
    ? { home: "de", privacy: "Datenschutz", imprint: "Impressum", imprintPath: "impressum", top: "↑ Oben" }
    : { home: "en", privacy: "Privacy", imprint: "Legal notice", imprintPath: "imprint", top: "↑ Top" };
  const legalBase = `https://solutions.tex8.com/${legal.home}`;
  return <footer className="site-footer"><div className="shell footer-row"><a href={legalBase}>{text.footer}</a><span className={`service-status ${status}`}>● {statusText}</span><nav aria-label={legal.privacy}><a href={localizedPath(text.lang, "privacy")}>{legal.privacy}</a><a href={`${legalBase}/${legal.imprintPath}`}>{legal.imprint}</a><a href={repositoryUrl}>{text.source}</a><a href={`${repositoryUrl}/tree/main/docs`}>Docs</a><a href="#top">{legal.top}</a></nav></div></footer>;
}

export default function App() {
  const [releases, setReleases] = useState([]);
  const routing = useMemo(() => {
    const segments = window.location.pathname.split("/").filter(Boolean).map((segment) => segment.toLowerCase());
    const route = segments[0] ?? "";
    return {
      language: Object.entries(localeMetadata).find(([, locale]) => locale.route === route)?.[0] ?? "en",
      developerPage: segments.at(-1) === "developers",
      privacyPage: segments.at(-1) === "privacy" || segments.at(-1) === "datenschutz",
    };
  }, []);
  const { language, developerPage, privacyPage } = routing;
  const text = copy[language];
  useEffect(() => { document.documentElement.lang = localeMetadata[language].tag; document.documentElement.dir = localeMetadata[language].direction; }, [language]);
  useEffect(() => {
    let active = true;
    fetch("/v1/mfw-site/releases", { cache: "no-store" })
      .then((response) => response.ok ? response.json() : Promise.reject(new Error("release catalog unavailable")))
      .then((payload) => { if (active) setReleases(Array.isArray(payload.artifacts) ? payload.artifacts : []); })
      .catch(() => { if (active) setReleases([]); });
    return () => { active = false; };
  }, []);
  useEffect(() => {
    fetch("/v1/mfw-site/page-view", {
      method: "POST",
      cache: "no-store",
      keepalive: true,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: window.location.pathname }),
    }).catch(() => {});
  }, []);
  const registryHref = `${localizedPath(language)}#registry`;
  const subpage = developerPage ? "developers" : privacyPage ? "privacy" : "";
  return <><div id="top" /><Header language={language} text={text} subpage={subpage} />{developerPage ? <DeveloperPage language={language} registryHref={registryHref} /> : privacyPage ? <PrivacyPage language={language} /> : <main><Hero text={text} /><ProductFocus language={language} /><Features text={text} /><NodeSection text={text} releases={releases} /><Benchmark text={text} /><Modes text={text} /><Downloads text={text} releases={releases} /><ServiceOverview language={language} /><RegistrySection text={text} language={language} /><RelayWorker language={language} /><Enthusiast text={text} /><OpenSource text={text} /><RoadmapSupport language={language} /><Funding language={language} /><PrivacyTor language={language} /><FAQ text={text} /></main>}<Footer text={text} />{!subpage && <AssistantDock text={text} language={language} />}</>;
}
