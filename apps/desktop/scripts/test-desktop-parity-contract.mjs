import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import test from 'node:test';

const here = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(here, '..');
const repoRoot = resolve(desktopRoot, '..', '..');

const appSource = readFileSync(resolve(desktopRoot, 'src', 'App.tsx'), 'utf8');
const parityDoc = readFileSync(resolve(repoRoot, 'docs', 'DESKTOP_PARITY_MATRIX.md'), 'utf8');

test('desktop primary navigation matches the mobile bottom menu contract', () => {
  const primaryMatch = appSource.match(/function primarySections[\s\S]*?return \[([\s\S]*?)\];\s*}/);
  assert.ok(primaryMatch, 'primarySections() must stay explicit and reviewable');

  const ids = [...primaryMatch[1].matchAll(/id: '([^']+)'/g)].map((match) => match[1]);
  assert.deepEqual(ids, ['home', 'send', 'receive', 'community', 'menu']);
});

test('desktop does not expose removed Modules or standalone Fast navigation', () => {
  const primaryMatch = appSource.match(/function primarySections[\s\S]*?return \[([\s\S]*?)\];\s*}/);
  assert.ok(primaryMatch);
  assert.equal(/id: 'fast'/.test(primaryMatch[1]), false);
  assert.equal(/id: 'modules'/.test(primaryMatch[1]), false);
  assert.equal(/\bModules\b/.test(parityDoc), false);
  assert.equal(/\|\s*Fast Wallet\s*\|\s*Fast\s*\|/.test(parityDoc), false);
});

test('desktop parity document records closed-app notification preparation truthfully', () => {
  assert.match(parityDoc, /APNs\/WNS\/Linux-agent adapters/);
  assert.match(parityDoc, /live closed-app delivery remain release gates/);
  assert.equal(/while app is open implemented; APNs closed-app delivery remains/.test(parityDoc), false);
});
