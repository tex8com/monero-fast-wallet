import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildAppUpdateManifestUrl,
  compareAppVersions,
  createAppUpdateCoordinator,
  parseAppUpdateManifest,
  selectAppUpdate,
  updateRolloutBucket,
  type AppUpdateContext,
  type AppUpdateManifestV1,
} from '../src/index.ts';

const manifest: AppUpdateManifestV1 = {
  schemaVersion: 1,
  appId: 'com.tex8.monerowallet',
  channel: 'stable',
  version: '1.2.0',
  minimumVersion: '1.0.5',
  updateId: 'mfw-1.2.0',
  publishedAt: '2026-07-28T12:00:00.000Z',
  mandatory: false,
  rolloutPercentage: 100,
  rolloutSalt: 'stable-2026',
  notes: 'Security and performance update.',
  artifacts: [
    {
      platform: 'android',
      architecture: 'universal',
      delivery: 'direct-apk',
      url: 'https://tex8.com/xmr.apk',
      sha256: 'a'.repeat(64),
      size: 64_000_000,
    },
    {
      platform: 'darwin',
      architecture: 'aarch64',
      delivery: 'tauri',
      url: 'https://tex8.com/xmr/updates/mfw.app.tar.gz',
      signature: 'minisign-signature',
    },
  ],
};

const androidContext: AppUpdateContext = {
  appId: 'com.tex8.monerowallet',
  channel: 'stable',
  currentVersion: '1.0.9',
  platform: 'android',
  architecture: 'aarch64',
  delivery: 'direct-apk',
  installationId: 'install-a',
  allowedHosts: ['tex8.com'],
};

test('compares release and prerelease semantic versions', () => {
  assert.equal(compareAppVersions('1.0.9', '1.0.10'), -1);
  assert.equal(compareAppVersions('v2.0.0', '1.9.9'), 1);
  assert.equal(compareAppVersions('1.2.0-beta.2', '1.2.0-beta.11'), -1);
  assert.equal(compareAppVersions('1.2.0', '1.2.0-rc.1'), 1);
});

test('rejects malformed manifests and insecure artifact URLs', () => {
  assert.throws(() => parseAppUpdateManifest({...manifest, schemaVersion: 2}));
  assert.throws(() =>
    parseAppUpdateManifest({
      ...manifest,
      artifacts: [{...manifest.artifacts[0], url: 'http://tex8.com/xmr.apk'}],
    }),
  );
  assert.throws(() =>
    parseAppUpdateManifest({
      ...manifest,
      artifacts: [{...manifest.artifacts[0], sha256: 'not-a-hash'}],
    }),
  );
  assert.throws(() =>
    parseAppUpdateManifest({...manifest, unexpectedPolicy: true}),
  );
  assert.throws(() =>
    parseAppUpdateManifest({
      ...manifest,
      artifacts: [{...manifest.artifacts[0], executable: true}],
    }),
  );
  assert.throws(() =>
    parseAppUpdateManifest({...manifest, minimumVersion: '2.0.0'}),
  );
});

test('selects only matching app, channel, platform, delivery and host', () => {
  const offer = selectAppUpdate(manifest, androidContext);
  assert.equal(offer?.version, '1.2.0');
  assert.equal(offer?.artifact.delivery, 'direct-apk');
  assert.throws(() =>
    selectAppUpdate(manifest, {...androidContext, appId: 'other.app'}),
  );
  assert.equal(
    selectAppUpdate(manifest, {
      ...androidContext,
      allowedHosts: ['attacker.example'],
    }),
    null,
  );
});

test('does not offer the current or an older release', () => {
  assert.equal(
    selectAppUpdate({...manifest, version: '1.0.9'}, androidContext),
    null,
  );
  assert.equal(
    selectAppUpdate(
      {...manifest, version: '0.9.0', minimumVersion: '0.8.0'},
      androidContext,
    ),
    null,
  );
});

test('minimum version makes an otherwise optional release mandatory', () => {
  const offer = selectAppUpdate(
    {...manifest, minimumVersion: '1.1.0', rolloutPercentage: 0},
    androidContext,
  );
  assert.equal(offer?.mandatory, true);
});

test('rollout assignment is deterministic and stays in range', () => {
  const first = updateRolloutBucket('install-a', 'update-a', 'salt-a');
  const second = updateRolloutBucket('install-a', 'update-a', 'salt-a');
  assert.equal(first, second);
  assert.ok(first >= 0 && first < 100);
  assert.equal(
    selectAppUpdate({...manifest, rolloutPercentage: 0}, androidContext),
    null,
  );
});

test('mandatory releases bypass staged rollout', () => {
  const offer = selectAppUpdate(
    {...manifest, rolloutPercentage: 0, mandatory: true},
    androidContext,
  );
  assert.equal(offer?.mandatory, true);
});

test('builds a credential-free HTTPS manifest request', () => {
  const url = new URL(
    buildAppUpdateManifestUrl('https://tex8.com/xmr/update.json', androidContext),
  );
  assert.equal(url.searchParams.get('currentVersion'), '1.0.9');
  assert.equal(url.searchParams.get('platform'), 'android');
  assert.throws(() =>
    buildAppUpdateManifestUrl('http://tex8.com/update.json', androidContext),
  );
  assert.throws(() =>
    buildAppUpdateManifestUrl(
      'https://user:secret@tex8.com/update.json',
      androidContext,
    ),
  );
  assert.throws(() =>
    buildAppUpdateManifestUrl(
      'https://attacker.example/update.json',
      androidContext,
    ),
  );
});

test('coordinator deduplicates concurrent checks and records lifecycle', async () => {
  let checks = 0;
  const states: string[] = [];
  const coordinator = createAppUpdateCoordinator(
    {
      check: async () => {
        checks += 1;
        await Promise.resolve();
        return selectAppUpdate(manifest, androidContext);
      },
      install: async () => undefined,
    },
    state => states.push(state.status),
  );
  const [left, right] = await Promise.all([
    coordinator.check(),
    coordinator.check(),
  ]);
  assert.equal(checks, 1);
  assert.equal(left?.updateId, right?.updateId);
  assert.deepEqual(states, ['checking', 'available']);
  await coordinator.install(left!);
  assert.equal(coordinator.getState().status, 'installed');
});
