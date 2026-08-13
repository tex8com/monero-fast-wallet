import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const app = await readFile(new URL("../src/App.jsx", import.meta.url), "utf8");
const content = await readFile(new URL("../src/content.js", import.meta.url), "utf8");
const assistant = await readFile(new URL("../src/AssistantDock.jsx", import.meta.url), "utf8");
const html = await readFile(new URL("../index.html", import.meta.url), "utf8");

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
  assert.match(content, /github\.com\/tex8com\/monero-fast-wallet/);
  assert.match(html, /codeRepository/);
});

test("assistant has fixed product identity, knowledge, and secret warning", () => {
  assert.match(assistant, /shopId: "monero-fast-wallet"/);
  assert.match(assistant, /tenantId: "tex8"/);
  assert.match(assistant, /conversation_id: conversationId/);
  assert.doesNotMatch(assistant, /system_instructions/);
  assert.doesNotMatch(assistant, /assistantKnowledge/);
  assert.doesNotMatch(assistant, /private_view_key/);
});

test("node uses the public product name", () => {
  assert.match(content, /Monero Fast Node/);
  assert.match(content, /Monero Fast Node · MFN/);
});
