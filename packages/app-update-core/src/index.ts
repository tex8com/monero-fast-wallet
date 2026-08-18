export type AppUpdatePlatform =
  | 'android'
  | 'ios'
  | 'darwin'
  | 'windows'
  | 'linux';

export type AppUpdateArchitecture =
  | 'universal'
  | 'aarch64'
  | 'x86_64'
  | 'i686'
  | 'armv7';

export type AppUpdateDelivery =
  | 'app-store'
  | 'play-store'
  | 'direct-apk'
  | 'tauri'
  | 'package-manager';

export type AppUpdateArtifact = {
  platform: AppUpdatePlatform;
  architecture: AppUpdateArchitecture;
  delivery: AppUpdateDelivery;
  url: string;
  sha256?: string;
  size?: number;
  signature?: string;
};

export type AppUpdateManifestV1 = {
  schemaVersion: 1;
  appId: string;
  channel: string;
  version: string;
  minimumVersion: string;
  updateId: string;
  publishedAt: string;
  mandatory: boolean;
  rolloutPercentage: number;
  rolloutSalt: string;
  notes?: string;
  artifacts: AppUpdateArtifact[];
};

export type AppUpdateContext = {
  appId: string;
  channel: string;
  currentVersion: string;
  platform: AppUpdatePlatform;
  architecture: AppUpdateArchitecture;
  delivery: AppUpdateDelivery;
  installationId: string;
  allowedHosts: readonly string[];
};

export type AppUpdateOffer = {
  updateId: string;
  version: string;
  currentVersion: string;
  minimumVersion: string;
  mandatory: boolean;
  notes?: string;
  artifact: AppUpdateArtifact;
};

export type AppUpdateProgress = {
  phase: 'checking' | 'downloading' | 'installing' | 'restarting';
  downloadedBytes?: number;
  totalBytes?: number;
};

export type AppUpdateAdapter = {
  check: () => Promise<AppUpdateOffer | null>;
  install: (
    offer: AppUpdateOffer,
    onProgress?: (progress: AppUpdateProgress) => void,
  ) => Promise<void>;
};

export type AppUpdateCoordinatorState =
  | {status: 'idle'}
  | {status: 'checking'}
  | {status: 'current'}
  | {status: 'available'; offer: AppUpdateOffer}
  | {status: 'installing'; offer: AppUpdateOffer}
  | {status: 'installed'; offer: AppUpdateOffer}
  | {status: 'error'; message: string};

const VERSION_PATTERN =
  /^(?:v)?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9._:/-]{1,160}$/;

type ParsedVersion = {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
};

function parseVersion(value: string): ParsedVersion {
  const match = VERSION_PATTERN.exec(value.trim());
  if (!match) {
    throw new Error(`Invalid semantic version: ${value}`);
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4]?.split('.') ?? [],
  };
}

function comparePrerelease(left: string[], right: string[]): number {
  if (left.length === 0 || right.length === 0) {
    return left.length === right.length ? 0 : left.length === 0 ? 1 : -1;
  }
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = left[index];
    const rightPart = right[index];
    if (leftPart === undefined || rightPart === undefined) {
      return leftPart === rightPart ? 0 : leftPart === undefined ? -1 : 1;
    }
    if (leftPart === rightPart) {
      continue;
    }
    const leftNumber = /^\d+$/.test(leftPart);
    const rightNumber = /^\d+$/.test(rightPart);
    if (leftNumber && rightNumber) {
      return Number(leftPart) < Number(rightPart) ? -1 : 1;
    }
    if (leftNumber !== rightNumber) {
      return leftNumber ? -1 : 1;
    }
    return leftPart < rightPart ? -1 : 1;
  }
  return 0;
}

export function compareAppVersions(left: string, right: string): number {
  const leftVersion = parseVersion(left);
  const rightVersion = parseVersion(right);
  for (const key of ['major', 'minor', 'patch'] as const) {
    if (leftVersion[key] !== rightVersion[key]) {
      return leftVersion[key] < rightVersion[key] ? -1 : 1;
    }
  }
  return comparePrerelease(leftVersion.prerelease, rightVersion.prerelease);
}

function requiredString(value: unknown, field: string): string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.includes('\r') ||
    value.includes('\n')
  ) {
    throw new Error(`Invalid update manifest field: ${field}`);
  }
  return value;
}

function requireExactKeys(
  value: object,
  allowedKeys: readonly string[],
  field: string,
): void {
  const allowed = new Set(allowedKeys);
  const unknown = Object.keys(value).find(key => !allowed.has(key));
  if (unknown) {
    throw new Error(`Unknown update ${field} field: ${unknown}`);
  }
}

function parseArtifact(value: unknown): AppUpdateArtifact {
  if (!value || typeof value !== 'object') {
    throw new Error('Invalid update artifact');
  }
  requireExactKeys(
    value,
    [
      'platform',
      'architecture',
      'delivery',
      'url',
      'sha256',
      'size',
      'signature',
    ],
    'artifact',
  );
  const artifact = value as Partial<AppUpdateArtifact>;
  const platform = requiredString(artifact.platform, 'artifact.platform');
  const architecture = requiredString(
    artifact.architecture,
    'artifact.architecture',
  );
  const delivery = requiredString(artifact.delivery, 'artifact.delivery');
  const url = requiredString(artifact.url, 'artifact.url');
  if (
    !['android', 'ios', 'darwin', 'windows', 'linux'].includes(platform) ||
    !['universal', 'aarch64', 'x86_64', 'i686', 'armv7'].includes(
      architecture,
    ) ||
    ![
      'app-store',
      'play-store',
      'direct-apk',
      'tauri',
      'package-manager',
    ].includes(delivery)
  ) {
    throw new Error('Unsupported update artifact target');
  }
  const parsedUrl = new URL(url);
  if (parsedUrl.protocol !== 'https:' || parsedUrl.username || parsedUrl.password) {
    throw new Error('Update artifacts must use credential-free HTTPS URLs');
  }
  if (
    artifact.sha256 !== undefined &&
    (typeof artifact.sha256 !== 'string' ||
      !SHA256_PATTERN.test(artifact.sha256))
  ) {
    throw new Error('Invalid update artifact SHA-256');
  }
  if (
    artifact.size !== undefined &&
    (!Number.isSafeInteger(artifact.size) || artifact.size <= 0)
  ) {
    throw new Error('Invalid update artifact size');
  }
  if (
    artifact.signature !== undefined &&
    (typeof artifact.signature !== 'string' || !artifact.signature.trim())
  ) {
    throw new Error('Invalid update artifact signature');
  }
  return {
    platform: platform as AppUpdatePlatform,
    architecture: architecture as AppUpdateArchitecture,
    delivery: delivery as AppUpdateDelivery,
    url,
    ...(artifact.sha256 ? {sha256: artifact.sha256} : {}),
    ...(artifact.size ? {size: artifact.size} : {}),
    ...(artifact.signature ? {signature: artifact.signature} : {}),
  };
}

export function parseAppUpdateManifest(value: unknown): AppUpdateManifestV1 {
  if (!value || typeof value !== 'object') {
    throw new Error('Invalid update manifest');
  }
  requireExactKeys(
    value,
    [
      'schemaVersion',
      'appId',
      'channel',
      'version',
      'minimumVersion',
      'updateId',
      'publishedAt',
      'mandatory',
      'rolloutPercentage',
      'rolloutSalt',
      'notes',
      'artifacts',
    ],
    'manifest',
  );
  const manifest = value as Partial<AppUpdateManifestV1>;
  if (manifest.schemaVersion !== 1) {
    throw new Error('Unsupported update manifest schema');
  }
  const appId = requiredString(manifest.appId, 'appId');
  const channel = requiredString(manifest.channel, 'channel');
  const version = requiredString(manifest.version, 'version');
  const minimumVersion = requiredString(
    manifest.minimumVersion,
    'minimumVersion',
  );
  const updateId = requiredString(manifest.updateId, 'updateId');
  const publishedAt = requiredString(manifest.publishedAt, 'publishedAt');
  const rolloutSalt = requiredString(manifest.rolloutSalt, 'rolloutSalt');
  parseVersion(version);
  parseVersion(minimumVersion);
  if (compareAppVersions(minimumVersion, version) > 0) {
    throw new Error('Minimum version cannot exceed the offered version');
  }
  if (
    !IDENTIFIER_PATTERN.test(appId) ||
    !IDENTIFIER_PATTERN.test(channel) ||
    !IDENTIFIER_PATTERN.test(updateId) ||
    !IDENTIFIER_PATTERN.test(rolloutSalt)
  ) {
    throw new Error('Unsafe update manifest identifier');
  }
  if (
    typeof manifest.mandatory !== 'boolean' ||
    typeof manifest.rolloutPercentage !== 'number' ||
    !Number.isInteger(manifest.rolloutPercentage) ||
    manifest.rolloutPercentage < 0 ||
    manifest.rolloutPercentage > 100
  ) {
    throw new Error('Invalid update rollout policy');
  }
  if (
    Number.isNaN(Date.parse(publishedAt)) ||
    !Array.isArray(manifest.artifacts) ||
    manifest.artifacts.length === 0
  ) {
    throw new Error('Invalid update manifest metadata');
  }
  if (
    manifest.notes !== undefined &&
    (typeof manifest.notes !== 'string' || manifest.notes.length > 4_000)
  ) {
    throw new Error('Invalid update notes');
  }
  return {
    schemaVersion: 1,
    appId,
    channel,
    version,
    minimumVersion,
    updateId,
    publishedAt,
    mandatory: manifest.mandatory,
    rolloutPercentage: manifest.rolloutPercentage,
    rolloutSalt,
    ...(manifest.notes ? {notes: manifest.notes} : {}),
    artifacts: manifest.artifacts.map(parseArtifact),
  };
}

export function updateRolloutBucket(
  installationId: string,
  updateId: string,
  rolloutSalt: string,
): number {
  const input = `${rolloutSalt}\u0000${updateId}\u0000${installationId}`;
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash % 100;
}

function hostAllowed(url: string, allowedHosts: readonly string[]): boolean {
  const host = new URL(url).hostname.toLowerCase();
  return allowedHosts.some(allowed => host === allowed.toLowerCase());
}

export function selectAppUpdate(
  manifestValue: unknown,
  context: AppUpdateContext,
): AppUpdateOffer | null {
  const manifest = parseAppUpdateManifest(manifestValue);
  if (manifest.appId !== context.appId || manifest.channel !== context.channel) {
    throw new Error('Update manifest does not match this app or channel');
  }
  parseVersion(context.currentVersion);
  if (compareAppVersions(manifest.version, context.currentVersion) <= 0) {
    return null;
  }
  const mandatory =
    manifest.mandatory ||
    compareAppVersions(context.currentVersion, manifest.minimumVersion) < 0;
  const eligible =
    mandatory ||
    updateRolloutBucket(
      context.installationId,
      manifest.updateId,
      manifest.rolloutSalt,
    ) < manifest.rolloutPercentage;
  if (!eligible) {
    return null;
  }
  const artifact = manifest.artifacts.find(
    candidate =>
      candidate.platform === context.platform &&
      (candidate.architecture === context.architecture ||
        candidate.architecture === 'universal') &&
      candidate.delivery === context.delivery &&
      hostAllowed(candidate.url, context.allowedHosts),
  );
  if (!artifact) {
    return null;
  }
  return {
    updateId: manifest.updateId,
    version: manifest.version,
    currentVersion: context.currentVersion,
    minimumVersion: manifest.minimumVersion,
    mandatory,
    ...(manifest.notes ? {notes: manifest.notes} : {}),
    artifact,
  };
}

export function buildAppUpdateManifestUrl(
  endpoint: string,
  context: Pick<
    AppUpdateContext,
    | 'appId'
    | 'channel'
    | 'currentVersion'
    | 'platform'
    | 'architecture'
    | 'allowedHosts'
  >,
): string {
  const url = new URL(endpoint);
  const authenticatedOnion =
    url.protocol === 'http:' && /^[a-z2-7]{56}\.onion$/u.test(url.hostname);
  if (
    (url.protocol !== 'https:' && !authenticatedOnion) ||
    url.username ||
    url.password
  ) {
    throw new Error(
      'Update manifest endpoint must use credential-free HTTPS or Tor v3 Onion',
    );
  }
  if (!hostAllowed(url.toString(), context.allowedHosts)) {
    throw new Error('Update manifest endpoint host is not allowed');
  }
  url.searchParams.set('appId', context.appId);
  url.searchParams.set('channel', context.channel);
  url.searchParams.set('currentVersion', context.currentVersion);
  url.searchParams.set('platform', context.platform);
  url.searchParams.set('architecture', context.architecture);
  return url.toString();
}

export function createAppUpdateCoordinator(
  adapter: AppUpdateAdapter,
  onState?: (state: AppUpdateCoordinatorState) => void,
) {
  let state: AppUpdateCoordinatorState = {status: 'idle'};
  let activeCheck: Promise<AppUpdateOffer | null> | undefined;
  const setState = (next: AppUpdateCoordinatorState) => {
    state = next;
    onState?.(next);
  };

  return {
    getState: () => state,
    check(): Promise<AppUpdateOffer | null> {
      if (activeCheck) {
        return activeCheck;
      }
      setState({status: 'checking'});
      activeCheck = adapter
        .check()
        .then(offer => {
          setState(offer ? {status: 'available', offer} : {status: 'current'});
          return offer;
        })
        .catch(error => {
          setState({
            status: 'error',
            message: error instanceof Error ? error.message : String(error),
          });
          throw error;
        })
        .finally(() => {
          activeCheck = undefined;
        });
      return activeCheck;
    },
    async install(
      offer: AppUpdateOffer,
      onProgress?: (progress: AppUpdateProgress) => void,
    ): Promise<void> {
      setState({status: 'installing', offer});
      try {
        await adapter.install(offer, onProgress);
        setState({status: 'installed', offer});
      } catch (error) {
        setState({
          status: 'error',
          message: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    },
  };
}
