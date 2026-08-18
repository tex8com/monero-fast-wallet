const MAX_RESPONSE_BYTES = 16 * 1024;
const MAX_SUGGESTION_RESPONSE_BYTES = 4 * 1024;
const MAX_NAME_SUGGESTIONS = 5;
const HEX_32 = /^[0-9a-f]{64}$/;
const RECORD_HEX = /^[0-9a-f]{180,304}$/;

export const MFW_RESOLVER_PATH = "/v1/mfw/names/";
export const MFW_SUGGESTION_PATH = "/v1/mfw/name-suggestions/";
export const MFW_PUBLIC_REGISTRATION_TRACKER_PATH = "/mfw-registration-tracking.json";
export const MONERO_TARGET_BLOCK_TIME_MS = 2 * 60 * 1000;

/**
 * Calendar expiry is deliberately only an estimate. The Registry protocol is
 * authoritative at expiryHeight; Monero targets one block every two minutes.
 */
export function estimateMfwExpiryTimestampMs(
  expiryHeight,
  chainTipHeight,
  observedAtMs = Date.now(),
) {
  if (
    !safeHeight(expiryHeight) ||
    expiryHeight === 0 ||
    !safeHeight(chainTipHeight) ||
    !Number.isFinite(observedAtMs)
  ) {
    return undefined;
  }
  const estimatedAtMs =
    observedAtMs +
    (expiryHeight - chainTipHeight) * MONERO_TARGET_BLOCK_TIME_MS;
  return Number.isFinite(estimatedAtMs) &&
    estimatedAtMs >= -8_640_000_000_000_000 &&
    estimatedAtMs <= 8_640_000_000_000_000
    ? estimatedAtMs
    : undefined;
}

export function canonicalMfwName(input) {
  const normalized = String(input ?? "").trim().toLowerCase();
  const label = normalized.endsWith(".mfw") ? normalized.slice(0, -4) : normalized;
  if (
    label.length < 1 ||
    label.length > 63 ||
    label.startsWith("-") ||
    label.endsWith("-") ||
    !/^[a-z0-9-]+$/.test(label)
  ) {
    throw new Error("invalid_name");
  }
  return `${label}.mfw`;
}

export function mfwNameSuggestionPrefix(input) {
  const normalized = String(input ?? "").trim().toLowerCase();
  const label = normalized.endsWith(".mfw") ? normalized.slice(0, -4) : normalized;
  if (
    label.length < 3 ||
    label.length > 63 ||
    label.startsWith("-") ||
    label.endsWith("-") ||
    !/^[a-z0-9-]+$/.test(label)
  ) {
    return undefined;
  }
  return label;
}

export async function lookupMfwNameSuggestions(input, options = {}) {
  const prefix = mfwNameSuggestionPrefix(input);
  if (!prefix) throw new Error("invalid_suggestion_prefix");
  const fetcher = options.fetcher ?? globalThis.fetch;
  if (typeof fetcher !== "function") throw new Error("transport_unavailable");
  const response = await fetcher(`${MFW_SUGGESTION_PATH}${encodeURIComponent(prefix)}`, {
    method: "GET",
    headers: { Accept: "application/json" },
    cache: "no-store",
    signal: options.signal,
  });
  if (!response.ok) throw new Error(`suggestion_http_${response.status}`);
  const body = await response.text();
  if (!body || new TextEncoder().encode(body).byteLength > MAX_SUGGESTION_RESPONSE_BYTES) {
    throw new Error("invalid_suggestion_size");
  }
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error("invalid_suggestion_response");
  }
  return parseMfwNameSuggestions(parsed, prefix);
}

export function parseMfwNameSuggestions(value, expectedPrefix) {
  if (
    !isPlainObject(value) ||
    !sameKeys(value, ["names", "prefix"]) ||
    value.prefix !== expectedPrefix ||
    !Array.isArray(value.names) ||
    value.names.length > MAX_NAME_SUGGESTIONS
  ) {
    throw new Error("invalid_suggestion_response");
  }
  const names = [];
  for (const candidate of value.names) {
    let canonical;
    try {
      canonical = canonicalMfwName(candidate);
    } catch {
      throw new Error("invalid_suggestion_response");
    }
    if (
      candidate !== canonical ||
      !candidate.startsWith(expectedPrefix) ||
      names.includes(candidate)
    ) {
      throw new Error("invalid_suggestion_response");
    }
    names.push(candidate);
  }
  return { prefix: expectedPrefix, names };
}

export async function lookupMfwName(input, options = {}) {
  const canonicalName = canonicalMfwName(input);
  const fetcher = options.fetcher ?? globalThis.fetch;
  if (typeof fetcher !== "function") throw new Error("transport_unavailable");
  const response = await fetcher(`${MFW_RESOLVER_PATH}${encodeURIComponent(canonicalName)}`, {
    method: "GET",
    headers: { Accept: "application/json" },
    cache: "no-store",
    signal: options.signal,
  });
  if (!response.ok) throw new Error(`resolver_http_${response.status}`);
  const body = await response.text();
  if (!body || new TextEncoder().encode(body).byteLength > MAX_RESPONSE_BYTES) {
    throw new Error("invalid_response_size");
  }
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error("invalid_response");
  }
  return parseMfwResolution(parsed, canonicalName);
}

/**
 * A COMMIT deliberately does not reveal its name. Owners may explicitly
 * publish the name-to-COMMIT association in this display-only tracker. It is
 * never used by wallets to decide whether a name is available or payable.
 */
export async function lookupPublishedMfwRegistration(input, options = {}) {
  const canonicalName = canonicalMfwName(input);
  const fetcher = options.fetcher ?? globalThis.fetch;
  if (typeof fetcher !== "function") throw new Error("transport_unavailable");
  const response = await fetcher(MFW_PUBLIC_REGISTRATION_TRACKER_PATH, {
    method: "GET",
    headers: { Accept: "application/json" },
    cache: "no-store",
    signal: options.signal,
  });
  if (!response.ok) throw new Error(`tracker_http_${response.status}`);
  const body = await response.text();
  if (!body || new TextEncoder().encode(body).byteLength > MAX_RESPONSE_BYTES) {
    throw new Error("invalid_tracker_size");
  }
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error("invalid_tracker");
  }
  return parsePublishedMfwRegistration(parsed, canonicalName);
}

export function parsePublishedMfwRegistration(value, expectedName) {
  if (
    !isPlainObject(value) ||
    !sameKeys(value, ["registrations", "schema"]) ||
    value.schema !== 1 ||
    !Array.isArray(value.registrations) ||
    value.registrations.length > 100
  ) {
    throw new Error("invalid_tracker");
  }
  let match;
  for (const entry of value.registrations) {
    if (
      !isPlainObject(entry) ||
      !sameKeys(entry, [
        "canonicalName",
        "commitHeight",
        "commitTxidHex",
        "claimTxidHex",
        "minimumClaimConfirmations",
        "revealWindowConfirmations",
      ]) ||
      canonicalMfwName(entry.canonicalName) !== entry.canonicalName ||
      !HEX_32.test(entry.commitTxidHex) ||
      (entry.claimTxidHex !== "" && !HEX_32.test(entry.claimTxidHex)) ||
      !safeHeight(entry.commitHeight) ||
      entry.commitHeight < 1 ||
      !safeHeight(entry.minimumClaimConfirmations) ||
      entry.minimumClaimConfirmations < 1 ||
      !safeHeight(entry.revealWindowConfirmations) ||
      entry.revealWindowConfirmations <= entry.minimumClaimConfirmations
    ) {
      throw new Error("invalid_tracker_entry");
    }
    if (entry.canonicalName === expectedName) {
      if (match) throw new Error("duplicate_tracker_entry");
      match = entry;
    }
  }
  return match;
}

export function publishedRegistrationProgress(resolution, registration) {
  if (!registration || resolution.status !== "not_found") return undefined;
  if (resolution.chainTipHeight < registration.commitHeight) return undefined;
  const confirmations = resolution.chainTipHeight - registration.commitHeight + 1;
  const revealDeadlineHeight =
    registration.commitHeight + registration.revealWindowConfirmations - 1;
  return {
    confirmations,
    revealDeadlineHeight,
    stage:
      registration.claimTxidHex !== ""
        ? "claim_broadcast"
        : confirmations < registration.minimumClaimConfirmations
        ? "commit_pending"
        : confirmations <= registration.revealWindowConfirmations
          ? "claim_ready"
          : "commit_expired",
  };
}

export function availabilityFromResolution(resolution) {
  switch (resolution.status) {
    case "not_found":
      return { kind: "available", canonicalName: resolution.canonicalName, resolution };
    case "expired":
      return { kind: "available_again", canonicalName: resolution.canonicalName, resolution };
    case "reserved":
      return { kind: "reserved", canonicalName: resolution.canonicalName, resolution };
    case "provisional":
      return { kind: "pending", canonicalName: resolution.canonicalName, resolution };
    case "finalized":
      return { kind: "taken", canonicalName: resolution.canonicalName, resolution };
    default:
      throw new Error("unsupported_status");
  }
}

export function parseMfwResolution(value, expectedName) {
  const keys = [
    "addressKind",
    "canonicalName",
    "chainTipHashHex",
    "chainTipHeight",
    "confirmations",
    "expiryHeight",
    "network",
    "publicSpendKeyHex",
    "publicViewKeyHex",
    "recordBlockHashHex",
    "recordHeight",
    "recordPayloadHex",
    "sourceTxidHex",
    "status",
  ];
  if (!isPlainObject(value) || !sameKeys(value, keys)) throw new Error("invalid_response");
  if (
    value.canonicalName !== expectedName ||
    value.network !== "mainnet" ||
    !["not_found", "reserved", "provisional", "finalized", "expired"].includes(value.status) ||
    (value.addressKind !== 0 && value.addressKind !== 1) ||
    !safeHeight(value.recordHeight) ||
    !safeHeight(value.expiryHeight) ||
    !safeHeight(value.chainTipHeight) ||
    !safeHeight(value.confirmations) ||
    !HEX_32.test(value.chainTipHashHex)
  ) {
    throw new Error("invalid_response");
  }

  const emptyStatus = value.status === "not_found" || value.status === "reserved";
  if (emptyStatus) {
    if (
      value.addressKind !== 0 ||
      value.publicSpendKeyHex !== "" ||
      value.publicViewKeyHex !== "" ||
      value.recordHeight !== 0 ||
      value.sourceTxidHex !== "" ||
      value.expiryHeight !== 0 ||
      value.confirmations !== 0 ||
      value.recordPayloadHex !== "" ||
      value.recordBlockHashHex !== ""
    ) {
      throw new Error("invalid_empty_record");
    }
    return value;
  }

  if (
    !HEX_32.test(value.publicSpendKeyHex) ||
    !HEX_32.test(value.publicViewKeyHex) ||
    !HEX_32.test(value.sourceTxidHex) ||
    !HEX_32.test(value.recordBlockHashHex) ||
    !RECORD_HEX.test(value.recordPayloadHex) ||
    value.recordPayloadHex.length % 2 !== 0 ||
    value.recordHeight < 1 ||
    value.recordHeight > value.chainTipHeight ||
    value.confirmations !== value.chainTipHeight - value.recordHeight + 1
  ) {
    throw new Error("invalid_record");
  }
  return value;
}

function sameKeys(value, expected) {
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  return actual.length === sorted.length && actual.every((key, index) => key === sorted[index]);
}

function safeHeight(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}
