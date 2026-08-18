import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { applyManualTranslationOverrides } from "../packages/wallet-shared/src/manualTranslationOverrides.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const localeConfig = JSON.parse(await readFile(resolve(root, "config/product-locales.json"), "utf8"));
const generatedLocales = localeConfig.filter(({ code }) => !["en", "de"].includes(code));
const cacheRoot = resolve(root, "build/localization-cache-v1");
const targets = new Set(process.argv.slice(2).length ? process.argv.slice(2) : ["website", "mobile", "desktop"]);
const localTranslationEndpoint = process.env.MFW_TRANSLATION_ENDPOINT?.replace(/\/$/, "");
const exportInputDirectory = process.env.MFW_EXPORT_TRANSLATION_INPUT_DIR;
const importOutputDirectory = process.env.MFW_IMPORT_TRANSLATION_OUTPUT_DIR;

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
  "LEDGER",
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
].sort((left, right) => right.length - left.length);

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
    const token = `<x${replacements.length}/>`;
    replacements.push([token, value]);
    return token;
  });
  for (const term of protectedTerms) {
    const escapedTerm = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    protectedText = protectedText.replace(new RegExp(`(?<![A-Za-z0-9])${escapedTerm}(?![A-Za-z0-9])`, "gi"), match => {
      const token = `<x${replacements.length}/>`;
      replacements.push([token, match]);
      return token;
    });
  }
  return { protectedText, replacements };
}

function restore(text, replacements) {
  let restored = text.trim();
  for (const [index, [, value]] of replacements.entries()) {
    const pattern = new RegExp(`<\\s*x\\s*${index}\\s*\\/\\s*>`, "gi");
    const matches = restored.match(pattern)?.length ?? 0;
    if (matches !== 1) throw new Error(`Protected token <x${index}/> was returned ${matches} times`);
    restored = restored.replace(pattern, value);
  }
  return restored.replace(/\s+([,.;:!?])/g, "$1");
}

function responseText(payload) {
  if (!Array.isArray(payload?.[0])) throw new Error("Unexpected translation response");
  return payload[0].map(segment => segment?.[0] ?? "").join("");
}

async function translateBatch(entries, language, attempt = 0) {
  const prepared = entries.map((entry, index) => ({ ...entry, ...protect(entry.value), marker: `[[MFWITEM${String(index).padStart(4, "0")}]]` }));
  if (localTranslationEndpoint) {
    try {
      const response = await fetch(`${localTranslationEndpoint}/translate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ texts: prepared.map(entry => entry.protectedText), target: language.code }),
        signal: AbortSignal.timeout(300_000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${(await response.text()).slice(0, 180)}`);
      const payload = await response.json();
      if (!Array.isArray(payload.translations) || payload.translations.length !== prepared.length) throw new Error("Unexpected local translation response");
      return prepared.map((entry, index) => ({ path: entry.path, value: restore(payload.translations[index], entry.replacements) }));
    } catch (error) {
      if (attempt >= 4) throw new Error(`${language.code} local translator: ${error.message}`);
      await new Promise(resolveDelay => setTimeout(resolveDelay, 2_000 * (attempt + 1)));
      return translateBatch(entries, language, attempt + 1);
    }
  }
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
    const pattern = /\[\[MFWITEM(\d{4})\]\]\s*([\s\S]*?)(?=\[\[MFWITEM\d{4}\]\]|$)/g;
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

function batches(entries, maximumLength = 3600, maximumItems = 32) {
  const result = [];
  let current = [];
  let length = 0;
  for (const entry of entries) {
    const nextLength = protect(entry.value).protectedText.length + 22;
    if (current.length && (length + nextLength > maximumLength || current.length >= maximumItems)) {
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
  const sourceHash = createHash("sha256").update(JSON.stringify(entries)).digest("hex");
  let cachedTranslations = [];
  try {
    const cached = JSON.parse(await readFile(cachePath, "utf8"));
    if (cached.sourceHash === sourceHash && cached.value) return cached.value;
    if (cached.sourceHash === sourceHash && Array.isArray(cached.translations)) cachedTranslations = cached.translations;
  } catch { /* Generate the missing cache. */ }
  const map = new Map(cachedTranslations.map(entry => [JSON.stringify(entry.path), entry.value]));
  const pending = entries.filter(entry => !map.has(JSON.stringify(entry.path)));
  for (const batch of batches(pending, 2_400)) {
    const translated = await translateBatch(batch, language);
    for (const entry of translated) map.set(JSON.stringify(entry.path), entry.value);
    const translations = [...map].map(([path, value]) => ({ path: JSON.parse(path), value }));
    await writeFile(cachePath, `${JSON.stringify({ sourceCount: entries.length, sourceHash, translations }, null, 2)}\n`);
    await new Promise(resolveDelay => setTimeout(resolveDelay, localTranslationEndpoint ? 10 : 900));
  }
  const value = rebuild(template, map);
  await writeFile(cachePath, `${JSON.stringify({ sourceCount: entries.length, sourceHash, value }, null, 2)}\n`);
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

function escapeAndroidXml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("'", "\\'");
}

async function writeMobileNativeLocales(catalogs) {
  const androidKeys = {
    "native.notification.transactions": "monero_transaction_channel_name",
    "native.notification.transactionsDescription": "monero_transaction_channel_description",
    "native.notification.sync": "monero_sync_channel_name",
    "native.notification.syncDescription": "monero_sync_channel_description",
    "native.notification.syncTitle": "monero_sync_notification_title",
    "native.notification.syncBody": "monero_sync_notification_description",
  };
  const appleKeys = [
    ["native.permission.location", "NSLocationWhenInUseUsageDescription"],
    ["native.permission.bluetooth", "NSBluetoothAlwaysUsageDescription"],
    ["native.permission.bluetooth", "NSBluetoothPeripheralUsageDescription"],
    ["native.permission.camera", "NSCameraUsageDescription"],
    ["native.permission.faceId", "NSFaceIDUsageDescription"],
  ];
  const effectiveCatalogs = Object.fromEntries(localeConfig.map(locale => [
    locale.code,
    ["en", "de"].includes(locale.code)
      ? catalogs[locale.code]
      : applyManualTranslationOverrides(locale.code, catalogs.en, catalogs[locale.code]),
  ]));
  const appleCatalog = Object.fromEntries(
    appleKeys.map(([, name]) => [name, {
      localizations: Object.fromEntries(localeConfig.map(locale => [locale.tag, {
        stringUnit: {
          state: "translated",
          value: effectiveCatalogs[locale.code][appleKeys.find(([, appleName]) => appleName === name)[0]],
        },
      }])),
    }]),
  );
  for (const locale of localeConfig) {
    const catalog = effectiveCatalogs[locale.code];
    if (!catalog) throw new Error(`mobile native locales: missing ${locale.code}`);
    const androidLocale = locale.code === "pt-BR" ? "pt-rBR" : locale.code === "zh-CN" ? "zh-rCN" : locale.code === "zh-TW" ? "zh-rTW" : locale.code;
    const android = `<resources>\n    <string name="app_name">Monero Fast Wallet</string>\n${Object.entries(androidKeys).map(([key, name]) => `    <string name="${name}">${escapeAndroidXml(catalog[key])}</string>`).join("\n")}\n</resources>\n`;
    const androidDirectory = resolve(root, "apps/mobile/android/app/src/main/res", locale.code === "en" ? "values" : `values-${androidLocale}`);
    await mkdir(androidDirectory, { recursive: true });
    await writeFile(resolve(androidDirectory, "strings.xml"), android);
  }
  await writeFile(
    resolve(root, "apps/mobile/ios/MoneroWallet/InfoPlist.xcstrings"),
    `${JSON.stringify({ sourceLanguage: "en", strings: appleCatalog, version: "1.0" }, null, 2)}\n`,
  );
}

async function writeGenerated(path, content) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
  console.log(`wrote ${path.slice(root.length + 1)}`);
}

async function writeLazyRuntimeCatalogs(target, source, generated) {
  const directory = target === "mobile"
    ? resolve(root, "apps/mobile/src/i18n/lazy")
    : resolve(root, "apps/desktop/src/i18n.lazy");
  const loaderPath = target === "mobile"
    ? resolve(root, "apps/mobile/src/i18n/lazy.generated.ts")
    : resolve(root, "apps/desktop/src/i18n.lazy.generated.ts");
  const importPrefix = target === "mobile" ? "./lazy" : "./i18n.lazy";
  await mkdir(directory, { recursive: true });

  for (const locale of generatedLocales) {
    const reviewed = applyManualTranslationOverrides(
      locale.code,
      source,
      generated[locale.code] ?? {},
    );
    await writeGenerated(
      resolve(directory, `${locale.code}.generated.ts`),
      `// Generated by scripts/generate-product-locales.mjs. Do not edit by hand.\nconst createCatalog = () => (${JSON.stringify(reviewed, null, 2)} as Record<string, string>);\nexport default createCatalog;\n`,
    );
  }

  const loaders = generatedLocales
    .map(({ code }) => `  ${JSON.stringify(code)}: () => import(${JSON.stringify(`${importPrefix}/${code}.generated`)}).then(({ default: createCatalog }) => createCatalog()),`)
    .join("\n");
  await writeGenerated(
    loaderPath,
    `// Generated by scripts/generate-product-locales.mjs. Do not edit by hand.\nexport type GeneratedRuntimeCatalog = Record<string, string>;\nexport const generatedRuntimeCatalogLoaders = {\n${loaders}\n} as const;\n`,
  );
}

const metadata = Object.fromEntries(localeConfig.map(({ code, tag, route, nativeName, direction }) => [code, { tag, route, nativeName, direction }]));

async function sourceCatalog(target) {
  const sourcePath = target === "mobile"
    ? resolve(root, "apps/mobile/src/i18n/translations.ts")
    : resolve(root, "apps/desktop/src/i18n.tsx");
  const source = await readFile(sourcePath, "utf8");
  const english = target === "mobile"
    ? readObject(source, "const en =")
    : readObject(source, "const baseMessages =", "en:");
  const german = target === "mobile"
    ? readObject(source, "const de:")
    : readObject(source, "const baseMessages =", "de:");
  validateBaseCatalog(target, english, german);
  return english;
}

function variables(value) {
  return [...value.matchAll(/\{[A-Za-z0-9_]+\}/g)].map(match => match[0]).sort();
}

function occurrences(value, term) {
  return value.split(term).length - 1;
}

function validateBaseCatalog(target, english, german) {
  const expectedKeys = Object.keys(english).sort();
  const germanKeys = Object.keys(german).sort();
  if (JSON.stringify(germanKeys) !== JSON.stringify(expectedKeys)) throw new Error(`${target}/de: key set does not match English`);
  for (const key of expectedKeys) {
    if (typeof english[key] !== "string" || !english[key].trim()) throw new Error(`${target}/en/${key}: empty source text`);
    if (typeof german[key] !== "string" || !german[key].trim()) throw new Error(`${target}/de/${key}: empty translation`);
    if (JSON.stringify(variables(german[key])) !== JSON.stringify(variables(english[key]))) throw new Error(`${target}/de/${key}: placeholder mismatch`);
  }
}

function validateImportedCatalog(target, source, imported) {
  const expectedKeys = Object.keys(source).sort();
  for (const language of generatedLocales) {
    const catalog = imported[language.code];
    if (!catalog || typeof catalog !== "object") throw new Error(`${target}: missing ${language.code} catalog`);
    const actualKeys = Object.keys(catalog).sort();
    if (JSON.stringify(actualKeys) !== JSON.stringify(expectedKeys)) throw new Error(`${target}/${language.code}: key set does not match English`);
    for (const key of expectedKeys) {
      if (typeof catalog[key] !== "string" || !catalog[key].trim()) throw new Error(`${target}/${language.code}/${key}: empty translation`);
      const expectedVariables = variables(source[key]);
      const actualVariables = variables(catalog[key]);
      if (JSON.stringify(actualVariables) !== JSON.stringify(expectedVariables)) throw new Error(`${target}/${language.code}/${key}: placeholder mismatch`);
      for (const term of protectedTerms) {
        if (occurrences(catalog[key], term) !== occurrences(source[key], term)) throw new Error(`${target}/${language.code}/${key}: protected term mismatch for ${term}`);
      }
    }
  }
}

if (exportInputDirectory) {
  const outputDirectory = resolve(exportInputDirectory);
  await mkdir(outputDirectory, { recursive: true });
  for (const target of ["mobile", "desktop"]) {
    if (!targets.has(target)) continue;
    await writeFile(resolve(outputDirectory, `${target}.json`), `${JSON.stringify(await sourceCatalog(target), null, 2)}\n`);
    console.log(`wrote ${resolve(outputDirectory, `${target}.json`)}`);
  }
  process.exit(0);
}

if (importOutputDirectory) {
  const inputDirectory = resolve(importOutputDirectory);
  const mobileCatalogs = {};
  for (const target of ["mobile", "desktop"]) {
    if (!targets.has(target)) continue;
    const source = await sourceCatalog(target);
    const imported = JSON.parse(await readFile(resolve(inputDirectory, `${target}.json`), "utf8"));
    validateImportedCatalog(target, source, imported);
    const path = target === "mobile"
      ? resolve(root, "apps/mobile/src/i18n/translations.generated.ts")
      : resolve(root, "apps/desktop/src/i18n.generated.ts");
    const exportName = target === "mobile" ? "generatedTranslations" : "generatedMessages";
    await writeGenerated(path, `${typescriptExport(exportName, imported)}\n${typescriptExport("generatedLocaleMetadata", metadata)}`);
    await writeLazyRuntimeCatalogs(target, source, imported);
    if (target === "mobile") Object.assign(mobileCatalogs, imported);
  }
  if (targets.has("mobile")) {
    const mobileSource = await sourceCatalog("mobile");
    const sourceText = await readFile(resolve(root, "apps/mobile/src/i18n/translations.ts"), "utf8");
    const german = readObject(sourceText, "const de:");
    await writeMobileNativeLocales({ en: mobileSource, de: german, ...mobileCatalogs });
  }
  process.exit(0);
}

if (targets.has("lazy-existing")) {
  for (const target of ["mobile", "desktop"]) {
    const source = await sourceCatalog(target);
    const generatedPath = target === "mobile"
      ? resolve(root, "apps/mobile/src/i18n/translations.generated.ts")
      : resolve(root, "apps/desktop/src/i18n.generated.ts");
    const marker = target === "mobile"
      ? "export const generatedTranslations ="
      : "export const generatedMessages =";
    const generated = readObject(await readFile(generatedPath, "utf8"), marker);
    await writeLazyRuntimeCatalogs(target, source, generated);
  }
  process.exit(0);
}

if (targets.has("native-existing")) {
  const sourceText = await readFile(resolve(root, "apps/mobile/src/i18n/translations.ts"), "utf8");
  const generatedText = await readFile(resolve(root, "apps/mobile/src/i18n/translations.generated.ts"), "utf8");
  const english = readObject(sourceText, "const en =");
  const german = readObject(sourceText, "const de:");
  const generated = readObject(generatedText, "export const generatedTranslations =");
  validateImportedCatalog("mobile", english, generated);
  await writeMobileNativeLocales({ en: english, de: german, ...generated });
  console.log("wrote existing reviewed mobile catalogs to Android and iOS native resources");
  process.exit(0);
}

if (targets.has("website")) {
  const contentModule = await import(`${pathToFileURL(resolve(root, "website/src/content.js")).href}?generation=${Date.now()}`);
  const translations = await mapWithConcurrency(generatedLocales, Number(process.env.MFW_TRANSLATION_CONCURRENCY ?? 1), async language => [language.code, { ...(await translateObject("website", contentModule.copy.en, language)), lang: language.code }]);
  await writeGenerated(resolve(root, "website/src/locales.generated.js"), `// Generated by scripts/generate-product-locales.mjs. Do not edit by hand.\nexport const localeMetadata = ${JSON.stringify(metadata, null, 2)};\nexport const generatedWebsiteCopy = ${JSON.stringify(Object.fromEntries(translations), null, 2)};\n`);
}

if (targets.has("mobile")) {
  const english = await sourceCatalog("mobile");
  const translations = await mapWithConcurrency(generatedLocales, Number(process.env.MFW_TRANSLATION_CONCURRENCY ?? 1), async language => [language.code, await translateObject("mobile", english, language)]);
  const generated = Object.fromEntries(translations);
  await writeGenerated(resolve(root, "apps/mobile/src/i18n/translations.generated.ts"), `${typescriptExport("generatedTranslations", generated)}\n${typescriptExport("generatedLocaleMetadata", metadata)}`);
  await writeLazyRuntimeCatalogs("mobile", english, generated);
  const sourceText = await readFile(resolve(root, "apps/mobile/src/i18n/translations.ts"), "utf8");
  const german = readObject(sourceText, "const de:");
  await writeMobileNativeLocales({ en: english, de: german, ...generated });
}

if (targets.has("desktop")) {
  const english = await sourceCatalog("desktop");
  const translations = await mapWithConcurrency(generatedLocales, Number(process.env.MFW_TRANSLATION_CONCURRENCY ?? 1), async language => [language.code, await translateObject("desktop", english, language)]);
  const generated = Object.fromEntries(translations);
  await writeGenerated(resolve(root, "apps/desktop/src/i18n.generated.ts"), `${typescriptExport("generatedMessages", generated)}\n${typescriptExport("generatedLocaleMetadata", metadata)}`);
  await writeLazyRuntimeCatalogs("desktop", english, generated);
}
