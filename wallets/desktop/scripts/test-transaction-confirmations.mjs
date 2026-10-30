import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';
import { transactionConfirmationProgress } from '../../../packages/wallet-shared/src/transactionConfirmations.ts';

const appText = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
const app = ts.createSourceFile('App.tsx', appText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const names = ['transactionIdentity', 'transactionListStatus', 'RecentTransactions', 'Activity'];
const functions = names.map(name => {
  const declaration = app.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
  assert.ok(declaration, `missing production function ${name}`);
  return declaration.getText(app);
}).join('\n');
const compiled = ts.transpileModule(functions, { compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React } }).outputText;
const catalogText = readFileSync(new URL('../src/i18n.tsx', import.meta.url), 'utf8');
const catalogSource = ts.createSourceFile('i18n.tsx', catalogText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const catalogDeclaration = catalogSource.statements.flatMap(node => ts.isVariableStatement(node) ? [...node.declarationList.declarations] : []).find(node => node.name.getText(catalogSource) === 'baseMessages');
assert.ok(catalogDeclaration);
const initializer = catalogDeclaration.initializer;
const catalogs = new Function(`return (${ts.isAsExpression(initializer) ? initializer.expression.getText(catalogSource) : initializer.getText(catalogSource)});`)();
const translator = (language = 'en') => (key, params = {}) => (catalogs[language][key] ?? key).replace(/\{(\w+)\}/g, (_, name) => String(params[name] ?? `{${name}}`));
const transaction = (extra = {}) => ({ hash: 'tx-one', paymentId: '', description: '', label: '', direction: 'in', pending: false, failed: false, coinbase: false, amountAtomic: '1000000000', feeAtomic: '0', blockHeight: '100', confirmations: '3', unlockTime: '0', timestamp: '1000', subaddressAccount: 0, subaddressIndices: [], transfers: [], ...extra });
const deferred = () => { let resolve; let reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const tick = async () => { await new Promise(resolve => setImmediate(resolve)); };

// Execute the actual TSX functions with a small deterministic hook host. Native
// requests and the existing interval stay controllable; no wallet or socket opens.
function mount(invoke, language = 'en') {
  let hookIndex = 0;
  let hooks = [];
  let pendingEffects = [];
  let props = { linked: true, walletId: 'session-a', wallet: { id: 'wallet-a' } };
  let tree;
  const intervals = new Map();
  const listeners = new Map();
  let intervalId = 0;
  const t = translator(language);
  const useState = initial => {
    const index = hookIndex++;
    if (!hooks[index]) hooks[index] = { value: typeof initial === 'function' ? initial() : initial };
    return [hooks[index].value, value => { hooks[index].value = typeof value === 'function' ? value(hooks[index].value) : value; }];
  };
  const useRef = initial => {
    const index = hookIndex++;
    if (!hooks[index]) hooks[index] = { current: initial };
    return hooks[index];
  };
  const useEffect = (effect, deps) => {
    const index = hookIndex++;
    const previous = hooks[index];
    if (!previous || deps.some((value, position) => !Object.is(value, previous.deps[position]))) {
      pendingEffects.push(() => { previous?.cleanup?.(); hooks[index] = { deps, cleanup: effect() }; });
    }
  };
  const scope = { React, useState, useRef, useEffect, useI18n: () => ({ t }), invoke, window: {
    setInterval: (callback, delay) => { const id = ++intervalId; intervals.set(id, { callback, delay }); return id; },
    clearInterval: id => intervals.delete(id),
    addEventListener: (name, callback) => { listeners.set(name, callback); },
    removeEventListener: (name, callback) => { if (listeners.get(name) === callback) listeners.delete(name); },
  }, transactionConfirmationProgress, parseNativeJson: JSON.parse, errorMessage: reason => reason.message ?? String(reason),
  shortHash: hash => hash, transactionTimestamp: timestamp => timestamp, formatAtomicXmr: atomic => atomic,
  FixedAtomicXmr: ({ value }) => React.createElement('span', null, value), WalletFeature: ({ text }) => React.createElement('p', null, text) };
  const production = new Function(...Object.keys(scope), `${compiled}\nreturn { ${names.join(', ')} };`)(...Object.values(scope));
  const render = next => {
    props = { ...props, ...next };
    hookIndex = 0;
    tree = production.Activity(props);
    const effects = pendingEffects;
    pendingEffects = [];
    for (const effect of effects) effect();
    return tree;
  };
  const find = predicate => {
    const walk = node => {
      if (!node || typeof node !== 'object') return undefined;
      if (predicate(node)) return node;
      for (const child of React.Children.toArray(node.props?.children)) { const match = walk(child); if (match) return match; }
      return undefined;
    };
    return walk(tree);
  };
  return { production, render, find, intervals, wake: () => listeners.get('mfw-wallet-notification-wake')?.(), markup: () => renderToStaticMarkup(tree), poll: () => { assert.equal(intervals.size, 1); [...intervals.values()][0].callback(); }, unmount: () => { for (const hook of hooks) hook.cleanup?.(); } };
}

test('desktop status shows the real count/target and confirms at the shared threshold', () => {
  const { production } = mount(async () => '[]');
  for (const language of ['en', 'de']) {
    const t = translator(language);
    assert.equal(production.transactionListStatus(transaction(), t), language === 'de' ? 'Wird empfangen · 3/10 Bestätigungen' : 'Receiving · 3/10 confirmations');
    assert.equal(production.transactionListStatus(transaction({ confirmations: '10' }), t), language === 'de' ? 'Bestätigt · 10/10 Bestätigungen' : 'Confirmed · 10/10 confirmations');
  }
  const status = item => production.transactionListStatus(item, translator());
  assert.equal(status(transaction({ confirmations: '59', coinbase: true })), 'Receiving · 59/60 confirmations');
  assert.equal(status(transaction({ confirmations: '60', coinbase: true })), 'Confirmed · 60/60 confirmations');
  assert.equal(status(transaction({ confirmations: '12' })), 'Confirmed · 12/10 confirmations');
  assert.equal(status(transaction({ confirmations: '10', direction: 'out', pending: true })), 'Pending · 10/10 confirmations');
  assert.equal(status(transaction({ failed: true, confirmations: '12' })), 'Failed');
  assert.equal(status(transaction({ confirmations: 'bad' })), 'Receiving · 0/10 confirmations');
});

test('recent Home, Wallets and Receive rows use the same live progress presentation', () => {
  const { production } = mount(async () => '[]');
  const render = item => renderToStaticMarkup(production.RecentTransactions({ hasOpenWallet: true, items: [item], onActivity() {} }));
  assert.match(render(transaction({ pending: true, confirmations: '0' })), /Receiving · 0\/10 confirmations/);
  assert.match(render(transaction()), /Receiving · 3\/10 confirmations/);
  assert.match(render(transaction({ confirmations: '10' })), /Confirmed · 10\/10 confirmations/);
  assert.match(render(transaction({ confirmations: '10' })), /<strong>Received/);
});

test('an open detail advances with existing polls, keeps selection across inclusion, and handles a reorg', async () => {
  let current = transaction({ pending: true, confirmations: '0' });
  let calls = 0;
  const view = mount(async () => { calls++; return JSON.stringify([current]); });
  view.render(); await tick(); view.render();
  assert.equal([...view.intervals.values()][0].delay, 10_000);
  view.find(node => node.type === 'button' && node.props.className.startsWith('transaction-row')).props.onClick();
  view.render();
  assert.match(view.markup(), /Receiving Monero/);
  assert.match(view.markup(), /0\/10 confirmations/);
  for (const confirmations of ['3', '10']) {
    current = transaction({ confirmations, timestamp: '2000' });
    view.poll(); await tick(); view.render();
    const detail = renderToStaticMarkup(view.find(node => node.props?.className === 'transaction-detail'));
    assert.match(detail, new RegExp(`${confirmations}/10 confirmations`));
    assert.equal(detail.includes('Receiving Monero'), confirmations !== '10');
    assert.equal(detail.includes('Confirmed'), confirmations === '10');
    assert.match(view.markup(), /transaction-row selected/);
  }
  current = transaction({ pending: true, confirmations: '0', timestamp: '3000' });
  view.poll(); await tick(); view.render();
  assert.match(renderToStaticMarkup(view.find(node => node.props?.className === 'transaction-detail')), /Receiving · 0\/10 confirmations/);
  assert.equal(calls, 4);
  view.unmount();
  assert.equal(view.intervals.size, 0);
});

test('wallet or session changes hide old detail immediately and discard delayed history', async () => {
  const old = deferred(); const next = deferred();
  const view = mount((_command, { input }) => input.registrationId === 'wallet-a' ? old.promise : next.promise);
  view.render();
  view.render({ walletId: 'session-b', wallet: { id: 'wallet-b' } });
  next.resolve(JSON.stringify([transaction({ hash: 'tx-b' })])); await tick(); view.render();
  old.resolve(JSON.stringify([transaction({ hash: 'tx-a' })])); await tick(); view.render();
  assert.match(view.markup(), /tx-b/);
  assert.doesNotMatch(view.markup(), /tx-a/);
  view.find(node => node.type === 'button' && node.props.className.startsWith('transaction-row')).props.onClick(); view.render();
  assert.ok(view.find(node => node.props?.className === 'transaction-detail'));
  view.render({ walletId: 'session-b-reopened' });
  assert.doesNotMatch(view.markup(), /tx-b/);
  assert.equal(view.find(node => node.props?.className === 'transaction-detail'), undefined);
  view.unmount();
});

test('slow native history requests never overlap on interval ticks', async () => {
  const response = deferred(); let calls = 0;
  const view = mount(() => { calls++; return response.promise; });
  view.render();
  view.poll(); view.poll();
  assert.equal(calls, 1);
  response.resolve('[]'); await tick(); view.render();
  view.poll(); await tick();
  assert.equal(calls, 2);
  view.unmount();
});

test('incoming and test notification wakes refresh the real history immediately', async () => {
  let current = transaction({ pending: true, confirmations: '0' });
  let calls = 0;
  const view = mount(async () => { calls++; return JSON.stringify([current]); });
  view.render(); await tick(); view.render();
  current = transaction({ confirmations: '10' });
  view.wake(); await tick(); view.render();
  assert.equal(calls, 2);
  assert.match(view.markup(), /Confirmed · 10\/10 confirmations/);
  view.unmount();
  view.wake();
  assert.equal(calls, 2);
});
