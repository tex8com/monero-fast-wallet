import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const localeConfig = JSON.parse(await readFile(resolve(root, "config/product-locales.json"), "utf8"));
const generatedLocales = localeConfig.filter(({ code }) => !["en", "de"].includes(code));
const cacheRoot = resolve(root, "build/localization-cache-v1");
const targets = new Set(process.argv.slice(2).length ? process.argv.slice(2) : ["website", "mobile", "desktop"]);

const protectedTerms = [
  "Monero Fast Wallet",
  "Monero Fast Node",
  "Monero Enthusiast",
  "Fast Wallet",
  "React Native",
  "Tauri 2",
  "Open Source Initiative",
  "AppVault",
  "ScanPack",
  "Cuprate",
  "Ledger",
  "Matrix",
  "Mainnet",
  "Monero",
  "GitHub",
  "Android",
  "iOS",
  "macOS",
  "Windows",
  "Linux",
  "CUDA",
  "Metal",
  "NEON",
  "XMR",
  "MFN",
];

function findMatchingBrace(source, openIndex) {
  let depth = 0;
  let quote = null;
  let escaped = false;
  for (let index = openIndex; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === "'" || character === '"' || character === "`") {
      quote = character;
      continue;
    }
    if (character === "{") depth += 1;
    if (character === "}" && --depth === 0) return index;
  }
  throw new Error(`Unclosed object beginning at ${openIndex}`);
}

function readObject(source, marker, nestedKey) {
  const markerIndex = source.indexOf(marker);
  if (markerIndex < 0) throw new Error(`Missing marker: ${marker}`);
  const keyIndex = nestedKey ? source.indexOf(nestedKey, markerIndex + marker.length) : markerIndex;
  if (keyIndex < 0) throw new Error(`Missing nested marker: ${nestedKey}`);
  const openIndex = source.indexOf("{", keyIndex + (nestedKey?.length ?? marker.length));
  const closeIndex = findMatchingBrace(source, openIndex);
  // The extracted literals are committed project source, never remote input.
  return Function(`"use strict"; return (${source.slice(openIndex, closeIndex + 1)});`)();
}

function flatten(value, path = [], result = []) {
  if (typeof value === "string") result.push({ path, value });
  else if (Array.isArray(value)) value.forEach((entry, index) => flatten(entry, [...path, index], result));
  else if (value && typeof value === "object") Object.entries(value).forEach(([key, entry]) => flatten(entry, [...path, key], result));
  return result;
}

function rebuild(template, translations, path = []) {
  const key = JSON.stringify(path);
  if (typeof template === "string") return translations.get(key);
  if (Array.isArray(template)) return template.map((entry, index) => rebuild(entry, translations, [...path, index]));
  if (template && typeof template === "object") return Object.fromEntries(Object.entries(template).map(([name, entry]) => [name, rebuild(entry, translations, [...path, name])]));
  return template;
}

function protect(text) {
  const replacements = [];
  let protectedText = text.replace(/\{[A-Za-z0-9_]+\}/g, value => {
    const token = `__MFWVAR${replacements.length}__`;
    replacements.push([token, value]);
    return token;
  });
  for (const term of protectedTerms) {
    protectedText = protectedText.replaceAll(term, () => {
      const token = `__MFWTERM${replacements.length}__`;
      replacements.push([token, term]);
      return token;
    });
  }
  return { protectedText, replacements };
}

function restore(text, replacements) {
  let restored = text.trim();
  for (const [token, value] of replacements) {
    restored = restored.replaceAll(token, value);
    const relaxedToken = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/__$/, "\\s*__");
    restored = restored.replace(new RegExp(relaxedToken, "g"), value);
  }
  return restored.replace(/\s+([,.;:!?])/g, "$1");
}

function responseText(payload) {
  if (!Array.isArray(payload?.[0])) throw new Error("Unexpected translation response");
  return payload[0].map(segment => segment?.[0] ?? "").join("");
}

async function translateSingleFallback(entry, language, attempt = 0) {
  const prepared = { ...entry, ...protect(entry.value) };
  const url = new URL("https://api.mymemory.translated.net/get");
  url.searchParams.set("q", prepared.protectedText);
  url.searchParams.set("langpair", `en|${language.translationTarget}`);
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    if (payload.responseStatus !== 200 || typeof payload.responseData?.translatedText !== "string") throw new Error(payload.responseDetails || "Unexpected fallback response");
    return { path: entry.path, value: restore(payload.responseData.translatedText, prepared.replacements) };
  } catch (error) {
    if (attempt >= 5) throw new Error(`${language.code} fallback: ${error.message}`);
    await new Promise(resolveDelay => setTimeout(resolveDelay, 800 * (2 ** attempt)));
    return translateSingleFallback(entry, language, attempt + 1);
  }
}

async function translateBatch(entries, language, attempt = 0) {
  const prepared = entries.map((entry, index) => ({ ...entry, ...protect(entry.value), marker: `__MFWITEM${String(index).padStart(4, "0")}__` }));
  const query = prepared.length === 1 ? prepared[0].protectedText : prepared.map(entry => `${entry.marker} ${entry.protectedText}`).join("\n");
  const body = new URLSearchParams({ client: "gtx", sl: "en", tl: language.translationTarget, dt: "t", q: query });
  try {
    const response = await fetch("https://translate.googleapis.com/translate_a/single", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded;charset=UTF-8" }, body, signal: AbortSignal.timeout(30_000) });
    if (!response.ok) {
      const retryAfter = Number(response.headers.get("retry-after") ?? 0);
      const error = new Error(`HTTP ${response.status}`);
      error.retryAfter = retryAfter;
      throw error;
    }
    const translated = responseText(await response.json());
    if (prepared.length === 1) return [{ path: prepared[0].path, value: restore(translated, prepared[0].replacements) }];
    const parts = new Map();
    const pattern = /__MFWITEM(\d{4})__\s*([\s\S]*?)(?=__MFWITEM\d{4}__|$)/g;
    for (const match of translated.matchAll(pattern)) parts.set(Number(match[1]), match[2]);
    if (parts.size !== prepared.length) {
      if (entries.length === 1) throw new Error(`Only ${parts.size}/${prepared.length} markers returned`);
      const middle = Math.ceil(entries.length / 2);
      return [
        ...await translateBatch(entries.slice(0, middle), language),
        ...await translateBatch(entries.slice(middle), language),
      ];
    }
    return prepared.map((entry, index) => ({ path: entry.path, value: restore(parts.get(index), entry.replacements) }));
  } catch (error) {
    if (attempt >= 8) throw new Error(`${language.code}: ${error.message}`);
    const retryDelay = Math.max(Number(error.retryAfter ?? 0) * 1_000, 1_500 * (2 ** Math.min(attempt, 5)));
    await new Promise(resolveDelay => setTimeout(resolveDelay, retryDelay));
    return translateBatch(entries, language, attempt + 1);
  }
}

function batches(entries, maximumLength = 3600) {
  const result = [];
  let current = [];
  let length = 0;
  for (const entry of entries) {
    const nextLength = protect(entry.value).protectedText.length + 22;
    if (current.length && length + nextLength > maximumLength) {
      result.push(current);
      current = [];
      length = 0;
    }
    current.push(entry);
    length += nextLength;
  }
  if (current.length) result.push(current);
  return result;
}

async function translateObject(name, template, language) {
  await mkdir(cacheRoot, { recursive: true });
  const cachePath = resolve(cacheRoot, `${name}-${language.code}.json`);
  const entries = flatten(template);
  let cachedTranslations = [];
  try {
    const cached = JSON.parse(await readFile(cachePath, "utf8"));
    if (cached.sourceCount === entries.length && cached.value) return cached.value;
    if (cached.sourceCount === entries.length && Array.isArray(cached.translations)) cachedTranslations = cached.translations;
  } catch { /* Generate the missing cache. */ }
  const map = new Map(cachedTranslations.map(entry => [JSON.stringify(entry.path), entry.value]));
  const pending = entries.filter(entry => !map.has(JSON.stringify(entry.path)));
  const maximumBatchLength = language.code === "fil" ? 1 : 2_400;
  for (const batch of batches(pending, maximumBatchLength)) {
    const translated = language.code === "fil" && batch.length === 1
      ? [await translateSingleFallback(batch[0], language)]
      : await translateBatch(batch, language);
    for (const entry of translated) map.set(JSON.stringify(entry.path), entry.value);
    const translations = [...map].map(([path, value]) => ({ path: JSON.parse(path), value }));
    await writeFile(cachePath, `${JSON.stringify({ sourceCount: entries.length, translations }, null, 2)}\n`);
    await new Promise(resolveDelay => setTimeout(resolveDelay, language.code === "fil" ? 100 : 900));
  }
  const value = rebuild(template, map);
  await writeFile(cachePath, `${JSON.stringify({ sourceCount: entries.length, value }, null, 2)}\n`);
  return value;
}

async function mapWithConcurrency(items, concurrency, callback) {
  const results = new Array(items.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await callback(items[index], index);
    }
  }));
  return results;
}

function typescriptExport(name, value) {
  return `// Generated by scripts/generate-product-locales.mjs. Do not edit by hand.\nexport const ${name} = ${JSON.stringify(value, null, 2)} as const;\n`;
}

async function writeGenerated(path, content) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
  console.log(`wrote ${path.slice(root.length + 1)}`);
}

const metadata = Object.fromEntries(localeConfig.map(({ code, tag, route, nativeName, direction }) => [code, { tag, route, nativeName, direction }]));

if (targets.has("website")) {
  const contentModule = await import(`${pathToFileURL(resolve(root, "website/src/content.js")).href}?generation=${Date.now()}`);
  const translations = await mapWithConcurrency(generatedLocales, Number(process.env.MFW_TRANSLATION_CONCURRENCY ?? 1), async language => [language.code, { ...(await translateObject("website", contentModule.copy.en, language)), lang: language.code }]);
  await writeGenerated(resolve(root, "website/src/locales.generated.js"), `// Generated by scripts/generate-product-locales.mjs. Do not edit by hand.\nexport const localeMetadata = ${JSON.stringify(metadata, null, 2)};\nexport const generatedWebsiteCopy = ${JSON.stringify(Object.fromEntries(translations), null, 2)};\n`);
}

if (targets.has("mobile")) {
  const source = await readFile(resolve(root, "apps/mobile/src/i18n/translations.ts"), "utf8");
  const english = readObject(source, "const en =");
  const translations = await mapWithConcurrency(generatedLocales, Number(process.env.MFW_TRANSLATION_CONCURRENCY ?? 1), async language => [language.code, await translateObject("mobile", english, language)]);
  await writeGenerated(resolve(root, "apps/mobile/src/i18n/translations.generated.ts"), `${typescriptExport("generatedTranslations", Object.fromEntries(translations))}\n${typescriptExport("generatedLocaleMetadata", metadata)}`);
}

if (targets.has("desktop")) {
  const source = await readFile(resolve(root, "apps/desktop/src/i18n.tsx"), "utf8");
  const english = readObject(source, "const messages =", "en:");
  const translations = await mapWithConcurrency(generatedLocales, Number(process.env.MFW_TRANSLATION_CONCURRENCY ?? 1), async language => [language.code, await translateObject("desktop", english, language)]);
  await writeGenerated(resolve(root, "apps/desktop/src/i18n.generated.ts"), `${typescriptExport("generatedMessages", Object.fromEntries(translations))}\n${typescriptExport("generatedLocaleMetadata", metadata)}`);
}
