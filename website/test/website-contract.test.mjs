import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const app = await readFile(new URL("../src/App.jsx", import.meta.url), "utf8");
const content = await readFile(new URL("../src/content.js", import.meta.url), "utf8");
const assistant = await readFile(new URL("../src/AssistantDock.jsx", import.meta.url), "utf8");
const assistantKnowledge = await readFile(new URL("../../ops/project-page/assistant-knowledge.txt", import.meta.url), "utf8");
const assistantSystemPrompt = await readFile(new URL("../../ops/project-page/assistant-system-prompt.txt", import.meta.url), "utf8");
const developer = await readFile(new URL("../src/DeveloperPage.jsx", import.meta.url), "utf8");
const privacy = await readFile(new URL("../src/PrivacyPage.jsx", import.meta.url), "utf8");
const availability = await readFile(new URL("../src/RegistryAvailability.jsx", import.meta.url), "utf8");
const registrationTracker = JSON.parse(await readFile(new URL("../public/mfw-registration-tracking.json", import.meta.url), "utf8"));
const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
const styles = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");
const nginx = await readFile(new URL("../../ops/project-page/nginx-location.conf", import.meta.url), "utf8");
const downloadNginx = await readFile(new URL("../../ops/project-page/nginx-download-gateway.conf", import.meta.url), "utf8");
const staticNginx = await readFile(new URL("../../ops/project-page/nginx-static-site.conf", import.meta.url), "utf8");
const downloadGateway = await readFile(new URL("../../ops/project-page/download_gateway.py", import.meta.url), "utf8");
const deploy = await readFile(new URL("../../ops/project-page/deploy.sh", import.meta.url), "utf8");
const mirrorPull = await readFile(new URL("../../ops/project-page/pull-mirror.sh", import.meta.url), "utf8");
const mirrorService = await readFile(new URL("../../ops/project-page/mfw-project-page-mirror.service", import.meta.url), "utf8");
const mirrorTimer = await readFile(new URL("../../ops/project-page/mfw-project-page-mirror.timer", import.meta.url), "utf8");
const postbuild = await readFile(new URL("../scripts/postbuild.mjs", import.meta.url), "utf8");
const localeConfig = JSON.parse(await readFile(new URL("../../config/product-locales.json", import.meta.url), "utf8"));
const generatedLocales = await readFile(new URL("../src/locales.generated.js", import.meta.url), "utf8");
const { copy, localeMetadata } = await import(new URL("../src/content.js", import.meta.url));

function stringLeaves(value, path = [], result = new Map()) {
  if (typeof value === "string") result.set(JSON.stringify(path), value);
  else if (Array.isArray(value)) value.forEach((entry, index) => stringLeaves(entry, [...path, index], result));
  else if (value && typeof value === "object") Object.entries(value).forEach(([key, entry]) => stringLeaves(entry, [...path, key], result));
  return result;
}

function placeholders(value) {
  return [...value.matchAll(/\{[A-Za-z0-9_]+\}/g)].map(match => match[0]).sort();
}

test("German and English routes have SEO metadata", () => {
  assert.match(html, /hreflang="de"/);
  assert.match(html, /hreflang="en"/);
  assert.match(html, /SoftwareApplication/);
  assert.match(content, /de:\s*{/);
  assert.match(content, /en:\s*{/);
});

test("English is canonical at root and German lives under de", () => {
  assert.match(html, /<html lang="en">/);
  assert.match(html, /hreflang="en" href="https:\/\/xmr\.tex8\.com\/"/);
  assert.match(html, /hreflang="de" href="https:\/\/xmr\.tex8\.com\/de\/"/);
  assert.match(app, /locale\.route === route/);
  assert.match(postbuild, /canonical: `https:\/\/xmr\.tex8\.com\/\$\{locale\.route\}\/`/);
  assert.match(nginx, /location = \/en\/ \{[\s\S]*?return 301 \/;/);
  assert.match(deploy, /301 https:\/\/xmr\.tex8\.com\//);
});

test("all 18 requested website locales are complete, routed, and RTL-aware", () => {
  assert.equal(localeConfig.length, 18);
  assert.equal(Object.keys(localeMetadata).length, 18);
  const englishLeaves = stringLeaves(copy.en);
  for (const locale of localeConfig) {
    const translatedLeaves = stringLeaves(copy[locale.code]);
    assert.deepEqual([...translatedLeaves.keys()], [...englishLeaves.keys()], `${locale.code} key shape`);
    for (const [path, source] of englishLeaves) assert.deepEqual(placeholders(translatedLeaves.get(path)), placeholders(source), `${locale.code} placeholders at ${path}`);
    if (locale.route) assert.match(nginx, new RegExp(locale.route.replace("-", "\\-")));
  }
  assert.match(app, /document\.documentElement\.dir = localeMetadata\[language\]\.direction/);
  assert.match(styles, /html\[dir="rtl"\]/);
  assert.match(postbuild, /hreflang/);
});

test("download formats stay visible without pre-release app links", () => {
  for (const format of ["apk", "dmg", "exe", "rpm", "deb", "appimage"]) assert.match(app, new RegExp(`"${format}"`));
  assert.match(app, /className="store-badge"/);
  assert.match(styles, /\.store-badge \{[^}]*background: transparent;/);
  assert.doesNotMatch(styles, /\.store-badge \{[^}]*background: #0b0a10;/);
  assert.doesNotMatch(app, /href={releaseUrl}/);
  assert.doesNotMatch(app, /nodeReleaseUrl|nodeRepositoryUrl/);
  assert.match(content, /Download-Links werden erst nach der öffentlichen Freigabe aktiviert/);
});

test("the compact top strip links every public and onion address", () => {
  for (const address of [
    "xmr.tex8.com",
    "mfw-resolver2.tex8.com",
    "fastrelayrpcf3hbc4qvykjgbpwpmcuq5dpcsdxoe7gwfh2zxdib3eid.onion",
    "quietportrpccujodzxhwcfefbmhftof5i6oiq7rrx5tnzna7rxirhqd.onion",
  ]) assert.match(app, new RegExp(address.replaceAll(".", "\\.")));
  assert.match(app, /className="service-address-strip shell"/);
  assert.match(app, /vanity: "fastrelayrpc"/);
  assert.match(app, /vanity: "quietportrpc"/);
  assert.match(app, /className="onion-vanity"/);
  assert.match(app, /service\.address\.slice\(service\.vanity\.length\)/);
  assert.match(styles, /\.service-address-strip \{[^}]*height: 31px;[^}]*overflow-x: auto;/);
  assert.match(styles, /\.service-address-strip \.onion-vanity \{[^}]*color: #d8e4ff;[^}]*font-weight: 950;/);
});

test("MFW and MFN show their pre-release state and X update link", () => {
  assert.match(app, /ReleaseFollow product="MFW"/);
  assert.match(app, /ReleaseFollow product="MFN"/);
  assert.match(app, /https:\/\/x\.com\/roland_kk/);
  assert.match(app, /Noch nicht released\./);
});

test("Wallet and Node lead the page before supporting services and Tor", () => {
  assert.match(app, /function ProductFocus/);
  assert.match(app, /Wallet und Node im Mittelpunkt/);
  assert.match(app, /Eine einfache Wallet\. Ein schneller Datenweg\./);
  assert.match(app, /2\.802 Blöcke\/s/);
  assert.match(app, /<Hero text={text} \/><ProductFocus language={language} \/><Features text={text} \/><NodeSection text={text} releases={releases} \/><Benchmark text={text} \/>/);
  assert.match(app, /<OpenSource text={text} \/><RoadmapSupport language={language} \/><Funding language={language} \/><PrivacyTor language={language} \/><FAQ text={text} \/>/);
  assert.match(styles, /\.product-focus-grid \{[^}]*grid-template-columns: 1fr 1fr/);
  assert.match(styles, /\.product-focus-card\.wallet/);
  assert.match(styles, /\.product-focus-card\.node/);
});

test("the architecture overview still links the five real building blocks", () => {
  assert.match(app, /function ServiceOverview/);
  assert.match(app, /id="services"/);
  for (const service of ["Monero Fast Wallet", "Monero Fast Node", "Relay Service", "Fast Wallet Worker", "Monero Registry"]) {
    assert.match(app, new RegExp(service.replaceAll(".", "\\.")));
  }
  for (const target of ["wallet", "mfn", "relay", "worker", "registry"]) assert.match(app, new RegExp(`\\["${target}"`));
  assert.doesNotMatch(app, /Sieben Dienste|Seven services/);
  assert.doesNotMatch(app, /className="service-tor-note" href="#privacy-tor"/);
  assert.match(styles, /\.service-overview-grid \{[^}]*repeat\(5,minmax\(0,1fr\)\)/);
});

test("Relay and outbound-only Worker are explained in a simple four-step flow", () => {
  assert.match(app, /function RelayWorker/);
  assert.match(app, /id="relay"/);
  assert.match(app, /id="worker"/);
  assert.match(app, /fest großen verschlüsselten Umschlag/);
  assert.match(app, /keinen öffentlichen Listener/);
  assert.match(app, /Adresse noch View Key, Betrag oder Transaktion/);
  assert.match(app, /<RelayWorker language={language} \/>/);
});

test("Tor coverage and privacy improvements stay explicit and fail-honest", () => {
  assert.match(app, /function PrivacyTor/);
  assert.match(app, /id="privacy-tor"/);
  assert.match(app, /MFW Registry Lookup/);
  assert.match(app, /Wallet-Blockstream \(gRPC\).*Noch nicht.*Nicht über Tor/s);
  assert.match(app, /Werbekatalog.*Noch nicht aktiv/s);
  assert.match(app, /Key-Image-Zustand wird lokal aufgebaut und abgeglichen/);
  assert.match(app, /kein pauschaler Vergleich mit Moneros Protokoll/i);
  assert.match(styles, /\.simple-table-row span::before \{ content: attr\(data-label\)/);
});

test("funding is limited to direct partners and the public Registry, with vanity clearly gated", () => {
  assert.match(app, /function Funding/);
  assert.match(app, /id="funding"/);
  assert.match(app, /Direkte Werbepartner/);
  assert.match(app, /0,01 XMR pro Jahr/);
  assert.match(app, /niemals nach Guthaben, Zahlungen, Kontakten oder Transaktionszeitpunkt/);
  assert.match(app, /Onion Vanity-Adressen/);
  assert.match(app, /keine Treffer-Garantie/);
  assert.match(app, /className="vanity-card"/);
  assert.match(styles, /\.vanity-card \{[^}]*border: 1px solid rgba\(255,138,74,\.55\);[^}]*background: radial-gradient/);
});

test("open-source SVG links to the project repository", () => {
  assert.match(app, /Open_Source_Initiative\.svg/);
  assert.match(app, /className="osi-logo" href={repositoryUrl}/);
  assert.match(content, /github\.com\/tex8com\/monero-fast-wallet/);
  assert.match(html, /codeRepository/);
});

test("footer links the tailored local privacy page and external legal notice without a cookie banner", () => {
  assert.match(app, /privacy: "Datenschutz", imprint: "Impressum", imprintPath: "impressum"/);
  assert.match(app, /privacy: "Privacy", imprint: "Legal notice", imprintPath: "imprint"/);
  assert.match(app, /https:\/\/solutions\.tex8\.com\/\$\{legal\.home\}/);
  assert.match(app, /href={localizedPath\(text\.lang, "privacy"\)}/);
  assert.match(app, /href={`\$\{legalBase\}\/\$\{legal\.imprintPath\}`}/);
  assert.doesNotMatch(app, /cookie-banner|cookie-consent/i);
  assert.doesNotMatch(assistant, /document\.cookie|localStorage|sessionStorage|analytics|marketing/i);
  assert.match(assistant, /let ephemeralDeviceId = null/);
  assert.match(privacy, /Keine Besucherprofile|No visitor profiles/);
  assert.match(privacy, /Downloadstarts/);
  assert.match(privacy, /Weder IP noch Kennung noch ein Besucher-Hash werden gespeichert/);
  assert.match(postbuild, /englishPrivacyDirectory/);
  assert.match(nginx, /location = \/privacy\//);
  assert.match(nginx, /location = \/de\/datenschutz\//);
});

test("page views and releases use the privacy-minimised same-origin gateway", () => {
  assert.match(app, /fetch\("\/v1\/mfw-site\/page-view"/);
  assert.match(app, /fetch\("\/v1\/mfw-site\/releases"/);
  assert.match(app, /release\.download_path/);
  assert.doesNotMatch(app, /document\.cookie|localStorage|sessionStorage/);
  assert.match(downloadNginx, /location = \/v1\/mfw-site\/page-view/);
  assert.match(downloadNginx, /location ~ "\^\/download\//);
  assert.match(downloadNginx, /access_log off;/);
  assert.match(staticNginx, /include \/etc\/nginx\/snippets\/mfw-download-gateway\.conf/);
  assert.match(downloadGateway, /CREATE TABLE IF NOT EXISTS aggregate_counters/);
  assert.match(downloadGateway, /CREATE TABLE IF NOT EXISTS unique_hll/);
  assert.doesNotMatch(downloadGateway, /INSERT INTO[^\n]*(ip|user_agent|referrer|visitor_hash)/i);
});

test("the availability checker shows explicitly published COMMIT progress", () => {
  assert.match(availability, /lookupPublishedMfwRegistration/);
  assert.match(availability, /COMMIT reif – CLAIM ausstehend/);
  assert.match(availability, /commitConfirmations/);
  assert.equal(registrationTracker.schema, 1);
  assert.equal(registrationTracker.registrations[0].canonicalName, "tex8.mfw");
  assert.equal(registrationTracker.registrations[0].commitTxidHex.length, 64);
  assert.equal(registrationTracker.registrations[0].claimTxidHex.length, 64);
  assert.match(availability, /CLAIM gesendet/);
  assert.match(nginx, /location = \/mfw-registration-tracking\.json/);
  assert.match(staticNginx, /location = \/mfw-registration-tracking\.json/);
  assert.doesNotMatch(nginx, /Cache-Control "public, max-age=300"/);
  assert.doesNotMatch(staticNginx, /Cache-Control "public, max-age=300"/);
  assert.match(nginx, /location = \/ \{[\s\S]*?Cache-Control "no-cache"/);
  assert.match(staticNginx, /location = \/ \{[\s\S]*?Cache-Control "no-cache"/);
});

test("assistant has fixed product identity, knowledge, secret warning, and persistent prompt", () => {
  assert.match(assistant, /shopId: "monero-fast-wallet"/);
  assert.match(assistant, /tenantId: "tex8"/);
  assert.match(assistant, /conversation_id: conversationId/);
  assert.doesNotMatch(assistant, /system_instructions/);
  assert.doesNotMatch(assistant, /assistantKnowledge/);
  assert.doesNotMatch(assistant, /private_view_key/);
  assert.match(assistant, /data-contract-version="tex8\.customer-assistant\.v1"/);
  assert.match(assistant, /data-module-version={assistantModuleVersion}/);
  assert.match(assistant, /className="tx8-assistant__panel"/);
  assert.match(assistant, /className="tx8-assistant__dock" onSubmit={send}/);
  assert.match(assistant, /role="dialog"/);
});

test("assistant knowledge covers the complete product and stays release-honest", () => {
  for (const requiredTopic of [
    "Monero Fast Wallet Registry",
    "Monero Fast Node",
    "Fast Wallet Community Directory",
    "Fast Wallet Ciphertext Relay",
    "Fast Wallet Worker",
    "Notification Gateway",
    "fast-wallet-scanner-core",
    "484-Byte-HPKE-Hüllen",
    "Standard-Produktslot ist 199",
    "COMMIT",
    "CLAIM",
    "UPDATE",
    "RENEW",
    "REVOKE",
    "Android",
    "iOS",
    "macOS",
    "Windows",
    "Linux",
    "React Native",
    "Tauri 2",
    "fast-wallet-cli",
    "Ledger Nano X BLE",
    "USB/HID",
    "ScanPack",
    "Monero Enthusiast",
    "Praktische Wallet-Einrichtung und Bedienung",
    "Sichere Fehlerbehebung",
    "Backup, Wiederherstellung, Migration und Entfernung",
    "Eigener Node, eigener Worker und Entwicklergrenzen",
    "Support, Verfügbarkeit, Kosten und Moderation",
  ]) assert.ok(assistantKnowledge.includes(requiredTopic), `assistant knowledge missing ${requiredTopic}`);
  assert.match(assistantKnowledge, /öffentliche Mainnet-V1-Release NO-GO/);
  assert.match(assistantKnowledge, /Windows[^\n]+native Wallet-Core-DLL[^\n]+noch nicht/);
  assert.match(assistantKnowledge, /Server-Betriebsweg[^\n]+Linux mit systemd/);
  assert.match(assistantKnowledge, /Worker ist[^\n]+outbound-only/);
  assert.match(assistantKnowledge, /private View Key dieser separaten Fast Wallet/);
  assert.match(assistantKnowledge, /Der Relay kann die Hülle nicht entschlüsseln/);
  assert.match(assistantKnowledge, /Worker erkennt lediglich einen möglichen Eingang/);
  assert.match(assistantKnowledge, /Gateway stellt nur einen generischen Hinweis zu/);
  assert.match(assistantKnowledge, /verifiziert der lokale Wallet-Core das tatsächliche Ergebnis/);
  assert.match(assistantKnowledge, /nicht eine öffentliche Produktionsfreigabe/);
  assert.match(assistantKnowledge, /zweiter unabhängig betriebener Resolver/);
  assert.match(assistantKnowledge, /dürfen nicht vermischt werden/);
  assert.match(assistantKnowledge, /Ein bereits verbundenes und entsperrtes Ledger darf niemals vorsorglich zurückgesetzt/);
  assert.match(assistantKnowledge, /Eine Wallet darf zur Fehlerbehebung nicht gelöscht, neu erstellt oder überschrieben werden/);
  assert.match(assistantKnowledge, /Hauptwallet-Wörter allein reproduzieren diese zufällig erzeugte Fast Wallet noch nicht/);
  assert.match(assistantKnowledge, /Fast-Wallet-Zuweisung besitzt eine 30-Tage-Lease/);
  assert.match(assistantKnowledge, /Online-Watch soll innerhalb von 24 Stunden gelöscht sein/);
  assert.match(assistantKnowledge, /Wiederherstellungskopien dürfen höchstens sieben Tage bestehen/);
  assert.match(assistantKnowledge, /Ein eigener privater Fast Wallet Worker ist architektonisch vorgesehen/);
  assert.match(assistantKnowledge, /ein fertiger Turnkey-Self-Hosting-Release ist noch nicht freigegeben/);
  assert.match(assistantKnowledge, /offizielle Supportkontakt ist `info@tex8\.com`/);
  assert.match(assistantKnowledge, /Android 7\.0\/API 24, iOS 17, macOS 12 und Windows 11/);
  assert.match(assistantKnowledge, /Ubuntu 24\.04 LTS die V1-Abnahmebasis/);
  assert.match(assistantKnowledge, /Jeder darf kostenlos einen eigenen Worker betreiben/);
  assert.match(assistantKnowledge, /aktuell von TEX8 bereitgestellte Worker ist kostenlos/);
  assert.match(assistantKnowledge, /Zukünftige Premiumfunktionen sind nicht automatisch kostenlos/);
  assert.match(assistantKnowledge, /automatische KI-Vorprüfung/);
  assert.match(assistantKnowledge, /Einspruch soll `info@tex8\.com` nur mit einer opaken Fallreferenz benachrichtigen/);
  assert.match(assistantKnowledge, /Zielzeitraum ist ungefähr Mitte September 2026/);
  assert.match(assistantSystemPrompt, /Directory veröffentlicht Worker, Relay transportiert nur Ciphertext, Worker erkennt Kandidaten, Gateway stellt den generischen Hinweis zu/);
  assert.match(assistantSystemPrompt, /Empfehle bei Fehlern niemals vorsorgliches Löschen, Überschreiben, Zurücksetzen oder Neuerstellen/);
  assert.match(assistantSystemPrompt, /Eine generische Benachrichtigung ist kein Zahlungsnachweis/);
  assert.match(assistantSystemPrompt, /Erfinde keine Mindestversionen, Supportkontakte, Verfügbarkeitsgarantien, Löschfristen, Preise/);
  assert.doesNotMatch(assistantKnowledge, /\b4[123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz]{94}\b/);
  assert.doesNotMatch(assistantKnowledge, /\b[0-9a-f]{64}\b/i);
});

test("benchmark multiplier is a separate typographic unit", () => {
  assert.match(app, /className="benchmark-value">13\.03<\/span><span className="benchmark-times"/);
  assert.match(styles, /\.benchmark-times\s*\{[^}]*font-size:\s*\.58em;/);
});

test("node uses the public product name", () => {
  assert.match(content, /Monero Fast Node/);
  assert.match(content, /Monero Fast Node · MFN/);
  assert.doesNotMatch(content, /Cuprate/i);
  assert.doesNotMatch(generatedLocales, /Cuprate/i);
});

test("the public .mfw layer uses the Monero Fast Wallet Registry product name", () => {
  assert.match(app, /id="registry"/);
  assert.match(app, /Monero Fast Wallet Registry/);
  assert.match(app, /alice\.mfw/);
  assert.match(app, /public release remains gated/);
  assert.match(app, /<RegistryAvailability/);
  assert.match(app, /\["#registry", "Monero Registry"\]/);
  assert.match(availability, /lookupMfwName/);
  assert.match(availability, /ausschließlich in der Monero Fast Wallet App möglich/);
  assert.match(availability, /only be available in the Monero Fast Wallet app/);
  assert.doesNotMatch(availability, /Technical documentation|Technische Dokumentation/);
});

test("the public .mfw name is explained as an alias for a standard Monero address", () => {
  assert.match(app, /Was ist eine \.mfw-Adresse\?/);
  assert.match(app, /keine neue Coin- oder Adressart/);
  assert.match(app, /lange Monero-Adresse bleibt technisch maßgeblich/);
  assert.match(app, /Statt 95 Zeichen/);
  assert.match(app, /Signatur, Netzwerk und Blockchain-Verankerung/);
  assert.match(app, /Name, zugeordnete öffentliche Adressdaten und Änderungshistorie sind öffentlich/);
  assert.match(app, /Guthaben, Transaktionsverlauf, Seed sowie private View- und Spend-Keys gehören niemals in die Registry/);
  assert.match(app, /className="registry-how"/);
  assert.match(app, /className="registry-public-note"/);
});

test("the roadmap has evidence-based stages and a fail-closed donation call", () => {
  assert.match(app, /function RoadmapSupport/);
  assert.match(app, /id="roadmap"/);
  assert.match(app, /BASIS STEHT.*JETZT.*DANACH.*SPÄTER/s);
  assert.match(app, /Physische Ledger-Abnahme/);
  assert.match(app, /reale 10- und 100-Wallet-Tests/);
  assert.match(app, /VITE_TEX8_DONOR_MONERO_ADDRESS/);
  assert.match(app, /donationAddressIsVerified \? <><a className="button primary" href={`monero:\$\{donationAddress\}`}/);
  assert.match(app, /Noch keine offizielle Spendenadresse veröffentlicht/);
  assert.match(app, /Sende niemals an Adressen aus Kommentaren, Direktnachrichten oder inoffiziellen Kopien/);
  assert.match(app, /Keine Behauptung einer steuerlich absetzbaren Spende/);
  assert.match(app, /\["#roadmap", "Roadmap & unterstützen"\]/);
  assert.match(styles, /\.roadmap-grid \{[^}]*repeat\(4,minmax\(0,1fr\)\)/);
  assert.match(styles, /\.support-card \{[^}]*grid-template-columns/);
});

test("developer menu and localized API documentation route are shipped", () => {
  assert.match(app, /localizedPath\(language, "developers"\)/);
  assert.match(app, /developers: "Entwickler"/);
  assert.match(app, /developers: "Developers"/);
  assert.match(app, /<DeveloperPage/);
  assert.match(developer, /GET<\/span><code>\/v1\/mfw\/names/);
  assert.match(developer, /two to four independently operated HTTPS origins/);
  assert.match(developer, /mindestens 15 Bestätigungen/);
  assert.match(nginx, /location = \/developers\//);
  assert.match(nginx, /location = \/de\/developers\//);
  assert.match(postbuild, /englishDeveloperDirectory/);
  assert.match(postbuild, /developerAlternates/);
  assert.match(deploy, /de\/developers\//);
});

test("mobile header keeps the logo and uses a labelled app button", () => {
  assert.match(app, /src="\/monero-wallet-logo\.svg"/);
  assert.match(app, /className="brand-name"/);
  assert.match(app, /className="mobile-download-label">APP</);
  assert.doesNotMatch(styles, /\.brand span\s*\{\s*display:\s*none/);
  assert.doesNotMatch(styles, /\.brand-name\s*\{\s*display:\s*none/);
  assert.doesNotMatch(styles, /\.monero-mark i/);
  assert.match(styles, /\.mobile-download-label\s*\{\s*display:\s*inline/);
});

test("the production route and deployment gate serve the real wallet logo", () => {
  assert.match(nginx, /location = \/monero-wallet-logo\.svg/);
  assert.match(deploy, /https:\/\/xmr\.tex8\.com\/monero-wallet-logo\.svg/);
  assert.match(deploy, /grep -q '<svg'/);
});

test("Server 1 publishes an immutable project-page mirror and Server 2 activates it fail-closed", () => {
  assert.match(nginx, /location = \/mfw-mirror\/current/);
  assert.match(nginx, /\[0-9a-f\]\{64\}/);
  assert.match(deploy, /sha256sum/);
  assert.match(deploy, /mv -Tf "\$\{mirror_root\}\/current\.next"/);
  assert.match(mirrorPull, /--proto '=https'/);
  assert.match(mirrorPull, /actual_sha256.*expected_sha256/s);
  assert.match(mirrorPull, /non-regular file/);
  assert.match(mirrorPull, /mv -Tf "\$\{current_link\}\.next"/);
  assert.match(mirrorService, /ProtectSystem=strict/);
  assert.match(mirrorService, /mfw-download-mirror-pull/);
  assert.match(mirrorTimer, /OnUnitActiveSec=2min/);
});

test("language selection lives inside the burger menu", () => {
  const navActions = app.slice(app.indexOf('<div className="nav-actions">'), app.indexOf('<nav id="site-menu"'));
  const menu = app.slice(app.indexOf('<nav id="site-menu"'), app.indexOf('</header>'));
  assert.doesNotMatch(navActions, /<LanguageCarousel/);
  assert.match(menu, /<LanguageCarousel/);
  assert.match(app, /className="menu-language-carousel"/);
  assert.match(app, /className={`menu-language-track/);
  assert.match(app, /onPointerDown={startDrag}/);
  assert.match(app, /track\.scrollBy/);
  assert.match(app, /Object\.entries\(localeMetadata\)/);
  assert.match(app, /className="menu-primary"/);
  assert.match(app, /className="menu-groups"/);
  assert.match(app, /className="menu-secondary"/);
  assert.match(app, /\["#wallet", "MFW", "Monero Fast Wallet"/);
  assert.match(app, /\["#mfn", "MFN", "Monero Fast Node"/);
  assert.match(app, /\["#features", "Vorteile & Funktionen"\].*\["#fast-wallet", "Optionale Fast Wallet"\].*\["#downloads", "Downloads"\]/s);
  assert.match(app, /\["#mfn", "Monero Fast Node"\].*\["#benchmarks", "Benchmarks"\].*\["#services", "Alle Bausteine"\]/s);
  assert.match(app, /\["#registry", "Monero Registry"\].*\["#relay", "Relay Service"\].*\["#worker", "Fast Wallet Worker"\]/s);
  for (const flag of ["🇬🇧", "🇩🇪", "🇪🇸", "🇧🇷", "🇷🇺", "🇻🇳", "🇮🇩", "🇺🇦", "🇹🇷", "🇮🇳", "🇵🇰", "🇫🇷", "🇵🇭", "🇯🇵", "🇰🇷", "🇸🇦", "🇨🇳", "🇹🇼"]) {
    assert.ok(app.includes(flag), `missing language flag ${flag}`);
  }
  assert.match(styles, /\.menu-language-track\s*\{[^}]*overflow-x:\s*auto;[^}]*scroll-snap-type:\s*x mandatory;[^}]*touch-action:\s*pan-x;/);
  assert.match(styles, /\.menu-language-track\.is-dragging\s*\{[^}]*cursor:\s*grabbing;/);
});

test("desktop language clicks are not intercepted by carousel pointer capture", () => {
  const startDrag = app.slice(app.indexOf("const startDrag"), app.indexOf("const drag"));
  const drag = app.slice(app.indexOf("const drag"), app.indexOf("const finishDrag"));
  assert.doesNotMatch(startDrag, /setPointerCapture/);
  assert.doesNotMatch(startDrag, /setDragging\(true\)/);
  assert.match(drag, /Math\.abs\(distance\) > 5/);
  assert.match(drag, /setPointerCapture\(event\.pointerId\)/);
  assert.match(drag, /if \(!state\.moved\) return/);
  assert.match(app, /href={localizedPath\(code, subpage\)}/);
});

test("the mobile menu scrolls to its final links above the assistant", () => {
  assert.match(styles, /\.site-header \{[^}]*--site-header-height: 108px;[^}]*z-index: 120;/);
  assert.match(styles, /\.menu-panel\.is-open \{[^}]*max-height: calc\(100dvh - var\(--site-header-height\)\);[^}]*overflow-y: auto;[^}]*overscroll-behavior-y: contain;[^}]*-webkit-overflow-scrolling: touch;[^}]*touch-action: pan-y;/);
  assert.match(styles, /\.menu-links \{[^}]*env\(safe-area-inset-bottom\)/);
  assert.match(styles, /@media \(max-width: 760px\)[\s\S]*?\.site-header \{ --site-header-height: 100px; \}/);
  assert.match(styles, /\.tx8-assistant__root \{[^}]*z-index: 100;/);
});

test("mobile page clamps horizontal overflow while the hero remains swipeable", () => {
  assert.match(styles, /html, body, #root\s*\{[^}]*overflow-x:\s*clip;[^}]*overscroll-behavior-x:\s*none;/);
  assert.match(styles, /\.hero\s*\{[^}]*touch-action:\s*pan-y pinch-zoom;/);
});

test("mobile download cards use content height without empty space", () => {
  assert.match(styles, /\.download-card\s*\{\s*min-height:\s*0;\s*padding:\s*16px 12px;/);
  assert.match(styles, /\.package-links\s*\{\s*min-height:\s*0;\s*margin-top:\s*10px;/);
});

test("MFN label is centered as one counter-rotated group", () => {
  assert.match(app, /className="node-label"><strong>MFN<\/strong><span>Monero Fast Node<\/span>/);
  assert.match(styles, /\.node-label\s*\{[^}]*left:\s*47%;[^}]*top:\s*47%;[^}]*transform:\s*translate\(-50%,-50%\) rotate\(-45deg\);/);
});

test("MFN package and source labels stay visible without pre-release links", () => {
  assert.match(app, /className="button primary is-disabled">{text\.nodeDownload}/);
  assert.match(app, /className="button is-disabled">{text\.nodeSource}/);
  assert.doesNotMatch(app, /href={nodeReleaseUrl}|href={nodeRepositoryUrl}/);
  assert.match(content, /Fertige Node-Pakete/);
  assert.match(content, /Ready-built node packages/);
});

test("hero carousel supports horizontal pointer swipes", () => {
  assert.match(app, /onPointerDown={startSwipe}/);
  assert.match(app, /onPointerUp={finishSwipe}/);
  assert.match(app, /Math\.abs\(horizontal\) < 48/);
  assert.match(app, /aria-roledescription="carousel"/);
  assert.match(styles, /touch-action:\s*pan-y pinch-zoom/);
  assert.match(content, /heroCarouselLabel/);
});

test("hardware acceleration is reported separately from end-to-end sync", () => {
  assert.match(app, /className="acceleration"/);
  assert.match(content, /Original Monero Ref10/);
  assert.match(content, /27\.030,166/);
  assert.match(content, /77\.962,845/);
  assert.match(content, /459\.493,923/);
  assert.match(content, /26\.818\.054,526/);
  assert.match(content, /ARM64 MEHRKERN/);
  assert.match(content, /NEON-fähig/);
  assert.match(content, /NVIDIA CUDA/);
  assert.match(content, /APPLE METAL/);
  assert.match(content, /nicht Blöcke\/s und nicht die gesamte Sync-Zeit/);
  assert.match(content, /Validated current core/);
});

test("current strict sync matrix replaces the former published comparison", () => {
  assert.match(app, /className="benchmark-value">13\.03<\/span><span className="benchmark-times"[^>]*>×<\/span>/);
  assert.doesNotMatch(app, /<strong>7\.77×<\/strong>/);
  assert.match(content, /161\.523 Mainnet-Blöcke/);
  assert.match(content, /2\.802 Blöcke\/s · 58 s/);
  assert.match(content, /750\.875 s → 57\.640 s|34,351 GiB/);
  assert.match(content, /2,802 blocks\/s · 58 s/);
});

test("feature cards alternate their icon placement", () => {
  assert.match(app, /const featureIcons = \["↑", "↓", "↻", "◆", "◈", "\+"\]/);
  assert.match(app, /className="feature-icon"/);
  assert.match(styles, /\.feature-grid article:nth-child\(even\) \{ flex-direction: row-reverse; \}/);
});

test("Monero Enthusiast is visible, wallet-isolated, local-first, and honestly release-gated", () => {
  assert.match(app, /id="enthusiast"/);
  assert.match(app, /className="community-preview"/);
  assert.match(content, /Ein signierter öffentlicher Katalog wird auf das Gerät geladen/);
  assert.match(content, /end-to-end encrypted Matrix conversation/);
  assert.match(content, /nicht mit Wallet-Adresse, Guthaben, Verlauf, Seed oder Schlüsseln verknüpft/);
  assert.match(content, /public release acceptance still pending/);
  assert.match(content, /Im Quellcode umgesetzt · öffentliche Freigabe noch in Prüfung/);
});
