import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';
import { pushTestCanStart, receivedPushTest, validPushTestReceipt } from '../src/pushNotificationTest.ts';

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const receipt = { accepted: true, eventId: `evt_${'a'.repeat(64)}`, scheduledAt: 2_000_000_000, deliverAfter: 2_000_000_010 };
const ready = { available: true, reason: 'ready', phase: 'idle', receipt: null, receivedAt: null };
const scheduled = { ...ready, phase: 'scheduled', receipt };
const received = { ...scheduled, phase: 'received', receivedAt: receipt.deliverAfter + 1 };
const deferred = () => { let resolve; let reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const tick = async () => { await new Promise(resolve => setImmediate(resolve)); };

const catalog = ts.createSourceFile('i18n.tsx', read('../src/i18n.tsx'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const declaration = catalog.statements.flatMap(node => ts.isVariableStatement(node) ? [...node.declarationList.declarations] : []).find(node => node.name.getText(catalog) === 'baseMessages');
const initializer = declaration.initializer;
const messages = new Function(`return (${ts.isAsExpression(initializer) ? initializer.expression.getText(catalog) : initializer.getText(catalog)});`)();
const t = key => messages.en[key] ?? key;
const source = ts.createSourceFile('FastWalletTestPushPanel.tsx', read('../src/FastWalletTestPushPanel.tsx'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const component = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'FastWalletTestPushPanel');
const compiled = ts.transpileModule(component.getText(source).replace('export default ', ''), { compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React } }).outputText;

// Run the production TSX component with deterministic hooks and IPC. Nothing
// opens a wallet, sends a push, or contacts a server in these tests.
function mount(invoke, props = {}) {
  let index = 0;
  let tree;
  const hooks = [];
  const effects = [];
  const listeners = new Map();
  const timers = new Map();
  let timerId = 0;
  const useState = initial => {
    const position = index++;
    if (!hooks[position]) hooks[position] = { value: typeof initial === 'function' ? initial() : initial };
    return [hooks[position].value, next => { hooks[position].value = typeof next === 'function' ? next(hooks[position].value) : next; }];
  };
  const useRef = initial => {
    const position = index++;
    if (!hooks[position]) hooks[position] = { current: initial };
    return hooks[position];
  };
  const changed = (old, deps) => !old || deps.some((value, position) => !Object.is(value, old.deps[position]));
  const useCallback = (callback, deps) => {
    const position = index++;
    if (changed(hooks[position], deps)) hooks[position] = { value: callback, deps };
    return hooks[position].value;
  };
  const useEffect = (effect, deps) => {
    const position = index++;
    const previous = hooks[position];
    if (changed(previous, deps)) effects.push(() => { previous?.cleanup?.(); hooks[position] = { deps, cleanup: effect() }; });
  };
  const scope = { React, invoke, useState, useRef, useCallback, useEffect, useI18n: () => ({ t }), pushTestCanStart, receivedPushTest, window: {
    addEventListener: (name, callback) => { listeners.set(name, callback); },
    removeEventListener: (name, callback) => { if (listeners.get(name) === callback) listeners.delete(name); },
    setTimeout: (callback, delay) => { const id = ++timerId; timers.set(id, { callback, delay }); return id; },
    clearTimeout: id => timers.delete(id),
  } };
  const Panel = new Function(...Object.keys(scope), `${compiled}\nreturn FastWalletTestPushPanel;`)(...Object.values(scope));
  const render = () => { index = 0; tree = Panel(props); for (const effect of effects.splice(0)) effect(); return tree; };
  const button = label => {
    const walk = node => {
      if (!node || typeof node !== 'object') return undefined;
      if (node.type === 'button' && (!label || React.Children.toArray(node.props.children)
        .filter(child => typeof child === 'string' || typeof child === 'number').join('') === label)) return node;
      for (const child of React.Children.toArray(node.props?.children)) { const match = walk(child); if (match) return match; }
    };
    return walk(tree);
  };
  return { render, button, timers, markup: () => renderToStaticMarkup(tree), event: name => listeners.get(name)?.(), unmount: () => { for (const hook of hooks) hook.cleanup?.(); } };
}

test('only the exact server receipt validates; acceptance alone never means received', () => {
  assert.equal(validPushTestReceipt(receipt), true);
  for (const patch of [{ accepted: false }, { eventId: 'fwpush_test_local' }, { eventId: `evt_${'A'.repeat(64)}` }, { deliverAfter: receipt.deliverAfter - 1 }, { scheduledAt: 0 }, { deliverAfter: Infinity }, { address: 'private' }]) {
    assert.equal(validPushTestReceipt({ ...receipt, ...patch }), false);
  }
  assert.equal(receivedPushTest(scheduled), false);
  assert.equal(receivedPushTest({ ...received, receivedAt: null }), false);
  assert.equal(receivedPushTest(received), true);
});

test('missing prerequisites give immediate visible help without sending a test', async () => {
  for (const reason of ['fast-wallet-required', 'alerts-required', 'permission-required']) {
    const commands = [];
    const view = mount(async command => { commands.push(command); return { ...ready, available: false, reason }; });
    view.render(); await tick(); view.render();
    assert.equal(view.button().props.disabled, false, reason);
    view.button().props.onClick(); await tick(); view.render();
    assert.deepEqual(commands, ['test_push_notification_status']);
    assert.match(view.markup(), /Test not started/);
    assert.match(view.markup(), /push-test-feedback is-attention/);
    assert.doesNotMatch(view.markup(), /Test push received/);
    view.unmount();
  }
});

test('missing setup provides a direct owner action without creating a wallet or sending a test', async () => {
  for (const reason of ['fast-wallet-required', 'alerts-required', 'permission-required']) {
    let setupCalls = 0; let manageCalls = 0;
    const commands = [];
    const view = mount(async command => {
      commands.push(command);
      return { ...ready, available: false, reason };
    }, {
      onSetupFastWallet: () => ++setupCalls,
      onManageAlerts: () => ++manageCalls,
    });
    view.render(); await tick(); view.render();
    assert.equal(view.button().props.disabled, false);
    const label = t(reason === 'fast-wallet-required' ? 'settings.pushTestSetupFastWallet' : 'settings.pushTestManageAlerts');
    const action = view.button(label);
    assert.ok(action, reason);
    assert.notEqual(action.props.disabled, true);
    let focused = 0;
    action.props.ref.current = { focus: () => ++focused };
    view.button().props.onClick();
    view.render();
    assert.equal(focused, 1, reason);
    assert.equal(setupCalls, 0, 'testing only focuses the owner action; it never creates a wallet');
    assert.equal(manageCalls, 0);
    assert.match(view.markup(), /Test not started/);
    action.props.onClick();
    assert.equal(setupCalls, reason === 'fast-wallet-required' ? 1 : 0);
    assert.equal(manageCalls, reason === 'fast-wallet-required' ? 0 : 1);
    assert.deepEqual(commands, ['test_push_notification_status']);
    view.unmount();
  }
});

test('a confirmed macOS denial opens notification settings directly without scheduling or enabling anything', async () => {
  const response = deferred();
  const commands = [];
  let managed = 0;
  const current = { ...ready, available: false, reason: 'permission-required', permissionSettingsAvailable: true };
  const view = mount(command => {
    commands.push(command);
    return command === 'open_notification_settings' ? response.promise : Promise.resolve(current);
  }, { onManageAlerts: () => ++managed });
  view.render(); await tick(); view.render();
  assert.match(view.markup(), /Notifications are blocked in macOS/);
  assert.ok(view.button(t('settings.pushTestOpenMacSettings')));
  assert.ok(view.button(t('settings.pushTestManageAlerts')), 'normal alert management remains reachable');
  const click = view.button().props.onClick;
  click(); click(); view.render();
  assert.equal(view.button().props['aria-busy'], true);
  assert.match(view.markup(), /Opening notification settings/);
  assert.match(view.markup(), /mfw-inline-spinner/);
  assert.doesNotMatch(view.markup(), /Test not started/);
  assert.deepEqual(commands, ['test_push_notification_status', 'open_notification_settings']);
  assert.equal(managed, 0);
  response.resolve(); await tick(); view.render();
  assert.equal(view.button().props.disabled, false);
  view.button(t('settings.pushTestOpenMacSettings')).props.onClick(); await tick(); view.render();
  assert.deepEqual(commands, ['test_push_notification_status', 'open_notification_settings', 'open_notification_settings']);
  view.unmount();
});

test('a settings opener failure is visible and retryable; local disable or provider pending never implies OS denial', async () => {
  const current = { ...ready, available: false, reason: 'permission-required', permissionSettingsAvailable: true };
  const view = mount(async command => {
    if (command === 'open_notification_settings') throw new Error('settings-open-failed');
    return current;
  });
  view.render(); await tick(); view.render();
  view.button().props.onClick(); await tick(); view.render();
  assert.match(view.markup(), /Notification settings could not be opened/);
  assert.equal(view.button().props.disabled, false);
  view.unmount();
  for (const reason of ['permission-required', 'provider-required', 'gateway-required']) {
    const other = mount(async () => ({ ...ready, available: false, reason, permissionSettingsAvailable: false }));
    other.render(); await tick(); other.render();
    assert.equal(other.button(t('settings.pushTestOpenMacSettings')), undefined, reason);
    assert.doesNotMatch(other.markup(), /blocked in macOS/);
    other.unmount();
  }
});

test('macOS banner setup stays available after authorization and receipt, without claiming an OS settings check', async () => {
  for (const current of [ready, scheduled, received]) {
    const response = deferred();
    const commands = [];
    const view = mount(command => {
      commands.push(command);
      return command === 'open_focus_settings' ? response.promise : Promise.resolve({ ...current, platform: 'macos', permissionSettingsAvailable: false });
    });
    view.render(); await tick(); view.render();
    assert.match(view.markup(), /Set up macOS banners/);
    assert.match(view.markup(), /Focus and screen sharing can suppress banners even when a push was received/);
    assert.match(view.markup(), /cannot fully verify your Focus and screen-sharing settings/);
    assert.doesNotMatch(view.markup(), /Notifications are blocked in macOS/);
    const focus = view.button(t('settings.pushTestOpenFocusSettings'));
    const notifications = view.button(t('settings.pushTestOpenMacSettings'));
    assert.ok(focus);
    assert.ok(notifications);
    assert.equal(focus.props.disabled, false, 'settings remain reachable while a server test is scheduled');
    const timer = [...view.timers.values()][0];
    focus.props.onClick(); notifications.props.onClick(); focus.props.onClick(); view.render();
    assert.equal(view.button(t('settings.pushTestOpenFocusSettings')).props['aria-busy'], true);
    assert.match(view.markup(), /Opening Focus settings/);
    assert.deepEqual(commands, ['test_push_notification_status', 'open_focus_settings']);
    response.resolve(); await tick(); view.render();
    assert.equal([...view.timers.values()][0], timer, 'opening OS settings never changes a receipt or its deadline');
    if (current.phase === 'received') assert.match(view.markup(), /Test push received by this device/);
    if (current.phase === 'scheduled') assert.equal(view.button().props.disabled, true);
    view.button(t('settings.pushTestOpenMacSettings')).props.onClick(); await tick(); view.render();
    assert.deepEqual(commands, ['test_push_notification_status', 'open_focus_settings', 'open_notification_settings']);
    view.unmount();
  }
});

test('a failed Focus opener gives a manual route, while other native platforms have no macOS setup', async () => {
  const view = mount(async command => {
    if (command === 'open_focus_settings') throw new Error('focus-open-failed');
    return { ...received, platform: 'macos', permissionSettingsAvailable: false };
  });
  view.render(); await tick(); view.render();
  view.button(t('settings.pushTestOpenFocusSettings')).props.onClick(); await tick(); view.render();
  assert.match(view.markup(), /Focus settings could not be opened/);
  assert.match(view.markup(), /System Settings → Focus/);
  assert.match(view.markup(), /Test push received by this device/);
  assert.equal(view.button(t('settings.pushTestOpenFocusSettings')).props.disabled, false);
  view.unmount();
  for (const platform of ['windows', 'linux', 'unknown']) {
    const other = mount(async () => ({ ...ready, platform, permissionSettingsAvailable: false }));
    other.render(); await tick(); other.render();
    assert.equal(other.button(t('settings.pushTestOpenFocusSettings')), undefined);
    assert.equal(other.button(t('settings.pushTestOpenMacSettings')), undefined);
    assert.doesNotMatch(other.markup(), /Set up macOS banners/);
    other.unmount();
  }
});

test('finishing the normal alert setup rechecks the real prerequisites', async () => {
  let current = { ...ready, available: false, reason: 'alerts-required' };
  const view = mount(async () => current, { onManageAlerts() {} });
  view.render(); await tick(); view.render();
  view.button().props.onClick(); view.render();
  assert.match(view.markup(), /Test not started/);
  current = ready;
  view.event('mfw-fast-wallet-alerts-changed'); await tick(); view.render();
  assert.equal(view.button().props.disabled, false);
  assert.doesNotMatch(view.markup(), /Test not started/);
  view.unmount();
});

test('a newly recoverable registration does not retain the old setup-blocked explanation', async () => {
  let current = { ...ready, available: false, reason: 'permission-required' };
  const view = mount(async () => current);
  view.render(); await tick(); view.render();
  view.button().props.onClick(); view.render();
  assert.match(view.markup(), /Test not started/);
  current = { ...ready, available: false, reason: 'provider-required' };
  view.event('mfw-notification-registration-changed'); await tick(); view.render();
  assert.doesNotMatch(view.markup(), /Test not started|blocked in macOS/);
  assert.match(view.markup(), /registration for this device is still pending/);
  view.unmount();
});

test('the server cooldown explains 60 seconds and preserves the actual received event', async () => {
  const commands = [];
  const view = mount(async command => {
    commands.push(command);
    if (command === 'request_test_push_notification') throw 'push-test-rate-limited';
    return received;
  });
  view.render(); await tick(); view.render();
  view.button().props.onClick(); await tick(); view.render();
  assert.match(view.markup(), /Wait at least 60 seconds between push tests/);
  assert.match(view.markup(), /Test push received by this device/);
  assert.doesNotMatch(view.markup(), /could not be confirmed/);
  assert.deepEqual(commands, ['test_push_notification_status', 'request_test_push_notification']);
  assert.equal(view.timers.size, 0);
  view.unmount();
});

test('setup navigation reuses the normal wallet flow and limits alert management to its own controls', () => {
  const app = read('../src/App.tsx');
  const start = app.slice(app.indexOf('const startFastWalletSetup ='), app.indexOf('const openSavedWallet ='));
  assert.match(start, /unlockForWalletAction/);
  assert.match(start, /setSetupFastWalletRequested\(true\)/);
  assert.match(start, /setSection\('setup'\)/);
  assert.doesNotMatch(start, /create_fast_wallet|create_wallet|recovery_seed/);
  assert.match(app, /<Setup[^>]*initialFastWallet=\{setupFastWalletRequested\}/);
  assert.match(app, /<FastWalletTestPushPanel onSetupFastWallet=\{onSetupFastWallet\} onManageAlerts=/);
  assert.match(app, /<FastWallets[^>]*alertsOnly/);
  assert.match(app, /!alertsOnly && opened/);
  assert.match(app, /!alertsOnly && <div className="button-row">\{opened/);
});

test('a click immediately requests the server once and shows scheduled rather than delivered', async () => {
  const response = deferred();
  const commands = [];
  let current = ready;
  const view = mount(command => { commands.push(command); return command === 'request_test_push_notification' ? response.promise : Promise.resolve(current); });
  view.render(); await tick(); view.render();
  assert.equal(view.button().props.disabled, false);
  const click = view.button().props.onClick;
  click(); click();
  view.render();
  assert.equal(view.button().props.disabled, true);
  assert.equal(view.button().props['aria-busy'], true);
  assert.match(view.markup(), /mfw-inline-spinner/);
  assert.match(view.markup(), /Requesting server test/);
  assert.equal(commands.filter(command => command === 'request_test_push_notification').length, 1);
  assert.equal(view.timers.size, 0, 'no client-side delay before POST');
  current = scheduled; response.resolve(scheduled); await tick(); view.render();
  assert.match(view.markup(), /Server test scheduled/);
  assert.doesNotMatch(view.markup(), /Test push received/);
  assert.equal(view.button().props.disabled, true);
  assert.equal(view.button().props['aria-busy'], true);
  assert.match(view.markup(), /Waiting for notification/);
  const before = commands.length;
  view.button().props.onClick();
  assert.equal(commands.length, before, 'scheduled clicks do not send or clear the pending receipt');
  current = received; view.event('mfw-notification-received'); await tick(); view.render();
  assert.match(view.markup(), /Test push received by this device/);
  assert.equal(view.button().props.disabled, false);
  view.unmount();
  assert.equal(view.timers.size, 0);
});

test('provider and gateway recovery await the native request with immediate feedback and no duplicate scheduling', async () => {
  for (const reason of ['provider-required', 'gateway-required']) {
    const response = deferred();
    const commands = [];
    let current = { ...ready, available: false, reason };
    const view = mount(command => {
      commands.push(command);
      return command === 'request_test_push_notification' ? response.promise : Promise.resolve(current);
    });
    view.render(); await tick(); view.render();
    const click = view.button().props.onClick;
    click(); click(); view.render();
    assert.equal(view.button().props['aria-busy'], true, reason);
    assert.match(view.markup(), /mfw-inline-spinner/);
    assert.match(view.markup(), /Requesting server test/);
    assert.equal(commands.filter(command => command === 'request_test_push_notification').length, 1);
    assert.equal(view.timers.size, 0);
    current = scheduled; response.resolve(scheduled); await tick(); view.render();
    assert.match(view.markup(), /Server test scheduled/);
    assert.doesNotMatch(view.markup(), /Test push received/);
    assert.equal(view.button().props.disabled, true);
    view.unmount();
  }
});

test('registration refresh preserves the scheduled receipt and cannot bypass its cooldown', async () => {
  const commands = [];
  let current = { ...scheduled, available: false, reason: 'provider-required' };
  const view = mount(async command => { commands.push(command); return current; }, { onManageAlerts() {} });
  view.render(); await tick(); view.render();
  assert.equal(view.button().props.disabled, true);
  assert.ok(view.button(t('settings.pushTestManageAlerts')), 'existing setup stays reachable');
  const timer = [...view.timers.values()][0];
  current = scheduled;
  view.event('mfw-notification-registration-changed'); await tick(); view.render();
  assert.match(view.markup(), /Server test scheduled/);
  assert.equal(view.button().props.disabled, true);
  assert.equal([...view.timers.values()][0], timer, 'same receipt retains its absolute delivery deadline');
  view.button().props.onClick(); await tick();
  assert.deepEqual(commands, ['test_push_notification_status', 'test_push_notification_status']);
  current = received;
  view.event('mfw-notification-received'); await tick(); view.render();
  current = scheduled;
  view.event('mfw-notification-registration-changed'); await tick(); view.render();
  assert.match(view.markup(), /Test push received by this device/, 'registration cannot downgrade the matching received event');
  assert.equal(view.timers.size, 0);
  view.unmount();
});

test('successful registration clears only a provider recovery error', async () => {
  for (const code of ['push-test-provider-required', 'push-test-gateway-required', 'push-test-worker-unsupported']) {
    const view = mount(async command => {
      if (command === 'request_test_push_notification') throw code;
      return ready;
    });
    view.render(); await tick(); view.render();
    view.button().props.onClick(); await tick(); view.render();
    assert.match(view.markup(), code === 'push-test-worker-unsupported' ? /selected scan service does not support/ : /registration for this device is still pending/);
    view.event('mfw-notification-registration-changed'); await tick(); view.render();
    if (code === 'push-test-worker-unsupported') assert.match(view.markup(), /selected scan service does not support/);
    else assert.doesNotMatch(view.markup(), /registration for this device is still pending/);
    view.unmount();
  }
});

test('unlock and focus resume only existing native opt-in, singleflight, and notify readiness after completion', async () => {
  const appSource = ts.createSourceFile('App.tsx', read('../src/App.tsx'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let effect;
  const visit = node => {
    if (ts.isCallExpression(node) && node.expression.getText(appSource) === 'useEffect'
      && node.arguments[0]?.getText(appSource).includes('notificationResumeInFlight')) effect = node.arguments[0];
    ts.forEachChild(node, visit);
  };
  visit(appSource);
  assert.ok(effect, 'production unlock effect exists');
  const effectText = effect.getText(appSource);
  assert.doesNotMatch(effectText, /requestPermission|enableDesktopFastWalletSignals|enable_encrypted_fast_wallet_alerts/);
  const js = ts.transpileModule(`const effect = ${effectText};`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const response = deferred();
  const listeners = new Map();
  const notifications = [];
  const resume = { current: null };
  let calls = 0;
  let nativeChanged;
  let stopped = 0;
  const make = protection => new Function('appProtection', 'notificationResumeInFlight', 'createDesktopNotificationClient', 'listen', 'window', 'Event', `${js}\nreturn effect;`)(
    protection, resume, () => ({ refreshInstallation() { ++calls; return response.promise; } }),
    async (_name, callback) => { nativeChanged = callback; return () => ++stopped; },
    { dispatchEvent: event => notifications.push(event.type), addEventListener: (name, callback) => listeners.set(name, callback), removeEventListener: (name, callback) => { if (listeners.get(name) === callback) listeners.delete(name); } }, Event,
  );
  assert.equal(make(null)(), undefined);
  assert.equal(make({ configured: true, locked: true })(), undefined);
  assert.equal(calls, 0);
  const cleanup = make({ configured: true, locked: false })();
  listeners.get('focus')(); listeners.get('focus')();
  assert.equal(calls, 1);
  assert.equal(notifications.length, 0, 'readiness is not announced before native completion');
  cleanup();
  const cleanupRemount = make({ configured: true, locked: false })();
  assert.equal(calls, 1, 'a remount awaits the same native resume');
  response.resolve(); await tick();
  assert.deepEqual(notifications, ['mfw-notification-registration-changed']);
  nativeChanged();
  assert.equal(notifications.length, 2);
  cleanupRemount();
  nativeChanged();
  assert.equal(notifications.length, 2, 'locked or unmounted owners do not forward readiness');
  assert.equal(listeners.size, 0);
  assert.equal(stopped, 2);
});

test('an actual receipt arriving before the POST response is retained', async () => {
  const response = deferred();
  let current = ready;
  const view = mount(command => command === 'request_test_push_notification' ? response.promise : Promise.resolve(current));
  view.render(); await tick(); view.render();
  view.button().props.onClick(); view.render();
  current = received; view.event('mfw-notification-received'); await tick(); view.render();
  response.resolve(scheduled); await tick(); view.render();
  assert.match(view.markup(), /Test push received by this device/);
  view.unmount();
});

test('a delayed old status cannot overwrite the response to a newer status read', async () => {
  const old = deferred(); let reads = 0;
  const view = mount(() => ++reads === 1 ? old.promise : Promise.resolve(received));
  view.render(); view.event('mfw-notification-received'); await tick(); view.render();
  old.resolve(ready); await tick(); view.render();
  assert.match(view.markup(), /Test push received by this device/);
  view.unmount();
});

test('unsupported remote workers show a failure and allow retry without enabling alerts', async () => {
  const commands = [];
  const view = mount(async command => {
    commands.push(command);
    if (command === 'request_test_push_notification') throw new Error('push-test-worker-unsupported');
    return ready;
  });
  view.render(); await tick(); view.render(); view.button().props.onClick(); await tick(); view.render();
  assert.match(view.markup(), /selected scan service does not support/);
  assert.doesNotMatch(view.markup(), /scheduled|Test push received/);
  assert.equal(view.button().props.disabled, false);
  assert.deepEqual(commands, ['test_push_notification_status', 'request_test_push_notification']);
  view.unmount();
});

test('server-side missing setup is shown clearly and preserves the disabled preference', async () => {
  for (const [code, message] of [
    ['push-test-fast-wallet-required', /Enable incoming-payment alerts/],
    ['push-test-provider-required', /registration for this device is still pending/],
  ]) {
    const commands = [];
    const view = mount(async command => {
      commands.push(command);
      if (command === 'request_test_push_notification') throw code;
      return ready;
    });
    view.render(); await tick(); view.render(); view.button().props.onClick(); await tick(); view.render();
    assert.match(view.markup(), message);
    assert.doesNotMatch(view.markup(), /Test push received/);
    assert.deepEqual(commands, ['test_push_notification_status', 'request_test_push_notification']);
    view.unmount();
  }
});

test('native command uses authenticated fixed Tor gateway, strict 202 and persisted independent event correlation', () => {
  const native = read('../src-tauri/src/desktop_notifications.rs');
  const request = native.slice(native.indexOf('pub async fn request_test_push'), native.indexOf('fn valid_received_event'));
  assert.match(native, /\.proxy\(crate::tor_transport::proxy\(\)\?\)/);
  assert.match(request, /desktop_http_client\(\)\?\.post\(format!\("\{\}\/api\/v1\/installations\/test-push"/);
  assert.match(request, /"x-fast-wallet-installation-id"/);
  assert.match(request, /"x-fast-wallet-installation-auth"/);
  assert.match(request, /zeroize::Zeroizing::new/);
  assert.match(request, /reqwest::StatusCode::ACCEPTED/);
  assert.match(request, /bytes\.len\(\) \+ chunk\.len\(\) > 8192/);
  assert.match(request, /valid_schedule/);
  assert.match(request, /let mut state = read_test_push_state\(app\)\?;\s*state\.receipt = Some\(receipt\.clone\(\)\)/);
  assert.match(native, /state\.received\.iter\(\)\.find\(\|event\| event\.event_id == receipt\.event_id\)/);
  const gate = native.slice(native.indexOf('fn test_setup_gate'), native.indexOf('pub fn test_push_status'));
  assert.match(gate, /notification_test::alerts_ready/);
  assert.doesNotMatch(gate, /wallet\.status/, 'encrypted alerts retain local-only legacy scanner status');
  assert.doesNotMatch(request, /sleep|sendPrivacySafeNotificationTest|notifications_enabled\s*=/);
  for (const command of ['request_test_push_notification', 'test_push_notification_status', 'consume_pending_notification_events']) {
    const lib = read('../src-tauri/src/lib.rs');
    assert.match(lib, new RegExp(`fn ${command}[\\s\\S]*?require_app_unlocked\\(&protection\\)\\?;`));
    assert.ok(read('../src-tauri/build.rs').includes(`"${command}"`));
    assert.ok(read('../src-tauri/capabilities/main.json').includes(`"allow-${command.replaceAll('_', '-')}"`));
  }
});

test('APNs and WSS forward actual receipt through the common incoming wake without invented transactions', () => {
  const bridge = read('../../../native/desktop-bridge/cpp/DesktopNotificationsMac.mm');
  assert.match(bridge, /willPresentNotification:[\s\S]*?captureApnsEvent\(notification\.request\.content\.userInfo, false\)/);
  assert.match(bridge, /g_apns_received_events\.emplace_back/);
  assert.match(bridge, /tex8_desktop_apns_take_received_event/);
  const daemon = read('../src-tauri/src/bin/monero-fast-walletd.rs');
  assert.match(daemon, /forward_received_event\(config_path, &message\.event\)\?;\s*show_notification[\s\S]*?acknowledge_event/);
  assert.match(daemon, /\.join\("received-events"\)/);
  assert.match(daemon, /opened: false/);
  const app = read('../src/App.tsx');
  const consume = app.slice(app.indexOf('const consume = () =>'), app.indexOf('}, [appProtection?.configured, appProtection?.locked]'));
  assert.match(consume, /event\.category === 'monero\.fast_wallet\.incoming' \|\| event\.category === 'monero\.fast_wallet\.test'/);
  assert.match(consume, /if \(event\.opened\) setSection\('home'\)/);
  assert.match(consume, /mfw-wallet-notification-wake/);
  assert.doesNotMatch(consume, /amountAtomic|setBalance|transactions\.push|start_refresh/);
  const diagnostics = read('../src-tauri/src/diagnostics.rs');
  for (const name of ['pushTestEventId', 'scheduledAt', 'deliverAfter']) assert.ok(diagnostics.includes(`"${name}"`));
});
