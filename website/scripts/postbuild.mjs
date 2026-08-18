import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { localeMetadata } from "../src/locales.generated.js";
import { copy } from "../src/content.js";

const dist = resolve("dist");
const baseHtml = await readFile(resolve(dist, "index.html"), "utf8");
const developerEnglish = {
  title: "MFW Registry Developer API – Monero Fast Wallet",
  description: "Integrate Monero Fast Wallet Registry names with the versioned resolver API, strict quorum checks, finality, and native record verification.",
};
const developerGerman = {
  title: "MFW Registry Entwickler-API – Monero Fast Wallet",
  description: "Monero Fast Wallet Registry sicher integrieren: versionierte Resolver-API, Quorum-Prüfung, Finalität und native Record-Verifikation.",
};
const privacyEnglish = {
  title: "Privacy – Monero Fast Wallet",
  description: "How the Monero Fast Wallet project page counts anonymous page views and download starts without cookies or visitor profiles.",
};
const privacyGerman = {
  title: "Datenschutz – Monero Fast Wallet",
  description: "Wie die Monero-Fast-Wallet-Projektseite Seitenaufrufe und Downloadstarts ohne Cookies und Besucherprofile zählt.",
};

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

function subpageHtml(tag, direction, canonical, metadata) {
  const title = escapeHtml(metadata.title);
  const description = escapeHtml(metadata.description);
  return baseHtml
    .replace('<html lang="en">', `<html lang="${tag}" dir="${direction}">`)
    .replace(/<title>[^<]+<\/title>/, `<title>${title}</title>`)
    .replace(/<meta name="description" content="[^"]+" \/>/, `<meta name="description" content="${description}" />`)
    .replace(/<meta property="og:title" content="[^"]+" \/>/, `<meta property="og:title" content="${title}" />`)
    .replace(/<meta property="og:description" content="[^"]+" \/>/, `<meta property="og:description" content="${description}" />`)
    .replace(/<meta property="og:url" content="[^"]+" \/>/, `<meta property="og:url" content="${canonical}" />`)
    .replace(/<link rel="canonical" href="[^"]+" \/>/, `<link rel="canonical" href="${canonical}" />`);
}

const englishDeveloperDirectory = resolve(dist, "developers");
await mkdir(englishDeveloperDirectory, { recursive: true });
await writeFile(resolve(englishDeveloperDirectory, "index.html"), subpageHtml("en", "ltr", "https://xmr.tex8.com/developers/", developerEnglish));

const englishPrivacyDirectory = resolve(dist, "privacy");
await mkdir(englishPrivacyDirectory, { recursive: true });
await writeFile(resolve(englishPrivacyDirectory, "index.html"), subpageHtml("en", "ltr", "https://xmr.tex8.com/privacy/", privacyEnglish));

for (const [language, config] of Object.entries(languages)) {
  const directory = resolve(dist, config.path);
  await mkdir(directory, { recursive: true });
  await writeFile(resolve(directory, "index.html"), localizedHtml(language, config));
  if (language === "de") {
    const developerDirectory = resolve(directory, "developers");
    await mkdir(developerDirectory, { recursive: true });
    await writeFile(resolve(developerDirectory, "index.html"), subpageHtml(config.tag, config.direction, "https://xmr.tex8.com/de/developers/", developerGerman));
    const privacyDirectory = resolve(directory, "datenschutz");
    await mkdir(privacyDirectory, { recursive: true });
    await writeFile(resolve(privacyDirectory, "index.html"), subpageHtml(config.tag, config.direction, "https://xmr.tex8.com/de/datenschutz/", privacyGerman));
  }
}

await writeFile(resolve(dist, "robots.txt"), "User-agent: *\nAllow: /\nSitemap: https://xmr.tex8.com/sitemap.xml\n");
const homeAlternates = Object.values(localeMetadata).map((locale) => `<xhtml:link rel="alternate" hreflang="${locale.tag}" href="https://xmr.tex8.com/${locale.route ? `${locale.route}/` : ""}"/>`).join("");
const developerAlternates = `<xhtml:link rel="alternate" hreflang="en-US" href="https://xmr.tex8.com/developers/"/><xhtml:link rel="alternate" hreflang="de-DE" href="https://xmr.tex8.com/de/developers/"/>`;
const privacyAlternates = `<xhtml:link rel="alternate" hreflang="en-US" href="https://xmr.tex8.com/privacy/"/><xhtml:link rel="alternate" hreflang="de-DE" href="https://xmr.tex8.com/de/datenschutz/"/>`;
const homeUrls = Object.values(localeMetadata).map((locale) => `  <url><loc>https://xmr.tex8.com/${locale.route ? `${locale.route}/` : ""}</loc>${homeAlternates}</url>`);
const developerUrls = [`  <url><loc>https://xmr.tex8.com/developers/</loc>${developerAlternates}</url>`, `  <url><loc>https://xmr.tex8.com/de/developers/</loc>${developerAlternates}</url>`];
const privacyUrls = [`  <url><loc>https://xmr.tex8.com/privacy/</loc>${privacyAlternates}</url>`, `  <url><loc>https://xmr.tex8.com/de/datenschutz/</loc>${privacyAlternates}</url>`];
const sitemapUrls = [...homeUrls, ...developerUrls, ...privacyUrls].join("\n");
await writeFile(resolve(dist, "sitemap.xml"), `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">
${sitemapUrls}
</urlset>
`);
