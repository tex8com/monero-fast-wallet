import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { matchProductLanguage, productLocales } from '../config/productLocales.ts';
import {
  applyManualTranslationOverrides,
  hasDuplicatedAdjacentWord,
  isGeneratedTranslationCriticallyUnsafe,
  isGeneratedTranslationSafe,
  manualTranslationOverrides,
} from '../packages/wallet-shared/src/manualTranslationOverrides.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const locales = JSON.parse(await readFile(resolve(root, 'config/product-locales.json'), 'utf8'));
const generatedLocales = locales.filter(({ code }) => !['en', 'de'].includes(code));
const protectedTerms = [
  'Monero Fast Wallet', 'Monero Fast Node', 'Monero Enthusiast', 'Fast Wallet',
  'React Native', 'Tauri 2', 'AppVault', 'ScanPack', 'Cuprate', 'LEDGER', 'Ledger',
  'Matrix', 'Mainnet', 'Monero', 'GitHub', 'Android', 'iOS', 'macOS',
  'Windows', 'Linux', 'CUDA', 'Metal', 'NEON', 'XMR', 'MFN',
  'Open Source Initiative',
];

function findMatchingBrace(source, openIndex) {
  let depth = 0;
  let quote = null;
  let escaped = false;
  for (let index = openIndex; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === "'" || character === '"' || character === '`') {
      quote = character;
      continue;
    }
    if (character === '{') depth += 1;
    if (character === '}' && --depth === 0) return index;
  }
  throw new Error(`Unclosed object beginning at ${openIndex}`);
}

function readObject(source, marker, nestedKey) {
  const markerIndex = source.indexOf(marker);
  assert.notEqual(markerIndex, -1, `Missing marker: ${marker}`);
  const keyIndex = nestedKey ? source.indexOf(nestedKey, markerIndex + marker.length) : markerIndex;
  assert.notEqual(keyIndex, -1, `Missing nested marker: ${nestedKey}`);
  const openIndex = source.indexOf('{', keyIndex + (nestedKey?.length ?? marker.length));
  const closeIndex = findMatchingBrace(source, openIndex);
  return Function(`"use strict"; return (${source.slice(openIndex, closeIndex + 1)});`)();
}

function variables(value) {
  return [...value.matchAll(/\{[A-Za-z0-9_]+\}/g)].map(match => match[0]).sort();
}

function occurrences(value, term) {
  return value.split(term).length - 1;
}

function escapeAndroidXml(value) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll("'", "\\'");
}

function verifyTranslationQuality(target, language, key, source, value) {
  const label = `${target}/${language}/${key}`;
  const shortUiText = source.length <= 20 && !/[.!?]\s*$/.test(source);
  if (shortUiText) {
    const maximumLength = Math.max(18, source.length * 3);
    assert.ok(value.length <= maximumLength, `${label}: short UI translation is implausibly long`);
  }
  assert.doesNotMatch(value, /<\s*\/?\s*x?\d*\s*\/?>|&(?:quot|amp|lt|gt);/iu, `${label}: leaked markup`);
  assert.equal(hasDuplicatedAdjacentWord(value), false, `${label}: duplicated adjacent word`);
  if (!/\d/.test(source)) assert.doesNotMatch(value, /\d/, `${label}: translation invented a number`);
}

async function catalogs(target) {
  const sourcePath = resolve(root, target === 'mobile' ? 'apps/mobile/src/i18n/translations.ts' : 'apps/desktop/src/i18n.tsx');
  const generatedPath = resolve(root, target === 'mobile' ? 'apps/mobile/src/i18n/translations.generated.ts' : 'apps/desktop/src/i18n.generated.ts');
  const source = await readFile(sourcePath, 'utf8');
  const generated = await readFile(generatedPath, 'utf8');
  return {
    en: target === 'mobile' ? readObject(source, 'const en =') : readObject(source, 'const baseMessages =', 'en:'),
    de: target === 'mobile' ? readObject(source, 'const de:') : readObject(source, 'const baseMessages =', 'de:'),
    generated: readObject(generated, target === 'mobile' ? 'export const generatedTranslations =' : 'export const generatedMessages ='),
  };
}

function verifyCatalog(target, language, source, catalog) {
  const expectedKeys = Object.keys(source).sort();
  assert.deepEqual(Object.keys(catalog ?? {}).sort(), expectedKeys, `${target}/${language}: key set differs from English`);
  for (const key of expectedKeys) {
    const value = catalog[key];
    assert.equal(typeof value, 'string', `${target}/${language}/${key}: translation is not text`);
    assert.ok(value.trim(), `${target}/${language}/${key}: translation is empty`);
    if (language !== 'de') verifyTranslationQuality(target, language, key, source[key], value);
    assert.deepEqual(variables(value), variables(source[key]), `${target}/${language}/${key}: placeholder mismatch`);
    for (const term of protectedTerms) {
      assert.equal(occurrences(value, term), occurrences(source[key], term), `${target}/${language}/${key}: protected term ${term} changed`);
    }
  }
}

for (const target of ['mobile', 'desktop']) {
  test(`${target} contains complete catalogs for every product language`, async () => {
    const result = await catalogs(target);
    verifyCatalog(target, 'de', result.en, result.de);
    assert.deepEqual(Object.keys(result.generated).sort(), generatedLocales.map(({ code }) => code).sort());
    for (const locale of generatedLocales) {
      for (const [key, source] of Object.entries(result.en)) {
        if (!isGeneratedTranslationCriticallyUnsafe(source, result.generated[locale.code][key])) continue;
        assert.ok(
          manualTranslationOverrides[locale.code]?.[source],
          `${target}/${locale.code}/${key}: unsafe generated text must have a manual translation`,
        );
      }
      const reviewed = applyManualTranslationOverrides(locale.code, result.en, result.generated[locale.code]);
      verifyCatalog(target, locale.code, result.en, reviewed);
    }
  });
}

test('mobile native resources contain every product language', async () => {
  const mobile = await catalogs('mobile');
  const effectiveCatalogs = {
    en: mobile.en,
    de: mobile.de,
    ...Object.fromEntries(generatedLocales.map(locale => [
      locale.code,
      applyManualTranslationOverrides(locale.code, mobile.en, mobile.generated[locale.code]),
    ])),
  };
  const androidResources = {
    app_name: null,
    monero_transaction_channel_name: 'native.notification.transactions',
    monero_transaction_channel_description: 'native.notification.transactionsDescription',
    monero_sync_channel_name: 'native.notification.sync',
    monero_sync_channel_description: 'native.notification.syncDescription',
    monero_sync_notification_title: 'native.notification.syncTitle',
    monero_sync_notification_description: 'native.notification.syncBody',
  };
  for (const locale of locales) {
    const qualifier = locale.code === 'en' ? ''
      : locale.code === 'pt-BR' ? '-pt-rBR'
        : locale.code === 'zh-CN' ? '-zh-rCN'
          : locale.code === 'zh-TW' ? '-zh-rTW' : `-${locale.code}`;
    const xml = await readFile(resolve(root, `apps/mobile/android/app/src/main/res/values${qualifier}/strings.xml`), 'utf8');
    for (const [name, catalogKey] of Object.entries(androidResources)) {
      const match = xml.match(new RegExp(`<string name="${name}">([^<]+)</string>`));
      assert.ok(match, `Android ${locale.code} misses ${name}`);
      const expected = catalogKey ? escapeAndroidXml(effectiveCatalogs[locale.code][catalogKey]) : 'Monero Fast Wallet';
      assert.equal(match[1], expected, `Android ${locale.code}/${name} differs from the reviewed app catalog`);
    }
  }

  const apple = JSON.parse(await readFile(resolve(root, 'apps/mobile/ios/MoneroWallet/InfoPlist.xcstrings'), 'utf8'));
  const appleKeys = {
    NSLocationWhenInUseUsageDescription: 'native.permission.location',
    NSBluetoothAlwaysUsageDescription: 'native.permission.bluetooth',
    NSBluetoothPeripheralUsageDescription: 'native.permission.bluetooth',
    NSCameraUsageDescription: 'native.permission.camera',
    NSFaceIDUsageDescription: 'native.permission.faceId',
  };
  for (const [key, catalogKey] of Object.entries(appleKeys)) {
    for (const locale of locales) {
      const unit = apple.strings?.[key]?.localizations?.[locale.tag]?.stringUnit;
      assert.equal(unit?.state, 'translated', `iOS ${locale.code} misses ${key}`);
      assert.ok(unit.value.trim(), `iOS ${locale.code}/${key} is empty`);
      assert.equal(unit.value, effectiveCatalogs[locale.code][catalogKey], `iOS ${locale.code}/${key} differs from the reviewed app catalog`);
    }
  }
});

test('Urdu and Arabic remain right-to-left languages', () => {
  assert.equal(locales.find(({ code }) => code === 'ur')?.direction, 'rtl');
  assert.equal(locales.find(({ code }) => code === 'ar')?.direction, 'rtl');
});

test('website and app locale metadata stay aligned', () => {
  assert.deepEqual(
    productLocales.map(({ code, tag, nativeName, direction }) => ({ code, tag, nativeName, direction })),
    locales.map(({ code, tag, nativeName, direction }) => ({ code, tag, nativeName, direction })),
  );
});

test('device locales select the same product language in both apps', () => {
  assert.equal(matchProductLanguage('de_AT'), 'de');
  assert.equal(matchProductLanguage('pt-PT'), 'pt-BR');
  assert.equal(matchProductLanguage('tl-PH'), 'fil');
  assert.equal(matchProductLanguage('zh-Hant-HK'), 'zh-TW');
  assert.equal(matchProductLanguage('zh-Hans-SG'), 'zh-CN');
  assert.equal(matchProductLanguage('ar-AE'), 'ar');
  assert.equal(matchProductLanguage('unlisted-language'), 'en');
});
