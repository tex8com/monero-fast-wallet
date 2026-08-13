import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { localeMetadata } from "../src/locales.generated.js";
import { copy } from "../src/content.js";

const dist = resolve("dist");
const baseHtml = await readFile(resolve(dist, "index.html"), "utf8");

const languages = Object.fromEntries(Object.entries(localeMetadata).filter(([code]) => code !== "en").map(([code, locale]) => [code, {
  path: locale.route,
  title: `Monero Fast Wallet – ${copy[code].heroSlides[0].title.join(" ")}`,
  description: copy[code].heroSlides[0].body,
  canonical: `https://xmr.tex8.com/${locale.route}/`,
  tag: locale.tag,
  direction: locale.direction,
}]));

function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function localizedHtml(language, config) {
  const title = escapeHtml(config.title);
  const description = escapeHtml(config.description);
  return baseHtml
    .replace('<html lang="en">', `<html lang="${config.tag}" dir="${config.direction}">`)
    .replace(/<title>[^<]+<\/title>/, `<title>${title}</title>`)
    .replace(/<meta name="description" content="[^"]+" \/>/, `<meta name="description" content="${description}" />`)
    .replace(/<meta property="og:title" content="[^"]+" \/>/, `<meta property="og:title" content="${title}" />`)
    .replace(/<meta property="og:description" content="[^"]+" \/>/, `<meta property="og:description" content="${description}" />`)
    .replace(/<meta property="og:url" content="[^"]+" \/>/, `<meta property="og:url" content="${config.canonical}" />`)
    .replace(/<link rel="canonical" href="[^"]+" \/>/, `<link rel="canonical" href="${config.canonical}" />`);
}

for (const [language, config] of Object.entries(languages)) {
  const directory = resolve(dist, config.path);
  await mkdir(directory, { recursive: true });
  await writeFile(resolve(directory, "index.html"), localizedHtml(language, config));
}

await writeFile(resolve(dist, "robots.txt"), "User-agent: *\nAllow: /\nSitemap: https://xmr.tex8.com/sitemap.xml\n");
const alternates = Object.entries(localeMetadata).map(([code, locale]) => `<xhtml:link rel="alternate" hreflang="${locale.tag}" href="https://xmr.tex8.com/${locale.route ? `${locale.route}/` : ""}"/>`).join("");
const sitemapUrls = Object.entries(localeMetadata).map(([, locale]) => `  <url><loc>https://xmr.tex8.com/${locale.route ? `${locale.route}/` : ""}</loc>${alternates}</url>`).join("\n");
await writeFile(resolve(dist, "sitemap.xml"), `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">
${sitemapUrls}
</urlset>
`);
