import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const dist = resolve("dist");
const baseHtml = await readFile(resolve(dist, "index.html"), "utf8");

const languages = {
  de: {
    path: "de",
    title: "Monero Fast Wallet – privates Monero, einfach gemacht",
    description: "Monero Fast Wallet für iOS, Android, macOS, Windows und Linux. Einfach, selbstverwahrt und Open Source – mit Monero Fast Node.",
    canonical: "https://xmr.tex8.com/de/",
  },
};

function localizedHtml(language, config) {
  return baseHtml
    .replace('<html lang="en">', `<html lang="${language}">`)
    .replace(/<title>[^<]+<\/title>/, `<title>${config.title}</title>`)
    .replace(/<meta name="description" content="[^"]+" \/>/, `<meta name="description" content="${config.description}" />`)
    .replace(/<meta property="og:title" content="[^"]+" \/>/, `<meta property="og:title" content="${config.title}" />`)
    .replace(/<meta property="og:description" content="[^"]+" \/>/, `<meta property="og:description" content="${config.description}" />`)
    .replace(/<meta property="og:url" content="[^"]+" \/>/, `<meta property="og:url" content="${config.canonical}" />`)
    .replace(/<link rel="canonical" href="[^"]+" \/>/, `<link rel="canonical" href="${config.canonical}" />`);
}

for (const [language, config] of Object.entries(languages)) {
  const directory = resolve(dist, config.path);
  await mkdir(directory, { recursive: true });
  await writeFile(resolve(directory, "index.html"), localizedHtml(language, config));
}

await writeFile(resolve(dist, "robots.txt"), "User-agent: *\nAllow: /\nSitemap: https://xmr.tex8.com/sitemap.xml\n");
await writeFile(resolve(dist, "sitemap.xml"), `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">
  <url><loc>https://xmr.tex8.com/</loc><xhtml:link rel="alternate" hreflang="en" href="https://xmr.tex8.com/"/><xhtml:link rel="alternate" hreflang="de" href="https://xmr.tex8.com/de/"/></url>
  <url><loc>https://xmr.tex8.com/de/</loc><xhtml:link rel="alternate" hreflang="en" href="https://xmr.tex8.com/"/><xhtml:link rel="alternate" hreflang="de" href="https://xmr.tex8.com/de/"/></url>
</urlset>
`);
