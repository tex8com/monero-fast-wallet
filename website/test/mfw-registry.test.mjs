import assert from "node:assert/strict";
import test from "node:test";
import {
  availabilityFromResolution,
  canonicalMfwName,
  estimateMfwExpiryTimestampMs,
  lookupMfwName,
  lookupMfwNameSuggestions,
  lookupPublishedMfwRegistration,
  mfwNameSuggestionPrefix,
  parseMfwNameSuggestions,
  parsePublishedMfwRegistration,
  parseMfwResolution,
  publishedRegistrationProgress,
} from "../src/mfwRegistry.js";

function emptyResolution(overrides = {}) {
  return {
    canonicalName: "alice.mfw",
    status: "not_found",
    network: "mainnet",
    addressKind: 0,
    publicSpendKeyHex: "",
    publicViewKeyHex: "",
    recordHeight: 0,
    sourceTxidHex: "",
    expiryHeight: 0,
    chainTipHeight: 3_740_000,
    confirmations: 0,
    recordPayloadHex: "",
    recordBlockHashHex: "",
    chainTipHashHex: "a".repeat(64),
    ...overrides,
  };
}

function finalizedResolution(overrides = {}) {
  return emptyResolution({
    status: "finalized",
    publicSpendKeyHex: "b".repeat(64),
    publicViewKeyHex: "c".repeat(64),
    recordHeight: 3_739_986,
    sourceTxidHex: "d".repeat(64),
    expiryHeight: 4_002_800,
    confirmations: 15,
    recordPayloadHex: "ab".repeat(90),
    recordBlockHashHex: "e".repeat(64),
    ...overrides,
  });
}

test("MFW names are canonicalized with the strict V1 ASCII label", () => {
  assert.equal(canonicalMfwName(" Alice.MFW "), "alice.mfw");
  assert.equal(canonicalMfwName("fast-wallet"), "fast-wallet.mfw");
  for (const invalid of ["", "-alice", "alice-", "Alice_One", "mønero", "a".repeat(64)]) {
    assert.throws(() => canonicalMfwName(invalid), /invalid_name/);
  }
});

test("name autocomplete starts at three characters and accepts only real resolver names", async () => {
  assert.equal(mfwNameSuggestionPrefix(" TeX "), "tex");
  assert.equal(mfwNameSuggestionPrefix("te"), undefined);
  assert.equal(mfwNameSuggestionPrefix("bad_name"), undefined);
  assert.deepEqual(
    parseMfwNameSuggestions({ prefix: "tex", names: ["tex8.mfw"] }, "tex"),
    { prefix: "tex", names: ["tex8.mfw"] },
  );
  assert.throws(
    () => parseMfwNameSuggestions({ prefix: "tex", names: ["invented.mfw"] }, "tex"),
    /invalid_suggestion_response/,
  );

  let request;
  const result = await lookupMfwNameSuggestions("tex", {
    fetcher: async (url, options) => {
      request = { url, options };
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ prefix: "tex", names: ["tex8.mfw"] }),
      };
    },
  });
  assert.equal(request.url, "/v1/mfw/name-suggestions/tex");
  assert.equal(request.options.method, "GET");
  assert.equal(request.options.cache, "no-store");
  assert.deepEqual(result.names, ["tex8.mfw"]);
});

test("availability maps all public resolver states without turning HTTP 200 into a claim", () => {
  assert.equal(availabilityFromResolution(parseMfwResolution(emptyResolution(), "alice.mfw")).kind, "available");
  assert.equal(availabilityFromResolution(parseMfwResolution(finalizedResolution(), "alice.mfw")).kind, "taken");
  assert.equal(availabilityFromResolution(parseMfwResolution(emptyResolution({ status: "reserved" }), "alice.mfw")).kind, "reserved");
  assert.equal(availabilityFromResolution(parseMfwResolution(finalizedResolution({ status: "provisional" }), "alice.mfw")).kind, "pending");
  assert.equal(availabilityFromResolution(parseMfwResolution(finalizedResolution({ status: "expired" }), "alice.mfw")).kind, "available_again");
});

test("expiry timestamps stay explicitly derived from the authoritative block heights", () => {
  const observedAtMs = Date.UTC(2026, 7, 15, 12, 0, 0);
  assert.equal(
    estimateMfwExpiryTimestampMs(1_030, 1_000, observedAtMs),
    observedAtMs + 30 * 2 * 60 * 1000,
  );
  assert.equal(
    estimateMfwExpiryTimestampMs(970, 1_000, observedAtMs),
    observedAtMs - 30 * 2 * 60 * 1000,
  );
  assert.equal(estimateMfwExpiryTimestampMs(0, 1_000, observedAtMs), undefined);
});

test("resolver responses fail closed on extended JSON and inconsistent confirmations", () => {
  assert.throws(() => parseMfwResolution({ ...emptyResolution(), extra: true }, "alice.mfw"), /invalid_response/);
  assert.throws(() => parseMfwResolution(finalizedResolution({ confirmations: 14 }), "alice.mfw"), /invalid_record/);
  assert.throws(() => parseMfwResolution(emptyResolution({ canonicalName: "mallory.mfw" }), "alice.mfw"), /invalid_response/);
});

test("resolver accepts only the complete owner-transition extension", () => {
  const extended = finalizedResolution({
    ownerPublicKeyHex: "f".repeat(64),
    sequence: 3,
    signingOwnerPublicKeyHex: "e".repeat(64),
  });
  assert.equal(parseMfwResolution(extended, "alice.mfw").status, "finalized");
  assert.equal(
    parseMfwResolution({
      ...emptyResolution({ status: "reserved" }),
      ownerPublicKeyHex: "",
      sequence: 0,
      signingOwnerPublicKeyHex: "",
    }, "alice.mfw").status,
    "reserved",
  );
  const incomplete = { ...extended };
  delete incomplete.sequence;
  assert.throws(() => parseMfwResolution(incomplete, "alice.mfw"), /invalid_response/);
  assert.throws(
    () => parseMfwResolution({ ...extended, ownerPublicKeyHex: "not-a-key" }, "alice.mfw"),
    /invalid_record/,
  );
});

test("live lookup uses the versioned same-origin GET contract", async () => {
  let request;
  const fetcher = async (url, options) => {
    request = { url, options };
    return { ok: true, status: 200, text: async () => JSON.stringify(emptyResolution()) };
  };
  const result = await lookupMfwName("alice", { fetcher });
  assert.equal(request.url, "/v1/mfw/names/alice.mfw");
  assert.equal(request.options.method, "GET");
  assert.equal(request.options.headers.Accept, "application/json");
  assert.equal(result.status, "not_found");
});

test("owner-published COMMIT tracking is display-only and strictly parsed", async () => {
  const tracker = {
    schema: 1,
    registrations: [{
      canonicalName: "alice.mfw",
      commitTxidHex: "f".repeat(64),
      commitHeight: 1_000,
      claimTxidHex: "",
      minimumClaimConfirmations: 15,
      revealWindowConfirmations: 720,
    }],
  };
  assert.deepEqual(parsePublishedMfwRegistration(tracker, "alice.mfw"), tracker.registrations[0]);
  assert.equal(parsePublishedMfwRegistration(tracker, "bob.mfw"), undefined);
  assert.throws(
    () => parsePublishedMfwRegistration({ ...tracker, salt: "secret" }, "alice.mfw"),
    /invalid_tracker/,
  );

  let request;
  const result = await lookupPublishedMfwRegistration("alice", {
    fetcher: async (url, options) => {
      request = { url, options };
      return { ok: true, status: 200, text: async () => JSON.stringify(tracker) };
    },
  });
  assert.equal(request.url, "/mfw-registration-tracking.json");
  assert.equal(request.options.cache, "no-store");
  assert.equal(result.commitHeight, 1_000);
});

test("published COMMIT progress uses the resolver chain tip without changing availability", () => {
  const registration = {
    canonicalName: "alice.mfw",
    commitTxidHex: "f".repeat(64),
    commitHeight: 1_000,
    claimTxidHex: "",
    minimumClaimConfirmations: 15,
    revealWindowConfirmations: 720,
  };
  assert.deepEqual(
    publishedRegistrationProgress(emptyResolution({ chainTipHeight: 1_011 }), registration),
    { confirmations: 12, revealDeadlineHeight: 1_719, stage: "commit_pending" },
  );
  assert.equal(
    publishedRegistrationProgress(emptyResolution({ chainTipHeight: 1_014 }), registration).stage,
    "claim_ready",
  );
  assert.equal(
    publishedRegistrationProgress(emptyResolution({ chainTipHeight: 1_720 }), registration).stage,
    "commit_expired",
  );
  assert.equal(
    publishedRegistrationProgress(emptyResolution({ chainTipHeight: 1_014 }), {
      ...registration,
      claimTxidHex: "e".repeat(64),
    }).stage,
    "claim_broadcast",
  );
  assert.equal(publishedRegistrationProgress(finalizedResolution(), registration), undefined);
});
