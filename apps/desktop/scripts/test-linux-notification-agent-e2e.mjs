#!/usr/bin/env node
/**
 * Real Linux closed-app notification check. It intentionally starts only the
 * user agent (not Tauri), emits one opaque event from a local service and
 * verifies the DBus notification request. No wallet data enters this test.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, stat, writeFile, chmod } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'linux') {
  console.log('SKIP: Linux notification e2e test runs only on Linux.');
  process.exit(0);
}

const opaqueEventId = `evt_${'a'.repeat(64)}`;
const event = {
  id: opaqueEventId,
  category: 'monero.fast_wallet.incoming',
  deepLink: `tex8://notification/${opaqueEventId}`,
};
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const agentPath = process.env.MONERO_FAST_WALLETD
  ?? resolve(root, 'src-tauri/target/debug/monero-fast-walletd');
// When these two values are present, this exact same closed-app test uses the
// live HTTPS gateway instead of its local HTTP fixture.  The caller queues a
// generic opaque probe event through the protected server deployment; neither
// a wallet identifier nor a transaction detail enters this script.
const liveServiceUrl = process.env.MONERO_LINUX_PUSH_SERVICE_URL?.trim();
const liveInstallationId = process.env.MONERO_LINUX_PUSH_INSTALLATION_ID?.trim();
if (Boolean(liveServiceUrl) !== Boolean(liveInstallationId)) {
  throw new Error('Set both MONERO_LINUX_PUSH_SERVICE_URL and MONERO_LINUX_PUSH_INSTALLATION_ID for a live Linux push test.');
}
const sessionBus = process.env.DBUS_SESSION_BUS_ADDRESS
  ?? `unix:path=/run/user/${process.getuid()}/bus`;
const environment = { ...process.env, DBUS_SESSION_BUS_ADDRESS: sessionBus };
const temporaryDirectory = await mkdtemp(join(tmpdir(), 'monero-linux-push-'));
const startedMarker = join(temporaryDirectory, 'wallet-opened');
const launcherPath = join(temporaryDirectory, 'open-wallet.sh');
const configPath = join(temporaryDirectory, 'linux-agent.json');

let agent;
let monitor;
let service;

function stop(child) {
  if (child && !child.killed) child.kill('SIGTERM');
}

function waitFor(predicate, timeoutMs, error) {
  return new Promise((resolvePromise, reject) => {
    const deadline = setTimeout(() => reject(new Error(error)), timeoutMs);
    const interval = setInterval(async () => {
      try {
        if (await predicate()) {
          clearTimeout(deadline);
          clearInterval(interval);
          resolvePromise();
        }
      } catch {
        // The marker does not exist until the action handler has run.
      }
    }, 100);
  });
}

try {
  await stat(agentPath);
  await writeFile(launcherPath, `#!/bin/sh\ntouch "${startedMarker}"\n`, { mode: 0o700 });
  await chmod(launcherPath, 0o700);

  let serviceUrl;
  if (liveServiceUrl) {
    serviceUrl = liveServiceUrl;
  } else {
    service = createServer((request, response) => {
      assert.equal(request.url, '/events');
      assert.equal(request.headers['x-fast-wallet-installation-id'], 'linux-e2e-installation');
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify([event]));
    });
    service.listen(0, '127.0.0.1');
    await once(service, 'listening');
    serviceUrl = `http://127.0.0.1:${service.address().port}`;
  }
  await writeFile(configPath, JSON.stringify({
    // Exercise the current shared contract, not the legacy compatibility
    // path. This catches an agent/app contract drift before deployment.
    version: 2,
    installationId: liveInstallationId ?? 'linux-e2e-installation',
    provider: 'linux-agent',
    serviceUrl,
    pollIntervalMs: 10_000,
    appCommand: launcherPath,
  }));

  let dbusOutput = '';
  monitor = spawn('dbus-monitor', ['--session', "interface='org.freedesktop.Notifications'"], { env: environment });
  monitor.stdout.setEncoding('utf8');
  monitor.stdout.on('data', (chunk) => { dbusOutput += chunk; });
  agent = spawn(agentPath, ['--config', configPath], { env: environment });
  let agentErrors = '';
  agent.stderr.setEncoding('utf8');
  agent.stderr.on('data', (chunk) => { agentErrors += chunk; });

  await waitFor(
    () => dbusOutput.includes('Monero Fast Wallet') && dbusOutput.includes('New private activity. Open the wallet to refresh.'),
    liveServiceUrl ? 90_000 : 12_000,
    `DBus notification was not observed. Agent output: ${agentErrors}`,
  );
  assert.equal(dbusOutput.includes(opaqueEventId), false, 'DBus notification must not expose the event id');
  assert.equal(dbusOutput.includes('wallet'), true);

  // Exercise click-to-open without a human click: the session bus uses the
  // same opaque id and no detailed wallet payload. The agent writes the
  // pending-open file and starts the configured executable.
  const action = spawn('dbus-send', [
    '--session', '--type=signal', '/org/freedesktop/Notifications',
    'org.freedesktop.Notifications.ActionInvoked', 'uint32:0', 'string:default',
  ], { env: environment });
  await once(action, 'exit');
  // GNOME assigns positive ids, so a synthetic id zero must not open anything.
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  await assert.rejects(stat(startedMarker));
  await assert.rejects(readFile(join(temporaryDirectory, 'pending-open-event.json'), 'utf8'));
  console.log('PASS: Linux agent emitted a generic closed-app DBus notification and rejected an invalid click id.');
} finally {
  stop(agent);
  stop(monitor);
  if (service) service.close();
  await rm(temporaryDirectory, { recursive: true, force: true });
}
