import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const app = await readFile(new URL("../src/App.jsx", import.meta.url), "utf8");
const content = await readFile(new URL("../src/content.js", import.meta.url), "utf8");
const assistant = await readFile(new URL("../src/AssistantDock.jsx", import.meta.url), "utf8");
const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
const styles = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");
const nginx = await readFile(new URL("../../ops/project-page/nginx-location.conf", import.meta.url), "utf8");
const deploy = await readFile(new URL("../../ops/project-page/deploy.sh", import.meta.url), "utf8");
const postbuild = await readFile(new URL("../scripts/postbuild.mjs", import.meta.url), "utf8");

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
  assert.match(app, /pathname\.startsWith\("\/de"\) \? "de" : "en"/);
  assert.match(postbuild, /canonical: "https:\/\/xmr\.tex8\.com\/de\/"/);
  assert.match(nginx, /location = \/en\/ \{\s*return 301 \/;/);
});

test("download formats and equal badge contract are present", () => {
  for (const format of ["apk", "dmg", "exe", "rpm", "deb", "appimage"]) assert.match(app, new RegExp(`"${format}"`));
  assert.match(app, /className="store-badge"/);
  assert.match(content, /GitHub-Releases-Bereich/);
});

test("open-source SVG links to the project repository", () => {
  assert.match(app, /Open_Source_Initiative\.svg/);
  assert.match(app, /className="osi-logo" href={repositoryUrl}/);
  assert.match(content, /github\.com\/tex8com\/monero-fast-wallet/);
  assert.match(html, /codeRepository/);
});

test("assistant has fixed product identity, knowledge, secret warning, and persistent prompt", () => {
  assert.match(assistant, /shopId: "monero-fast-wallet"/);
  assert.match(assistant, /tenantId: "tex8"/);
  assert.match(assistant, /conversation_id: conversationId/);
  assert.doesNotMatch(assistant, /system_instructions/);
  assert.doesNotMatch(assistant, /assistantKnowledge/);
  assert.doesNotMatch(assistant, /private_view_key/);
  assert.match(assistant, /className="assistant-quick-form"/);
  assert.match(assistant, /onSubmit={sendFromDock}/);
});

test("node uses the public product name", () => {
  assert.match(content, /Monero Fast Node/);
  assert.match(content, /Monero Fast Node · MFN/);
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

test("language selection lives inside the burger menu", () => {
  const navActions = app.slice(app.indexOf('<div className="nav-actions">'), app.indexOf('<nav id="site-menu"'));
  const menu = app.slice(app.indexOf('<nav id="site-menu"'), app.indexOf('</header>'));
  assert.doesNotMatch(navActions, /<LanguageLink/);
  assert.match(menu, /<LanguageLink/);
  assert.match(app, /className="menu-language-link"/);
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

test("MFN section links ready-built packages and the dedicated source repository", () => {
  assert.match(app, /nodeRepositoryUrl = "https:\/\/github\.com\/tex8com\/cuprate"/);
  assert.match(app, /nodeReleaseUrl = `\$\{nodeRepositoryUrl\}\/releases`/);
  assert.match(app, /href={nodeReleaseUrl}/);
  assert.match(app, /href={nodeRepositoryUrl}/);
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
  assert.match(app, /<strong>13\.03×<\/strong>/);
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
