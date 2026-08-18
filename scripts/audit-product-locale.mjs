import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hasDuplicatedAdjacentWord, manualTranslationOverrides } from '../packages/wallet-shared/src/manualTranslationOverrides.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const locale = process.argv[2];
const limitArgument = process.argv.find(argument => argument.startsWith('--limit='));
const limit = Number(limitArgument?.split('=')[1] ?? 250);

assert.ok(locale, 'Usage: node scripts/audit-product-locale.mjs <locale> [--limit=250]');

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

async function readCatalogs(target) {
  const sourcePath = resolve(root, target === 'mobile' ? 'wallets/mobile/src/i18n/translations.ts' : 'wallets/desktop/src/i18n.tsx');
  const generatedPath = resolve(root, target === 'mobile' ? 'wallets/mobile/src/i18n/translations.generated.ts' : 'wallets/desktop/src/i18n.generated.ts');
  const sourceText = await readFile(sourcePath, 'utf8');
  const generatedText = await readFile(generatedPath, 'utf8');
  const english = target === 'mobile'
    ? readObject(sourceText, 'const en =')
    : readObject(sourceText, 'const baseMessages =', 'en:');
  const generated = readObject(
    generatedText,
    target === 'mobile' ? 'export const generatedTranslations =' : 'export const generatedMessages =',
  );
  assert.ok(generated[locale], `No generated ${target} catalog for ${locale}`);
  const overrides = manualTranslationOverrides[locale] ?? {};
  const translated = Object.fromEntries(
    Object.entries(english).map(([key, source]) => [key, overrides[source] ?? generated[locale][key]]),
  );
  return { english, translated };
}

function reasons(source, translated) {
  const result = [];
  const sourceLength = [...source].length;
  const translatedLength = [...translated].length;
  const ratio = sourceLength === 0 ? 0 : translatedLength / sourceLength;
  if (ratio > 1.8 && translatedLength - sourceLength > 8) result.push(`length ${ratio.toFixed(2)}x`);
  if (/<\s*\/?\s*x?\d*\s*\/?>|&(?:quot|amp|lt|gt);/iu.test(translated)) result.push('markup');
  if (hasDuplicatedAdjacentWord(translated)) result.push('duplicate word');
  if (!/\d/.test(source) && /\d/.test(translated)) result.push('invented number');
  if (source.length <= 20 && !/[.!?]\s*$/.test(source) && translated.length > Math.max(18, source.length * 3)) {
    result.push('oversized short UI');
  }
  return result;
}

const findings = [];
for (const target of ['mobile', 'desktop']) {
  const { english, translated } = await readCatalogs(target);
  for (const [key, source] of Object.entries(english)) {
    const value = translated[key];
    const issueReasons = reasons(source, value);
    if (issueReasons.length) findings.push({ target, key, source, value, reasons: issueReasons });
  }
}

const unique = [];
const seen = new Set();
for (const finding of findings) {
  const fingerprint = `${finding.source}\u0000${finding.value}`;
  if (seen.has(fingerprint)) continue;
  seen.add(fingerprint);
  unique.push(finding);
}

unique.sort((left, right) => {
  const leftRatio = [...left.value].length / Math.max(1, [...left.source].length);
  const rightRatio = [...right.value].length / Math.max(1, [...right.source].length);
  return rightRatio - leftRatio || left.source.localeCompare(right.source);
});

console.log(`${locale}: ${unique.length} suspicious unique translations (${findings.length} catalog entries)`);
for (const finding of unique.slice(0, limit)) {
  console.log(`\n[${finding.target}] ${finding.key} · ${finding.reasons.join(', ')}`);
  console.log(`EN: ${finding.source}`);
  console.log(`${locale}: ${finding.value}`);
}
if (unique.length > limit) console.log(`\n... ${unique.length - limit} more (increase --limit)`);
