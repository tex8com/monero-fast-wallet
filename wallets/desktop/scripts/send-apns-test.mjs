#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';
import http2 from 'node:http2';
import os from 'node:os';
import path from 'node:path';

const desktopDir = path.resolve(import.meta.dirname, '..');
const envPath = process.env.MONERO_APNS_ENV_FILE ?? path.join(desktopDir, '.env.apns.local');
const installationPath = process.env.MONERO_APNS_INSTALLATION_PATH ?? path.join(
  os.homedir(),
  'Library',
  'Application Support',
  'com.tex8.monerowallet.desktop',
  'notifications',
  'desktop-installation.json',
);

function parseEnv(source) {
  return Object.fromEntries(
    source
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'))
      .map((line) => {
        const separator = line.indexOf('=');
        if (separator < 1) return [line, ''];
        const key = line.slice(0, separator).trim();
        const value = line.slice(separator + 1).trim().replace(/^['"]|['"]$/gu, '');
        return [key, value];
      }),
  );
}

function requireValue(config, key) {
  const value = config[key];
  if (!value) throw new Error(`${key} is missing in ${envPath}.`);
  return value;
}

function loadToken() {
  const flagIndex = process.argv.indexOf('--token');
  if (flagIndex !== -1) return process.argv[flagIndex + 1]?.trim();
  const installation = JSON.parse(fs.readFileSync(installationPath, 'utf8'));
  return installation.endpoint?.trim();
}

function createJwt(teamId, keyId, authKey) {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'ES256', kid: keyId })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ iss: teamId, iat: now })).toString('base64url');
  const unsigned = `${header}.${payload}`;
  const signer = crypto.createSign('sha256');
  signer.update(unsigned);
  signer.end();
  const signature = signer.sign({ key: authKey, dsaEncoding: 'ieee-p1363' }).toString('base64url');
  return `${unsigned}.${signature}`;
}

async function send() {
  const config = parseEnv(fs.readFileSync(envPath, 'utf8'));
  const token = loadToken();
  if (!token || !/^[a-f0-9]{32,256}$/iu.test(token)) {
    throw new Error('No valid APNs device token is available. Open the signed desktop app once first.');
  }

  const teamId = requireValue(config, 'APNS_TEAM_ID');
  const keyId = requireValue(config, 'APNS_KEY_ID');
  const bundleId = requireValue(config, 'APNS_BUNDLE_ID');
  const environment = config.APNS_ENVIRONMENT === 'production' ? 'production' : 'development';
  const authKey = fs.readFileSync(requireValue(config, 'APNS_AUTH_KEY_PATH'), 'utf8');
  const host = environment === 'production' ? 'api.push.apple.com' : 'api.sandbox.push.apple.com';
  const payload = JSON.stringify({
    aps: {
      alert: {
        title: 'Monero Fast Wallet',
        body: 'Push notifications are working securely.',
      },
      sound: 'default',
    },
    type: 'monero.fast-wallet.test',
    contractVersion: 'monero-fast-wallet-push.v2',
    eventId: `fwpush_test_${Date.now()}`,
  });

  const jwt = createJwt(teamId, keyId, authKey);
  const client = http2.connect(`https://${host}`, { servername: host });
  const response = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('APNs request timed out.')), 20_000);
    const request = client.request({
      ':method': 'POST',
      ':path': `/3/device/${token}`,
      authorization: `bearer ${jwt}`,
      'apns-topic': bundleId,
      'apns-push-type': 'alert',
      'apns-priority': '10',
    });
    let body = '';
    request.setEncoding('utf8');
    request.on('response', (headers) => {
      request.on('data', (chunk) => { body += chunk; });
      request.on('end', () => {
        clearTimeout(timeout);
        resolve({ status: Number(headers[':status']), apnsId: headers['apns-id'], body });
      });
    });
    request.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    request.end(payload);
  });
  client.close();

  const result = response;
  if (result.status !== 200) {
    throw new Error(`APNs rejected the test (${result.status}): ${result.body || 'no reason supplied'}`);
  }
  console.log(`APNs accepted the closed-app test notification (status=200, apns-id=${result.apnsId ?? 'unknown'}).`);
}

send().catch((error) => {
  console.error(`APNs test failed: ${error.message}`);
  process.exitCode = 1;
});
