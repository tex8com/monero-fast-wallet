import { useEffect, useMemo, useState } from "react";
import { AssistantDock } from "./AssistantDock";
import { copy, releaseUrl, repositoryUrl } from "./content";

const badgeBase = "https://commons.wikimedia.org/wiki/Special:Redirect/file/";

function Mark() {
  return <span className="monero-mark" aria-hidden="true"><i /></span>;
}

function LanguageLink({ language, text }) {
  const href = language === "de" ? "/en/" : "/";
  return <a className="language-link" href={href} lang={language === "de" ? "en" : "de"} aria-label={text.switchLabel}>{language === "de" ? text.en : text.de}</a>;
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
        <a className="brand" href="#top" aria-label="Monero Fast Wallet Home"><Mark /><span>Monero <em>Fast Wallet</em></span></a>
        <div className="nav-actions">
          <LanguageLink language={language} text={text} />
          <a className="download-button" href="#downloads"><span aria-hidden="true">↓</span><b>{text.download}</b></a>
          <button className="burger" type="button" aria-expanded={menuOpen} aria-controls="site-menu" aria-label={menuOpen ? text.close : text.menu} onClick={() => setMenuOpen((value) => !value)}><span /><span /><span /></button>
        </div>
      </div>
      <nav id="site-menu" className={`menu-panel ${menuOpen ? "is-open" : ""}`} aria-hidden={!menuOpen}>
        <div className="shell menu-links">
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
  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return undefined;
    const timer = window.setInterval(() => setSlide((value) => (value + 1) % text.heroSlides.length), 7000);
    return () => window.clearInterval(timer);
  }, [text.heroSlides.length]);
  const item = text.heroSlides[slide];
  const primaryHref = slide === 2 ? "#mfn" : "#downloads";
  const secondaryHref = slide === 2 ? "#benchmarks" : "#features";
  return (
    <section className="hero shell" id="wallet">
      <div className="hero-copy" key={`${text.lang}-${slide}`}>
        <p className="eyebrow">{item.eyebrow}</p>
        <h1>{item.title[0]} <span>{item.title[1]}</span></h1>
        <p className="hero-body">{item.body}</p>
        <div className="hero-actions"><a className="button primary" href={primaryHref}>{item.primary} →</a><a className="button" href={secondaryHref}>{item.secondary}</a></div>
        <div className="trust-row">{text.trust.map((proof) => <span key={proof}>✓ {proof}</span>)}</div>
      </div>
      <div className="hero-visual"><DesktopPlaceholder text={text} /><PhonePlaceholder text={text} /></div>
      <div className="slider-controls" aria-label="Hero slider">
        <button type="button" onClick={() => setSlide((slide + text.heroSlides.length - 1) % text.heroSlides.length)} aria-label="Previous slide">←</button>
        <div>{text.heroSlides.map((_, index) => <button type="button" className={index === slide ? "active" : ""} onClick={() => setSlide(index)} key={index} aria-label={`Slide ${index + 1}`} aria-current={index === slide ? "true" : undefined} />)}</div>
        <button type="button" onClick={() => setSlide((slide + 1) % text.heroSlides.length)} aria-label="Next slide">→</button>
      </div>
    </section>
  );
}

function Features({ text }) {
  return (
    <section className="section shell" id="features">
      <header className="section-head"><p className="eyebrow">{text.simpleEyebrow}</p><h2>{text.simpleTitle}</h2><p>{text.simpleBody}</p></header>
      <div className="feature-grid">{text.features.map(([title, body], index) => <article key={title}><span>{String(index + 1).padStart(2, "0")}</span><h3>{title}</h3><p>{body}</p></article>)}</div>
    </section>
  );
}

function Modes({ text }) {
  return (
    <section className="section modes-section"><div className="shell modes-grid"><div className="mode-options"><article><i /><div><b>{text.privacy}</b><p>{text.privacyText}</p></div></article><article className="selected"><i /><div><b>{text.comfort}</b><p>{text.comfortText}</p></div></article></div><div><p className="eyebrow">{text.modeEyebrow}</p><h2>{text.modeTitle}</h2><p className="lead">{text.modeBody}</p><ul>{text.modePoints.map((point) => <li key={point}>{point}</li>)}</ul></div></div></section>
  );
}

function Benchmark({ text }) {
  const rows = [["Original Monero Wallet", "207 blocks/s · 12m 52s", "13%"], ["Monero Fast Wallet", "860 blocks/s · 3m 05s", "54%"], ["Fast Wallet + ScanPack", "1,605 blocks/s · 1m 39s", "100%"]];
  return (
    <section className="section shell" id="benchmarks"><header className="section-head"><p className="eyebrow">{text.benchmarkEyebrow}</p><h2>{text.benchmarkTitle}</h2><p>{text.benchmarkBody}</p></header><div className="benchmark"><div className="benchmark-metric"><strong>7.77×</strong><span>{text.faster}</span></div><div className="benchmark-bars">{rows.map(([label, value, width], index) => <div className="benchmark-row" key={label}><div><b>{label}</b><span>{value}</span></div><i><em style={{ width }} className={`tone-${index}`} /></i></div>)}</div><footer><p><b>Important:</b> {text.benchmarkNote}</p><a href={`${repositoryUrl}/blob/main/docs/WALLET_SYNC_BENCHMARK_RESULTS.md`}>{text.method} ↗</a></footer></div></section>
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
    <section className="section node-section" id="mfn"><div className="shell node-grid"><div><p className="eyebrow">{text.nodeEyebrow}</p><h2>{text.nodeTitle}</h2><p className="lead">{text.nodeBody}</p><div className="node-card"><div className="node-orbit"><i /><i /><i /></div><strong>MFN</strong><span>Monero Fast Node</span></div></div><div className="node-steps">{text.nodeSteps.map(([number, title, body]) => <article key={number}><span>{number}</span><div><h3>{title}</h3><p>{body}</p></div></article>)}</div></div></section>
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
  const language = useMemo(() => window.location.pathname.startsWith("/en") ? "en" : "de", []);
  const text = copy[language];
  useEffect(() => { document.documentElement.lang = language; }, [language]);
  return <><div id="top" /><Header language={language} text={text} /><main><Hero text={text} /><Features text={text} /><Modes text={text} /><Benchmark text={text} /><Downloads text={text} /><NodeSection text={text} /><OpenSource text={text} /><FAQ text={text} /></main><Footer text={text} /><AssistantDock text={text} language={language} /></>;
}
