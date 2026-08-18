#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve(import.meta.dirname, '..');
const output = resolve(root, process.argv[2] ?? 'build/compliance/sbom.spdx.json');
const sourceDateEpoch = Number(process.env.SOURCE_DATE_EPOCH ?? 0);
const created = new Date(
  Number.isSafeInteger(sourceDateEpoch) && sourceDateEpoch > 0
    ? sourceDateEpoch * 1_000
    : 0,
).toISOString();

const cargoManifests = [
  'apps/desktop/src-tauri/Cargo.toml',
  'backend/enthusiast-discovery/Cargo.toml',
  'backend/fast-wallet-relay/Cargo.toml',
  'backend/fast-wallet-worker/Cargo.toml',
  'backend/mfw-private-directory/Cargo.toml',
  'backend/monero-news/Cargo.toml',
  'backend/notification-gateway/Cargo.toml',
  'backend/notification-registration-adapter/Cargo.toml',
  'backend/fast-wallet-worker/scanner-core/Cargo.toml',
];

const packages = new Map();
for (const manifest of cargoManifests) {
  const metadata = JSON.parse(
    execFileSync(
      'cargo',
      [
        'metadata',
        '--format-version',
        '1',
        '--locked',
        '--manifest-path',
        resolve(root, manifest),
      ],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
    ),
  );
  for (const pkg of metadata.packages) {
    const key = `cargo:${pkg.name}@${pkg.version}`;
    packages.set(key, {
      SPDXID: `SPDXRef-${safeId(key)}`,
      name: pkg.name,
      versionInfo: pkg.version,
      downloadLocation: pkg.source ?? 'NOASSERTION',
      licenseConcluded: 'NOASSERTION',
      licenseDeclared: pkg.license ?? 'NOASSERTION',
      copyrightText: 'NOASSERTION',
      externalRefs: [{
        referenceCategory: 'PACKAGE-MANAGER',
        referenceType: 'purl',
        referenceLocator: `pkg:cargo/${encodeURIComponent(pkg.name)}@${encodeURIComponent(pkg.version)}`,
      }],
    });
  }
}

for (const lockPath of [
  'apps/mobile/package-lock.json',
  'apps/desktop/package-lock.json',
]) {
  const lock = JSON.parse(readFileSync(resolve(root, lockPath), 'utf8'));
  for (const [path, pkg] of Object.entries(lock.packages ?? {})) {
    const name = pkg.name ?? npmPackageNameFromLockPath(path);
    if (!name || !pkg.version) continue;
    const key = `npm:${name}@${pkg.version}`;
    packages.set(key, {
      SPDXID: `SPDXRef-${safeId(key)}`,
      name,
      versionInfo: pkg.version,
      downloadLocation: pkg.resolved ?? 'NOASSERTION',
      licenseConcluded: 'NOASSERTION',
      licenseDeclared: pkg.license ?? 'NOASSERTION',
      copyrightText: 'NOASSERTION',
      externalRefs: [{
        referenceCategory: 'PACKAGE-MANAGER',
        referenceType: 'purl',
        referenceLocator: `pkg:npm/${encodeURIComponent(name)}@${encodeURIComponent(pkg.version)}`,
      }],
    });
  }
}

for (const pod of cocoaPodsFromLock(
  readFileSync(resolve(root, 'apps/mobile/ios/Podfile.lock'), 'utf8'),
)) {
  const key = `cocoapods:${pod.name}@${pod.version}`;
  packages.set(key, {
    SPDXID: `SPDXRef-${safeId(key)}`,
    name: pod.name,
    versionInfo: pod.version,
    downloadLocation: 'NOASSERTION',
    licenseConcluded: 'NOASSERTION',
    licenseDeclared: 'NOASSERTION',
    copyrightText: 'NOASSERTION',
    externalRefs: [{
      referenceCategory: 'PACKAGE-MANAGER',
      referenceType: 'purl',
      referenceLocator: `pkg:cocoapods/${encodeURIComponent(pod.name)}@${encodeURIComponent(pod.version)}`,
    }],
  });
}

const document = {
  spdxVersion: 'SPDX-2.3',
  dataLicense: 'CC0-1.0',
  SPDXID: 'SPDXRef-DOCUMENT',
  name: 'monero-fast-wallet-dependency-sbom',
  documentNamespace: `https://tex8.com/spdx/monero-fast-wallet/source-${sourceDateEpoch || 0}`,
  creationInfo: {
    created,
    creators: ['Tool: scripts/generate-release-sbom.mjs'],
  },
  documentDescribes: [...packages.values()].map(pkg => pkg.SPDXID),
  packages: [...packages.values()].sort((left, right) =>
    left.SPDXID.localeCompare(right.SPDXID),
  ),
};

mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, `${JSON.stringify(document, null, 2)}\n`, {
  mode: 0o600,
});
process.stdout.write(`${pathToFileURL(output)}\n`);

function safeId(value) {
  return value.replace(/[^A-Za-z0-9.-]/g, '-');
}

function npmPackageNameFromLockPath(path) {
  const marker = 'node_modules/';
  const index = path.lastIndexOf(marker);
  if (index < 0) return undefined;
  const parts = path.slice(index + marker.length).split('/');
  if (!parts[0]) return undefined;
  return parts[0].startsWith('@') && parts[1]
    ? `${parts[0]}/${parts[1]}`
    : parts[0];
}

function cocoaPodsFromLock(lock) {
  const podsStart = lock.indexOf('PODS:\n');
  const dependenciesStart = lock.indexOf('\nDEPENDENCIES:\n');
  if (podsStart !== 0 || dependenciesStart < 0) {
    throw new Error('apps/mobile/ios/Podfile.lock has no bounded PODS section');
  }

  const pods = [];
  const section = lock.slice('PODS:\n'.length, dependenciesStart);
  for (const line of section.split('\n')) {
    if (!line.startsWith('  - ') || line.startsWith('    - ')) continue;
    let locked = line.slice(4).replace(/:$/, '');
    if (locked.startsWith('"') && locked.endsWith('"')) {
      locked = JSON.parse(locked);
    }
    const match = locked.match(/^(.+?) \(([^()]+)\)$/);
    if (!match) {
      throw new Error(`Unrecognized locked CocoaPod: ${line}`);
    }
    pods.push({ name: match[1], version: match[2] });
  }
  if (pods.length === 0) {
    throw new Error('apps/mobile/ios/Podfile.lock has no locked CocoaPods');
  }
  return pods;
}
