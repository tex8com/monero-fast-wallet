import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const app = await readFile(new URL("../src/App.jsx", import.meta.url), "utf8");
const content = await readFile(new URL("../src/content.js", import.meta.url), "utf8");
const assistant = await readFile(new URL("../src/AssistantDock.jsx", import.meta.url), "utf8");
const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
const styles = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");

test("German and English routes have SEO metadata", () => {
  assert.match(html, /hreflang="de"/);
  assert.match(html, /hreflang="en"/);
  assert.match(html, /SoftwareApplication/);
  assert.match(content, /de:\s*{/);
  assert.match(content, /en:\s*{/);
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
  assert.match(styles, /\.node-label\s*\{[^}]*inset:\s*50%;[^}]*transform:\s*translate\(-50%,-50%\) rotate\(-45deg\);/);
});

test("hero carousel supports horizontal pointer swipes", () => {
  assert.match(app, /onPointerDown={startSwipe}/);
  assert.match(app, /onPointerUp={finishSwipe}/);
  assert.match(app, /Math\.abs\(horizontal\) < 48/);
  assert.match(app, /aria-roledescription="carousel"/);
  assert.match(styles, /touch-action:\s*pan-y pinch-zoom/);
  assert.match(content, /heroCarouselLabel/);
});
