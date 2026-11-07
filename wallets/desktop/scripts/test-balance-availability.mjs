import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';
import { presentBalanceAvailability } from '../../../packages/wallet-shared/src/balanceAvailability.ts';

const appText = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
const app = ts.createSourceFile('App.tsx', appText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const names = ['DesktopBalanceAvailability', 'formatAtomicXmr', 'atomicValue', 'formatSyncBlockCount'];
const functions = names.map(name => {
  const declaration = app.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
  assert.ok(declaration, `missing production function ${name}`);
  return declaration.getText(app);
}).join('\n');
const compiled = ts.transpileModule(functions, { compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React } }).outputText;
const catalogText = readFileSync(new URL('../src/i18n.tsx', import.meta.url), 'utf8');
const catalogSource = ts.createSourceFile('i18n.tsx', catalogText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const declaration = catalogSource.statements.flatMap(node => ts.isVariableStatement(node) ? [...node.declarationList.declarations] : []).find(node => node.name.getText(catalogSource) === 'baseMessages');
assert.ok(declaration);
const initializer = declaration.initializer;
const catalogs = new Function(`return (${ts.isAsExpression(initializer) ? initializer.expression.getText(catalogSource) : initializer.getText(catalogSource)});`)();
function render(snapshot, { provisional = false, hideBreakdown = false, live = true, language = 'en' } = {}) {
  const t = (key, params = {}) => {
    assert.ok(catalogs[language][key], `missing translation ${language}:${key}`);
    return catalogs[language][key].replace(/\{(\w+)\}/g, (_, name) => String(params[name] ?? `{${name}}`));
  };
  const scope = { React, ATOMIC_XMR: 1_000_000_000_000n, presentBalanceAvailability, useI18n: () => ({ t, dateLocale: language === 'de' ? 'de-DE' : 'en-US' }) };
  const production = new Function(...Object.keys(scope), `${compiled}\nreturn DesktopBalanceAvailability;`)(...Object.values(scope));
  return renderToStaticMarkup(production({ snapshot, provisional, hideBreakdown, live }));
}
const snapshot = (extra = {}) => ({ balanceAtomic: '1191306869968', unlockedBalanceAtomic: '468911040000', lockedBalanceAtomic: '722395829968', unlockState: 'blocks', unlockBlocksRemaining: 9, unlockTimeRemainingSeconds: 0, ...extra });

test('desktop Home shows exact available and locked amounts with the canonical full-release block count', () => {
  const markup = render(snapshot());
  assert.match(markup, /Available to send/);
  assert.match(markup, /0\.46891104 XMR/);
  assert.match(markup, /0\.722395829968 XMR/);
  assert.match(markup, /9 blocks until the full balance is available/);
  const german = render(snapshot({ unlockBlocksRemaining: 2_345 }), { language: 'de' });
  assert.match(german, /Zum Senden verfügbar/);
  assert.match(german, /Noch 2\.345 Blöcke/);
});

test('pending and timestamp locks never claim zero blocks or full availability', () => {
  const pending = render(snapshot({ unlockState: 'pending', unlockBlocksRemaining: 0 }));
  assert.match(pending, /Waiting for confirmation/);
  assert.doesNotMatch(pending, /0 blocks|Fully available/);
  const timed = render(snapshot({ unlockState: 'timestamp', unlockBlocksRemaining: 0, unlockTimeRemainingSeconds: 600 }));
  assert.match(timed, /A time lock is active/);
  assert.doesNotMatch(timed, /0 blocks|Fully available/);
  const mixed = render(snapshot({ unlockState: 'mixed', unlockTimeRemainingSeconds: 600 }));
  assert.match(mixed, /9 blocks and an active time lock/);
});

test('legacy or contradictory unlock metadata remains explicitly unverified', () => {
  for (const input of [
    snapshot({ unlockState: undefined, unlockBlocksRemaining: undefined }),
    snapshot({ lockedBalanceAtomic: '1' }),
    snapshot({ unlockBlocksRemaining: 0 }),
    snapshot({ unlockBlocksRemaining: Number.NaN }),
  ]) {
    const markup = render(input);
    assert.match(markup, /0\.46891104 XMR/);
    assert.match(markup, /remaining lock duration has not been verified/);
    assert.doesNotMatch(markup, /0 blocks|Fully available/);
  }
});

test('malformed or absent financial data is unknown rather than a fabricated zero', () => {
  for (const input of [undefined, snapshot({ balanceAtomic: '-1' }), snapshot({ unlockedBalanceAtomic: 'invalid' }), snapshot({ unlockedBalanceAtomic: '1191306869969' })]) {
    const markup = render(input);
    assert.equal((markup.match(/— XMR/g) ?? []).length, 2);
    assert.doesNotMatch(markup, />0 XMR|Fully available/);
  }
});

test('a provisional Ledger balance retains native amounts and maturity without claiming verified spending authority', () => {
  const markup = render(snapshot(), { provisional: true });
  assert.match(markup, /Available · provisional/);
  assert.match(markup, /Locked · provisional/);
  assert.match(markup, /0\.46891104 XMR/);
  assert.match(markup, /0\.722395829968 XMR/);
  assert.match(markup, /9 blocks until the detected locked funds mature/);
  assert.match(markup, /Provisional balance/);
  assert.doesNotMatch(markup, /class="available"|Fully available|full balance is available/);
});

test('retained publications keep their amounts but never reuse an old maturity countdown', () => {
  for (const provisional of [false, true]) {
    const markup = render(snapshot(), { provisional, live: false });
    assert.match(markup, /0\.46891104 XMR/);
    assert.match(markup, /0\.722395829968 XMR/);
    assert.match(markup, /remaining lock duration has not been verified/);
    assert.doesNotMatch(markup, /9 blocks|Fully available/);
  }
});

test('a viewing fallback or retained verified balance exposes no spendable breakdown', () => {
  const provisional = render(snapshot(), { provisional: true, hideBreakdown: true, language: 'de' });
  assert.match(provisional, /Ledger muss noch prüfen/);
  const verified = render(snapshot(), { hideBreakdown: true });
  assert.match(verified, /Shown until the current Ledger check is complete/);
  for (const markup of [provisional, verified]) assert.doesNotMatch(markup, /<dl>|XMR|9 blocks/);
});

test('one atomic unit, zero balance and maximum native amounts retain exact precision', () => {
  const single = render(snapshot({ balanceAtomic: '1', unlockedBalanceAtomic: '0', lockedBalanceAtomic: '1', unlockBlocksRemaining: 1 }));
  assert.match(single, /0\.000000000001 XMR/);
  const zero = render(snapshot({ balanceAtomic: '0', unlockedBalanceAtomic: '0', lockedBalanceAtomic: '0', unlockState: 'unlocked', unlockBlocksRemaining: 0 }));
  assert.equal((zero.match(/>0 XMR/g) ?? []).length, 2);
  assert.match(zero, /Fully available/);
  const maximum = render(snapshot({ balanceAtomic: '18446744073709551615', unlockedBalanceAtomic: '18446744073709551615', lockedBalanceAtomic: '0', unlockState: 'unlocked' }));
  assert.match(maximum, /18446744\.073709551615 XMR/);
});
