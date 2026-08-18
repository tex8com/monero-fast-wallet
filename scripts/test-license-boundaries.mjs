import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

const root = resolve(import.meta.dirname, '..');
const read = path => readFileSync(resolve(root, path), 'utf8');

function cargoLicense(path) {
  const manifest = read(path);
  const packageBlock = manifest.match(/\[package\]([\s\S]*?)(?:\n\[|$)/)?.[1] ?? '';
  return packageBlock.match(/^\s*license\s*=\s*"([^"]+)"/m)?.[1];
}

test('root multi-license grant includes every complete standard text', () => {
  const license = read('LICENSE');
  const map = read('LICENSES/README.md');
  assert.match(license, /apps\/` and `packages\/`: Mozilla Public License 2\.0/);
  assert.match(license, /services\/`: GNU Affero General Public License version 3 only/);
  assert.match(license, /Apache-2\.0 OR MIT/);
  assert.match(map, /upstream Monero or Cuprate/);

  const expected = new Map([
    ['LICENSES/MPL-2.0.txt', /Mozilla Public License Version 2\.0/],
    ['LICENSES/AGPL-3.0-only.txt', /GNU AFFERO GENERAL PUBLIC LICENSE/],
    ['LICENSES/Apache-2.0.txt', /Apache License/],
    ['LICENSES/MIT.txt', /MIT License/],
    ['LICENSES/BSD-3-Clause.txt', /BSD 3-Clause License/],
  ]);
  for (const [path, marker] of expected) {
    assert.ok(existsSync(resolve(root, path)), `${path} is missing`);
    assert.match(read(path), marker);
  }
  assert.match(read('THIRD_PARTY_NOTICES.md'), /Monero/);
  assert.match(read('THIRD_PARTY_NOTICES.md'), /Cuprate/);
  assert.match(read('THIRD_PARTY_NOTICES.md'), /libPhoneNumber-iOS/);
  assert.match(read('THIRD_PARTY_NOTICES.md'), /Apache License 2\.0/);
});

test('every project-authored hosted service is AGPL-3.0-only', () => {
  const services = readdirSync(resolve(root, 'services'), { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => `backend/${entry.name}/Cargo.toml`)
    .filter(path => existsSync(resolve(root, path)));
  assert.ok(services.length >= 8);
  for (const manifest of services) {
    assert.equal(cargoLicense(manifest), 'AGPL-3.0-only', manifest);
  }
});

test('project protocol crates and user apps declare their intended grants', () => {
  for (const manifest of [
    'native/fast-wallet-protocol/Cargo.toml',
    'native/mfw-recipient-protocol/Cargo.toml',
    'native/scanpack-format/Cargo.toml',
  ]) {
    assert.equal(cargoLicense(manifest), 'MIT OR Apache-2.0', manifest);
  }
  assert.equal(cargoLicense('apps/desktop/src-tauri/Cargo.toml'), 'MPL-2.0');
  assert.equal(JSON.parse(read('apps/mobile/package.json')).license, 'MPL-2.0');
  assert.equal(JSON.parse(read('apps/desktop/package.json')).license, 'MPL-2.0');
});

test('upstream license boundaries remain present and explicit', () => {
  for (const path of [
    'node/mfn-monero-fast-node/LICENSE',
    'node/mfn-monero-fast-node/LICENSE-AGPL',
    'node/mfn-monero-fast-node/LICENSE-MIT',
  ]) {
    assert.ok(existsSync(resolve(root, path)), `${path} is missing`);
  }
  assert.match(read('LICENSE'), /third_party/);
  assert.match(read('LICENSE'), /Monero's upstream BSD-3-Clause/);
});
