import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';
import { displaySyncPercent, formatNetworkSyncRate, formatSyncPercent, formatWalletDerivationRate, networkSyncTransportPresentation, presentNetworkSync } from '../../../packages/wallet-shared/src/networkSync.ts';
import { walletScanBacklog } from '../../../packages/wallet-shared/src/walletSync.ts';

const text = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
const source = ts.createSourceFile('App.tsx', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const names = ['DesktopSyncProgress', 'DesktopSyncProgressRow', 'syncTransportCopy', 'networkSyncPhaseLabel', 'formatSyncBlockCount', 'formatDesktopSyncEta', 'selectDesktopWalletSnapshot'];
const declarations = names.map(name => {
  const declaration = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
  assert.ok(declaration, name);
  return declaration.getText(source);
}).join('\n');
const compiled = ts.transpileModule(declarations, { compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React } }).outputText;
const selectSnapshot = new Function(`${compiled}\nreturn selectDesktopWalletSnapshot;`)();

function observeSnapshot(id, walletHeight, snapshotRevision, observedAt, registered = {}) {
  return {
    snapshot: { id, walletHeight: String(walletHeight), snapshotRevision },
    observedAt,
    registrationId: 'ledger',
    ...registered,
  };
}

test('fresh direct wallet progress wins when bulk polling misses the native lock', () => {
  const staleBulk = observeSnapshot('view', 2377756, '61', 10);
  const fresh = observeSnapshot('view', 2440220, '124', 180);
  assert.equal(selectSnapshot('view', 'ledger', fresh, staleBulk), fresh);
});

test('a newer revision wins even if its height fell or its response arrived out of order', () => {
  const oldDirect = observeSnapshot('view', 2440220, '9007199254740992', 180);
  const reorg = observeSnapshot('view', 2440219, '9007199254740993', 170);
  assert.equal(selectSnapshot('view', 'ledger', oldDirect, reorg), reorg);
});

test('different native handles only admit a Ledger companion observed for the current selection', () => {
  const oldDirect = observeSnapshot('old', 2440220, '1000', 180);
  const oldBulk = observeSnapshot('old', 2440220, '1000', 170);
  assert.equal(selectSnapshot('current', 'ledger', oldDirect, oldBulk), undefined);

  const active = observeSnapshot('current', 2440230, '25', 200);
  const companion = observeSnapshot('view', 2440000, '1', 195, {
    usesLedgerReadOnly: true,
    requestedWalletId: 'current',
  });
  assert.equal(selectSnapshot('current', 'ledger', active, companion), companion);
  assert.equal(selectSnapshot('other', 'ledger', active, companion), undefined);
  assert.equal(selectSnapshot(null, 'ledger', active, oldBulk), oldBulk);
  assert.equal(selectSnapshot('current', 'different-registration', active, companion), undefined);
});

test('the newer observation wins for matching legacy snapshots without a revision', () => {
  const direct = observeSnapshot('view', 2440200, undefined, 170);
  const bulk = observeSnapshot('view', 2440220, undefined, 180);
  assert.equal(selectSnapshot('view', 'ledger', direct, bulk), bulk);
});
const messagesText = readFileSync(new URL('../src/i18n.tsx', import.meta.url), 'utf8');
const messagesSource = ts.createSourceFile('i18n.tsx', messagesText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const messagesDeclaration = messagesSource.statements.flatMap(node => ts.isVariableStatement(node) ? [...node.declarationList.declarations] : []).find(node => node.name.getText(messagesSource) === 'baseMessages');
const initializer = messagesDeclaration.initializer;
const messages = new Function(`return (${ts.isAsExpression(initializer) ? initializer.expression.getText(messagesSource) : initializer.getText(messagesSource)});`)().en;
const t = (key, params = {}) => {
  assert.ok(messages[key], key);
  return messages[key].replace(/\{(\w+)\}/g, (_, name) => String(params[name] ?? `{${name}}`));
};
function render(overrides = {}, expanded) {
  const scope = { React, displaySyncPercent, formatNetworkSyncRate, formatSyncPercent, formatWalletDerivationRate, networkSyncTransportPresentation, presentNetworkSync, walletScanBacklog,
    useState: initial => [expanded ?? (typeof initial === 'function' ? initial() : initial), () => {}], useRef: current => ({ current }), useEffect() {},
    useAggregateNetworkRate: () => 8.2, walletSyncDerivationsPerSecond: () => 12_000, completedFullScanMetrics: () => undefined,
  };
  const production = new Function(...Object.keys(scope), `${compiled}\nreturn DesktopSyncProgress;`)(...Object.values(scope));
  return renderToStaticMarkup(production({
    t, locale: 'en-US', walletName: 'Wallet', walletOpened: true, walletSyncFresh: true,
    networkStatus: { phase: 'fetching-blocks', state: 'fetching-blocks', blockTransport: 'grpc', blockTransportReason: 'grpc-stream', chainHeight: 1000, targetHeight: 1000, downloadedHeight: 950, joinedWallets: 1, transportStarts: 1 },
    network: { ready: false, downloadComplete: false, connected: true, failed: false, phase: 'fetching-blocks', targetHeight: 1000, chainHeight: 1000, downloadedHeight: 950, downloadStartHeight: 900, progress: 50 },
    sync: { phase: 'syncing', coreConfirmed: false, targetHeight: 1000, walletHeight: 940, progress: 40 }, syncEtaSeconds: 40,
    ...overrides,
  }));
}

test('compact sync keeps both bars, live metrics and inline transport without the explanation box', () => {
  const markup = render();
  assert.equal((markup.match(/class="sync-track"/g) ?? []).length, 2);
  assert.match(markup, /sync-transport-badge transport-success[^>]*>gRPC/);
  assert.match(markup, /50 blocks remaining/);
  assert.match(markup, /60 blocks remaining/);
  assert.match(markup, /10 blocks behind download/);
  assert.match(markup, /8\.20 Mbit\/s/);
  assert.match(markup, /12,000 derivations\/s/);
  assert.match(markup, /40s remaining/);
  assert.equal((markup.match(/Downloading and scanning all wallets/g) ?? []).length, 1, 'one phase status, no duplicate detail');
  assert.doesNotMatch(markup, /class="desktop-sync-transport|preferred endpoint|uses standard RPC|fast path/);
});

test('a stale wallet status retains the scan bar but hides old remaining counts and ETA', () => {
  const markup = render({ walletSyncFresh: false });
  assert.equal((markup.match(/class="sync-track"/g) ?? []).length, 2);
  assert.match(markup, /Updating wallet status/);
  assert.match(markup, /50 blocks remaining/);
  assert.doesNotMatch(markup, /60 blocks remaining|blocks behind download|40s remaining|derivations\/s/);
});

test('expanded fallback is yellow and appears once in the blockchain label', () => {
  const markup = render({ networkStatus: { phase: 'fetching-blocks', state: 'fetching-blocks', blockTransport: 'rpc', blockTransportReason: 'rpc-fallback', joinedWallets: 1, transportStarts: 1 } });
  assert.match(markup, /sync-transport-badge transport-warning[^>]*>Fallback/);
  assert.equal((markup.match(/>Fallback</g) ?? []).length, 1);
  assert.doesNotMatch(markup, /uses standard RPC/);
});

test('an unconfirmed current path stays checking while connection elapsed time remains visible', () => {
  const markup = render({ networkStatus: { phase: 'initializing-transport', state: 'initializing-transport', blockTransport: 'unknown', phaseElapsedMs: 12_000 }, network: { ready: false, connected: false, failed: false, phase: 'initializing-transport' } });
  assert.match(markup, /sync-transport-badge transport-neutral[^>]*>Checking/);
  assert.match(markup, /12s/);
  assert.doesNotMatch(markup, /transport-success|>gRPC</);
});

const tipCheck = {
  state: 'checking-mempool', phase: 'checking-mempool', blockTransport: 'unknown',
  transportStarts: 1, joinedWallets: 1, chainHeight: 1000, targetHeight: 1000, downloadedHeight: 1000,
};
const syncedViewingWallet = {
  phase: 'synchronized', coreConfirmed: true, targetHeight: 1000, walletHeight: 1000, progress: 100,
};

test('a synced viewing wallet keeps the Ledger instruction visible during a tip check', () => {
  const markup = render({
    readinessPhase: 'waiting-ledger',
    networkStatus: tipCheck,
    network: presentNetworkSync(tipCheck),
    sync: syncedViewingWallet,
  });
  assert.match(markup, /desktop-sync-status-card collapsed/);
  assert.match(markup, /data-testid="ledger-verification-status"[^>]*>Ledger check pending\. Connect and unlock Ledger/);
  assert.doesNotMatch(markup, /Checking spend outputs/);
});

test('a Ledger connection error leaves the completed scan collapsed and the retry visible', () => {
  const markup = render({
    readinessPhase: 'recoverable-error',
    ledgerError: 'No matching Ledger device is connected.',
    networkStatus: tipCheck,
    network: presentNetworkSync(tipCheck),
    sync: syncedViewingWallet,
  });
  assert.match(markup, /desktop-sync-status-card collapsed/);
  assert.match(markup, /data-testid="ledger-verification-status"[^>]*>Ledger check failed\. Connect Ledger and try again/);
  assert.doesNotMatch(markup, /Checking spend outputs/);
});

test('an active Ledger check stays separate from the completed block download and wallet scan', () => {
  const markup = render({
    readinessPhase: 'scanning-spend-outputs',
    ledgerStatus: t('home.spendOutputsChecking'),
    networkStatus: tipCheck,
    network: presentNetworkSync(tipCheck),
    sync: syncedViewingWallet,
  }, true);
  assert.match(markup, /data-testid="ledger-verification-status"[^>]*>Checking spend outputs/);
  assert.match(markup, /data-testid="blockchain-progress"[\s\S]*?<em class="ready">100%/);
  assert.match(markup, /data-testid="wallet-progress"[\s\S]*?Wallet sync[\s\S]*?<em class="ready">100%/i);
  assert.doesNotMatch(markup, /derivations\/s/);
});
