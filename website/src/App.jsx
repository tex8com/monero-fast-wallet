import { useEffect, useMemo, useRef, useState } from "react";
import { AssistantDock } from "./AssistantDock";
import { copy, localeMetadata, releaseUrl, repositoryUrl } from "./content";

const badgeBase = "https://commons.wikimedia.org/wiki/Special:Redirect/file/";
const nodeRepositoryUrl = "https://github.com/tex8com/cuprate";
const nodeReleaseUrl = `${nodeRepositoryUrl}/releases`;

function Mark() {
  return <img className="monero-mark" src="/monero-wallet-logo.svg" alt="" aria-hidden="true" />;
}

function LanguageLink({ language, text }) {
  return <div className="menu-language-picker" aria-label={text.switchLabel}>{Object.entries(localeMetadata).map(([code, locale]) => <a className={code === language ? "selected" : ""} href={locale.route ? `/${locale.route}/` : "/"} lang={locale.tag} aria-current={code === language ? "page" : undefined} key={code}>{locale.nativeName}<span>{code === language ? "✓" : "↗"}</span></a>)}</div>;
}

function Header({ language, text }) {
  const [menuOpen, setMenuOpen] = useState(false);
  useEffect(() => {
    const close = (event) => event.key === "Escape" && setMenuOpen(false);
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, []);
  return (
    <header className="site-header">
      <div className="shell nav-row">
        <a className="brand" href="#top" aria-label="Monero Fast Wallet Home"><Mark /><span className="brand-name">Monero <em>Fast Wallet</em></span></a>
        <div className="nav-actions">
          <a className="download-button" href="#downloads" aria-label={`${text.download} App`}><span className="download-arrow" aria-hidden="true">↓</span><b>{text.download}</b><span className="mobile-download-label">APP</span></a>
          <button className="burger" type="button" aria-expanded={menuOpen} aria-controls="site-menu" aria-label={menuOpen ? text.close : text.menu} onClick={() => setMenuOpen((value) => !value)}><span /><span /><span /></button>
        </div>
      </div>
      <nav id="site-menu" className={`menu-panel ${menuOpen ? "is-open" : ""}`} aria-hidden={!menuOpen}>
        <div className="shell menu-links">
          <LanguageLink language={language} text={text} />
          {text.nav.map(([href, label]) => <a href={href} key={href} onClick={() => setMenuOpen(false)}>{label}<span>↘</span></a>)}
          <a href={repositoryUrl}>{text.github}<span>↗</span></a>
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
    <section className="section modes-section"><div className="shell modes-grid"><div className="mode-options"><article><i /><div><b>{text.privacy}</b><p>{text.privacyText}</p></div></article><article className="selected"><i /><div><b>{text.comfort}</b><p>{text.comfortText}</p></div></article></div><div><p className="eyebrow">{text.modeEyebrow}</p><h2>{text.modeTitle}</h2><p className="lead">{text.modeBody}</p><ul>{text.modePoints.map((point) => <li key={point}>{point}</li>)}</ul></div></div></section>
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
          <div className="enthusiast-actions"><a className="button primary" href="#downloads">{text.enthusiastDownload} ↓</a><a className="button" href={`${repositoryUrl}/blob/main/docs/PRIVACY_MODEL.md`}>{text.enthusiastPrivacyLink} ↗</a></div>
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
        <div className="benchmark-metric"><strong>13.03×</strong><span>{text.faster}</span><small>{text.benchmarkPending}</small></div>
        <div className="benchmark-bars">{text.benchmarkRows.map(([label, value, width], index) => <div className="benchmark-row" key={label}><div><b>{label}</b><span>{value}</span></div><i><em style={{ width }} className={`tone-${index}`} /></i></div>)}</div>
        <footer><p><b>{text.important}:</b> {text.benchmarkNote}</p><a href={`${repositoryUrl}/blob/main/docs/WALLET_SYNC_BENCHMARK_RESULTS.md`}>{text.method} ↗</a></footer>
      </div>
      <div className="acceleration">
        <header><div><p className="eyebrow">{text.derivationEyebrow}</p><h3>{text.derivationTitle}</h3></div><p>{text.derivationBody}</p></header>
        <div className="acceleration-grid">{text.derivationRows.map((item) => <article key={item.title} className={`acceleration-card ${item.kind}`}><div><span>{item.platform}</span><small>{item.status}</small></div><h4>{item.title}</h4><strong>{item.rate}</strong><p>{text.derivationUnit}</p><em>{item.comparison}</em></article>)}</div>
        <footer><p>{text.derivationNote}</p><a href={`${repositoryUrl}/blob/main/docs/WALLET_ACCELERATION_TESTBENCH_INDEX.md`}>{text.derivationMethod} ↗</a></footer>
      </div>
    </section>
  );
}

const platforms = [
  { id: "android", title: "Android", badge: "Google_Play_Store_badge_EN.svg", alt: "Get it on Google Play", packages: ["apk"] },
  { id: "ios", title: "iPhone & iPad", badge: "Download_on_the_App_Store_RGB_blk.svg", alt: "Download on the App Store", packages: [] },
  { id: "macos", title: "macOS", badge: "Download_on_the_Mac_App_Store_Badge_US-UK_RGB_wht.svg", alt: "Download on the Mac App Store", packages: ["dmg"] },
  { id: "windows", title: "Windows", badge: "Get_it_from_Microsoft_Badge.svg", alt: "Get it from Microsoft", packages: ["exe"] },
  { id: "linux", title: "Linux", badge: "Linux_tux_circle_logo.svg", alt: "Tux Linux mascot", packages: ["rpm", "deb", "appimage"] },
];

function Downloads({ text }) {
  return (
    <section className="section download-section shell" id="downloads"><header className="section-head centered"><p className="eyebrow">{text.downloadEyebrow}</p><h2>{text.downloadTitle}</h2><p>{text.downloadBody}</p></header><div className="download-grid">{platforms.map((platform) => <article className="download-card" key={platform.id}><h3>{platform.title}</h3><a className="store-badge" href={releaseUrl} aria-label={`${platform.title}: ${text.coming}`}><span className="badge-visual">{platform.id === "linux" ? <span className="linux-badge"><img src={`${badgeBase}${platform.badge}`} alt={platform.alt} /><span><small>Download for</small><b>Linux</b></span></span> : <img src={`${badgeBase}${platform.badge}`} alt={platform.alt} />}</span></a><div className="package-links">{platform.packages.length ? platform.packages.map((kind) => <a href={releaseUrl} key={kind}>{text.packages[kind]} ↗</a>) : <span>{text.coming}</span>}</div></article>)}</div><p className="release-note">● {text.releaseGate}</p></section>
  );
}

function NodeSection({ text }) {
  return (
    <section className="section node-section" id="mfn"><div className="shell node-grid"><div><p className="eyebrow">{text.nodeEyebrow}</p><h2>{text.nodeTitle}</h2><p className="lead">{text.nodeBody}</p><div className="node-card"><div className="node-orbit"><i /><i /><i /></div><div className="node-label"><strong>MFN</strong><span>Monero Fast Node</span></div></div></div><div className="node-side"><div className="node-steps">{text.nodeSteps.map(([number, title, body]) => <article key={number}><span>{number}</span><div><h3>{title}</h3><p>{body}</p></div></article>)}</div><aside className="node-download-card"><p>{text.nodeDownloadEyebrow}</p><h3>{text.nodeDownloadTitle}</h3><div className="node-download-actions"><a className="button primary" href={nodeReleaseUrl}>{text.nodeDownload} ↓</a><a className="button" href={nodeRepositoryUrl}>{text.nodeSource} ↗</a></div><small>{text.nodeReleaseGate}</small></aside></div></div></section>
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
  return <footer className="site-footer"><div className="shell footer-row"><a href="https://solutions.tex8.com/en">{text.footer}</a><span className={`service-status ${status}`}>● {statusText}</span><nav><a href={repositoryUrl}>{text.source}</a><a href={`${repositoryUrl}/tree/main/docs`}>Docs</a><a href="#top">↑ Top</a></nav></div></footer>;
}

export default function App() {
  const language = useMemo(() => {
    const route = window.location.pathname.split("/").filter(Boolean)[0]?.toLowerCase() ?? "";
    return Object.entries(localeMetadata).find(([, locale]) => locale.route === route)?.[0] ?? "en";
  }, []);
  const text = copy[language];
  useEffect(() => { document.documentElement.lang = localeMetadata[language].tag; document.documentElement.dir = localeMetadata[language].direction; }, [language]);
  return <><div id="top" /><Header language={language} text={text} /><main><Hero text={text} /><Features text={text} /><Modes text={text} /><Enthusiast text={text} /><Benchmark text={text} /><Downloads text={text} /><NodeSection text={text} /><OpenSource text={text} /><FAQ text={text} /></main><Footer text={text} /><AssistantDock text={text} language={language} /></>;
}
