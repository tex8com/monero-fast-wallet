import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

const root = resolve(import.meta.dirname, '..');

test('release SBOM is locked, deterministic, bounded, and valid SPDX 2.3 JSON', () => {
  const directory = mkdtempSync(join(tmpdir(), 'mfw-sbom-test-'));
  try {
    const first = join(directory, 'first.spdx.json');
    const second = join(directory, 'second.spdx.json');
    for (const output of [first, second]) {
      execFileSync(
        process.execPath,
        [resolve(root, 'scripts/generate-release-sbom.mjs'), output],
        {
          cwd: root,
          env: { ...process.env, SOURCE_DATE_EPOCH: '1' },
          stdio: 'pipe',
        },
      );
    }

    const firstBytes = readFileSync(first);
    const secondBytes = readFileSync(second);
    assert.deepEqual(firstBytes, secondBytes);
    assert.ok(firstBytes.length < 5 * 1024 * 1024);
    assert.equal(statSync(first).mode & 0o777, 0o600);

    const document = JSON.parse(firstBytes);
    assert.equal(document.spdxVersion, 'SPDX-2.3');
    assert.equal(document.dataLicense, 'CC0-1.0');
    assert.equal(document.creationInfo.created, '1970-01-01T00:00:01.000Z');
    assert.ok(document.packages.length >= 700);
    assert.equal(
      new Set(document.packages.map(pkg => pkg.SPDXID)).size,
      document.packages.length,
    );
    assert.ok(document.packages.some(pkg => pkg.name === 'fast-wallet-protocol'));
    assert.ok(document.packages.some(pkg => pkg.name === 'react-native'));
    assert.ok(document.packages.some(pkg =>
      pkg.name === 'libPhoneNumber-iOS' &&
      pkg.versionInfo === '1.7.5' &&
      pkg.externalRefs.some(reference =>
        reference.referenceLocator ===
        'pkg:cocoapods/libPhoneNumber-iOS@1.7.5'
      )
    ));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
