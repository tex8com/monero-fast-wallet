import manifest from "../../../config/v1-release-features.json";

const HEX_32 = /^[0-9a-f]{64}$/;

export type V1ReleaseFeature =
  | "localFastWallet"
  | "automaticFastWalletCreation"
  | "plaintextFastWalletHosting"
  | "ledgerFastWallet"
  | "scannerKeyImageSpendAuthority"
  | "officialWorker"
  | "privateWorkerPairing"
  | "moneroEnthusiastV1"
  | "legacyCommunity"
  | "news"
  | "assistant"
  | "marketplace"
  | "mfwNameResolution"
  | "mfwNameRegistration"
  | "deviceContactDiscovery"
  | "publicLedger";

function readReleaseFeatures(): Readonly<Record<V1ReleaseFeature, boolean>> {
  if (manifest.schemaVersion !== 1 || manifest.profile !== "safe-wallet-v1") {
    throw new Error("Unsupported V1 release feature manifest.");
  }

  const requiredFeatures: V1ReleaseFeature[] = [
    "localFastWallet",
    "automaticFastWalletCreation",
    "plaintextFastWalletHosting",
    "ledgerFastWallet",
    "scannerKeyImageSpendAuthority",
    "officialWorker",
    "privateWorkerPairing",
    "moneroEnthusiastV1",
    "legacyCommunity",
    "news",
    "assistant",
    "marketplace",
    "mfwNameResolution",
    "mfwNameRegistration",
    "deviceContactDiscovery",
    "publicLedger",
  ];

  const features = manifest.features as Record<string, unknown>;
  for (const feature of requiredFeatures) {
    if (typeof features[feature] !== "boolean") {
      throw new Error(`Missing V1 release feature flag: ${feature}`);
    }
  }

  return Object.freeze(features as Record<V1ReleaseFeature, boolean>);
}

/**
 * Immutable, version-controlled release capabilities.
 *
 * Security-sensitive capabilities are deliberately not controlled by renderer
 * state, remote configuration or environment variables. Native command
 * handlers enforce the same boundary independently.
 */
export const v1ReleaseFeatures = readReleaseFeatures();

export type PrivatePhoneEvaluatorReleaseConfig = Readonly<{
  id: string;
  origin: string;
  publicKeyHex: string;
}>;

export type MoneroEnthusiastV1ReleaseConfig = Readonly<{
  apiOrigin: string;
  matrixHomeserver: string;
  catalogOrigin: string;
  catalogScope: string;
  catalogVerifyingKeyHex: string;
  advertisingOrigin: string;
  advertisingVerifyingKeyHex: string;
  advertisingCountry: string;
  artifactVerifyingKeyHex: string;
  artifactManifestResource: string;
  pteResource: string;
  tokenizerResource: string;
  conformanceResource: string;
}>;

/**
 * All five clients consume one pinned Community release configuration.
 * An enabled renderer flag without the complete native trust contract is an
 * invalid release, never a partially working Community mode.
 */
export function moneroEnthusiastV1ReleaseConfig():
  MoneroEnthusiastV1ReleaseConfig | undefined {
  const value = (
    manifest.parameters as {
      moneroEnthusiastV1?: unknown;
    }
  ).moneroEnthusiastV1;
  if (value === null || value === undefined) {
    if (v1ReleaseFeatures.moneroEnthusiastV1) {
      throw new Error("Missing Monero Enthusiast V1 release configuration.");
    }
    return undefined;
  }
  if (!isMoneroEnthusiastV1Config(value)) {
    throw new Error("Invalid Monero Enthusiast V1 release configuration.");
  }
  return Object.freeze({ ...value });
}

export type PrivatePhoneDirectoryReleaseConfig = Readonly<{
  epoch: number;
  verification: Readonly<{
    origin: string;
  }>;
  evaluators: readonly [
    PrivatePhoneEvaluatorReleaseConfig,
    PrivatePhoneEvaluatorReleaseConfig,
  ];
  snapshot: Readonly<{
    origin: string;
    directoryPublicKeyHex: string;
    verificationPublicKeyHex: string;
    maximumBytes: number;
  }>;
}>;

/**
 * Returns only signed, version-controlled trust anchors. Remote configuration,
 * deep links and renderer state cannot replace these origins or public keys.
 */
export function privatePhoneDirectoryReleaseConfig():
  PrivatePhoneDirectoryReleaseConfig | undefined {
  const value = (
    manifest.parameters as {
      privatePhoneDirectory?: unknown;
    }
  ).privatePhoneDirectory;
  if (value === null || value === undefined) {
    return undefined;
  }
  if (!isPrivatePhoneDirectoryConfig(value)) {
    throw new Error("Invalid private phone directory release configuration.");
  }
  const evaluators: PrivatePhoneDirectoryReleaseConfig["evaluators"] =
    Object.freeze([
      Object.freeze({ ...value.evaluators[0] }),
      Object.freeze({ ...value.evaluators[1] }),
    ]);
  return Object.freeze({
    epoch: value.epoch,
    verification: Object.freeze({ ...value.verification }),
    evaluators,
    snapshot: Object.freeze({ ...value.snapshot }),
  });
}

export function requireV1ReleaseFeature(feature: V1ReleaseFeature): void {
  if (!v1ReleaseFeatures[feature]) {
    throw new Error(
      "This feature is not available in the current safe release.",
    );
  }
}

function isPrivatePhoneDirectoryConfig(
  value: unknown,
): value is PrivatePhoneDirectoryReleaseConfig {
  if (!value || typeof value !== "object") return false;
  const config = value as {
    epoch?: unknown;
    verification?: unknown;
    evaluators?: unknown;
    snapshot?: unknown;
  };
  if (
    !Number.isSafeInteger(config.epoch) ||
    (config.epoch as number) < 1 ||
    !Array.isArray(config.evaluators) ||
    config.evaluators.length !== 2
  ) {
    return false;
  }
  if (!config.verification || typeof config.verification !== "object") {
    return false;
  }
  const verification = config.verification as Record<string, unknown>;
  if (!isHttpsOrigin(verification.origin)) {
    return false;
  }
  const evaluators = config.evaluators as Array<Record<string, unknown>>;
  if (
    !evaluators.every(
      (evaluator) =>
        typeof evaluator.id === "string" &&
        evaluator.id.length >= 1 &&
        evaluator.id.length <= 80 &&
        isHttpsOrigin(evaluator.origin) &&
        typeof evaluator.publicKeyHex === "string" &&
        HEX_32.test(evaluator.publicKeyHex),
    ) ||
    evaluators[0].id === evaluators[1].id ||
    evaluators[0].origin === evaluators[1].origin ||
    evaluators[0].publicKeyHex === evaluators[1].publicKeyHex
  ) {
    return false;
  }
  if (!config.snapshot || typeof config.snapshot !== "object") return false;
  const snapshot = config.snapshot as Record<string, unknown>;
  return (
    isHttpsOrigin(snapshot.origin) &&
    typeof snapshot.directoryPublicKeyHex === "string" &&
    HEX_32.test(snapshot.directoryPublicKeyHex) &&
    typeof snapshot.verificationPublicKeyHex === "string" &&
    HEX_32.test(snapshot.verificationPublicKeyHex) &&
    Number.isSafeInteger(snapshot.maximumBytes) &&
    (snapshot.maximumBytes as number) >= 137 &&
    (snapshot.maximumBytes as number) <= 64 * 1024 * 1024
  );
}

function isMoneroEnthusiastV1Config(
  value: unknown,
): value is MoneroEnthusiastV1ReleaseConfig {
  if (!value || typeof value !== "object") return false;
  const config = value as Record<string, unknown>;
  const safeResource = (resource: unknown): resource is string =>
    typeof resource === "string" &&
    resource.length >= 1 &&
    resource.length <= 256 &&
    !resource.startsWith("/") &&
    resource.split("/").every(part => part.length > 0 && part !== "..") &&
    /^[A-Za-z0-9._/-]+$/.test(resource);
  return (
    isHttpsOrigin(config.apiOrigin) &&
    isHttpsOrigin(config.matrixHomeserver) &&
    isHttpsOrigin(config.catalogOrigin) &&
    isHttpsOrigin(config.advertisingOrigin) &&
    typeof config.catalogScope === "string" &&
    /^[A-Za-z0-9_-]{1,128}$/.test(config.catalogScope) &&
    typeof config.catalogVerifyingKeyHex === "string" &&
    HEX_32.test(config.catalogVerifyingKeyHex) &&
    typeof config.advertisingVerifyingKeyHex === "string" &&
    HEX_32.test(config.advertisingVerifyingKeyHex) &&
    typeof config.advertisingCountry === "string" &&
    /^[A-Z]{2}$/.test(config.advertisingCountry) &&
    typeof config.artifactVerifyingKeyHex === "string" &&
    HEX_32.test(config.artifactVerifyingKeyHex) &&
    safeResource(config.artifactManifestResource) &&
    safeResource(config.pteResource) &&
    safeResource(config.tokenizerResource) &&
    safeResource(config.conformanceResource)
  );
}

function isHttpsOrigin(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 200) return false;
  try {
    const parsed = new URL(value);
    return (
      parsed.protocol === "https:" &&
      Boolean(parsed.hostname) &&
      !parsed.username &&
      !parsed.password &&
      parsed.pathname === "/" &&
      !parsed.search &&
      !parsed.hash &&
      value === parsed.origin
    );
  } catch {
    return false;
  }
}
