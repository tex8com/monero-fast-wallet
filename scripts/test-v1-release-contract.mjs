import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import test from 'node:test';

const repo = new URL('../', import.meta.url);
const read = path => readFileSync(new URL(path, repo), 'utf8');
const readBytes = path => readFileSync(new URL(path, repo));
const manifest = JSON.parse(read('config/v1-release-features.json'));
const communitySigningKeys = JSON.parse(
  read('config/community-v1-signing-public-keys.json'),
);

test('Community V1 production signing trust anchors are valid and independent', () => {
  assert.equal(communitySigningKeys.schemaVersion, 1);
  assert.equal(communitySigningKeys.profile, 'community-v1-production');
  assert.equal(communitySigningKeys.algorithm, 'Ed25519');

  const verifyingKeys = [];
  for (const role of ['catalog', 'advertising', 'artifact']) {
    const key = communitySigningKeys.keys[role];
    assert.match(key.verifyingKeyHex, /^[0-9a-f]{64}$/);
    assert.match(key.keyId, /^[0-9a-f]{32}$/);
    assert.match(key.sha256Fingerprint, /^[0-9a-f]{64}$/);
    const fingerprint = createHash('sha256')
      .update(Buffer.from(key.verifyingKeyHex, 'hex'))
      .digest('hex');
    assert.equal(key.sha256Fingerprint, fingerprint);
    assert.equal(key.keyId, fingerprint.slice(0, 32));
    verifyingKeys.push(key.verifyingKeyHex);
  }
  assert.equal(new Set(verifyingKeys).size, verifyingKeys.length);
});

test('completed search-term contribution is default-on, user-disableable and privacy filtered', () => {
  const mobileContribution = read(
    'apps/mobile/src/backend/CommunityQueryContribution.ts',
  );
  const mobileWelcome = read('apps/mobile/src/screens/WelcomeScreen.tsx');
  const mobileSettings = read('apps/mobile/src/screens/SettingsScreen.tsx');
  const mobileSearch = read(
    'apps/mobile/src/screens/MoneroEnthusiastScreen.tsx',
  );
  const android = read(
    'apps/mobile/android/app/src/main/java/com/monerowallet/MoneroEnthusiastV1Controller.kt',
  );
  const ios = read(
    'apps/mobile/ios/MoneroWallet/NativeMoneroWallet/MoneroEnthusiastV1Controller.inc',
  );
  const aggregator = read(
    'packages/community-query-contribution-core/src/lib.rs',
  );
  const service = read('backend/enthusiast-v1/src/lib.rs');
  const desktop = read('apps/desktop/src/App.tsx');
  const desktopHost = read('apps/desktop/src-tauri/src/lib.rs');
  const desktopPreferences = read(
    'apps/desktop/src-tauri/src/community_preferences.rs',
  );

  assert.match(mobileContribution, /enabled:\s*true/);
  assert.match(mobileContribution, /MAX_PENDING_CONTRIBUTIONS\s*=\s*64/);
  assert.match(mobileContribution, /isSafeCommunityQueryContribution/);
  assert.match(mobileContribution, /pending:\s*enabled === true \? current\.pending : \[\]/);
  assert.match(mobileWelcome, /setCommunityQueryContributionEnabled/);
  assert.match(mobileSettings, /setCommunityQueryContributionEnabled/);
  assert.match(mobileSearch, /contributeSuccessfulCommunityQuery/);
  assert.match(android, /"contributeQuery"\s*->\s*contributeQuery\(input\)/);
  assert.match(android, /isSafeContributionQuery/);
  assert.match(ios, /isEqualToString:@"contributeQuery"/);
  assert.match(ios, /communityV1SafeContributionQuery/);

  assert.match(aggregator, /DEFAULT_MINIMUM_INDEPENDENT_CONTRIBUTORS:\s*u32\s*=\s*3/);
  assert.match(aggregator, /RARE_TERM_RETENTION_MS/);
  assert.match(aggregator, /query_contributor/);
  assert.match(aggregator, /QueryCatalogPayload::Delta/);
  assert.match(service, /"\/v2\/query-contributions"/);
  assert.doesNotMatch(service, /\.route\(\s*"\/v2\/(?:search|rank|embed)/);

  assert.match(desktopPreferences, /share_search_terms:\s*true/);
  assert.match(desktop, /enthusiast_v1_set_query_contribution_enabled/);
  assert.match(desktopHost, /fn enthusiast_v1_contribute_query/);
});

test('Community V1 accepts only the pinned server-signed catalog and has no payment descriptor', () => {
  const manifestCore = read('packages/community-search-core/src/manifest.rs');
  const searchCore = read('packages/community-search-core/src/store.rs');
  const publisher = read(
    'packages/community-publication-core/src/bin/publish_catalog.rs',
  );
  const publicationCore = read(
    'packages/community-publication-core/src/lib.rs',
  );
  const catalogTests = read(
    'packages/community-search-core/tests/catalog.rs',
  );

  assert.match(publisher, /SigningKey::from_bytes\(&signing_seed\)/);
  assert.match(publisher, /SignedCatalogPackage::create\(/);
  assert.match(manifestCore, /payload_sha256:\s*hex::encode\(Sha256::digest\(&payload_json\)\)/);
  assert.match(manifestCore, /signing_key\.sign\(&unsigned\.signing_bytes\(\)\?\)/);
  assert.match(manifestCore, /catalog_signer_key_id\(verifying_key\)/);
  assert.match(manifestCore, /verifying_key\s*\.verify\(/);
  assert.match(searchCore, /CatalogManifest::parse_and_verify\(/);
  assert.match(catalogTests, /wrong_signer_core/);
  assert.match(catalogTests, /CommunitySearchError::InvalidSignature/);
  assert.doesNotMatch(
    publicationCore,
    /pub\s+(?:struct|enum)\s+(?:Payment|Checkout|Order|Payout|SellerSignature)/,
  );
});

test('safe V1 feature manifest enables verified local surfaces and fails closed for unfinished remote surfaces', () => {
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.profile, 'safe-wallet-v1');
  assert.equal(manifest.features.localFastWallet, true);
  assert.equal(
    manifest.features.ledgerFastWallet,
    false,
    'legacy Ledger account hosting must stay disabled; Ledger setup creates an independent Fast Wallet',
  );
  assert.equal(
    manifest.features.officialWorker,
    true,
    'the deployed encrypted official Worker must be enabled',
  );
  assert.equal(
    manifest.features.privateWorkerPairing,
    true,
    'natively verified Community and private Worker selection must be enabled',
  );
  for (const feature of [
    'automaticFastWalletCreation',
    'plaintextFastWalletHosting',
    'ledgerFastWallet',
    'scannerKeyImageSpendAuthority',
    'legacyCommunity',
    'assistant',
    'marketplace',
    'deviceContactDiscovery',
    'publicLedger',
  ]) {
    assert.equal(manifest.features[feature], false, `${feature} must remain disabled`);
  }
  assert.equal(
    manifest.features.mfwNameRegistration,
    true,
    'the pinned development MFW registration flow must be enabled',
  );
  assert.equal(typeof manifest.features.moneroEnthusiastV1, 'boolean');
  if (manifest.features.moneroEnthusiastV1) {
    assertCompleteCommunityReleaseConfiguration(
      manifest.parameters.moneroEnthusiastV1,
    );
    assert.equal(
      manifest.parameters.moneroEnthusiastV1.catalogVerifyingKeyHex,
      communitySigningKeys.keys.catalog.verifyingKeyHex,
    );
    assert.equal(
      manifest.parameters.moneroEnthusiastV1.advertisingVerifyingKeyHex,
      communitySigningKeys.keys.advertising.verifyingKeyHex,
    );
    assert.equal(
      manifest.parameters.moneroEnthusiastV1.artifactVerifyingKeyHex,
      communitySigningKeys.keys.artifact.verifyingKeyHex,
    );
  } else {
    assert.equal(manifest.parameters.moneroEnthusiastV1, null);
  }
});

test('Monero Enthusiast V1 cannot fall back to the legacy plaintext Community path', () => {
  const mobileNavigation = read('apps/mobile/src/navigation/TabNavigator.tsx');
  const mobileMenu = read('apps/mobile/src/screens/MenuScreen.tsx');
  const mobileTabs = read('apps/mobile/src/components/CustomTabBar.tsx');
  const mobileV1 = read(
    'apps/mobile/src/screens/MoneroEnthusiastScreen.tsx',
  );
  const mobileNativeSpec = read('apps/mobile/specs/NativeMoneroWallet.ts');
  const androidCommunityBuild = read('apps/mobile/android/app/build.gradle');
  const androidCommunityCmake = read(
    'apps/mobile/android/app/src/main/cpp/CMakeLists.txt',
  );
  const androidCommunityJni = read(
    'apps/mobile/android/app/src/main/cpp/NativeMoneroWalletJni.cpp',
  );
  const androidCommunityNative = read(
    'apps/mobile/android/app/src/main/java/com/monerowallet/NativeMoneroWalletModule.kt',
  );
  const androidCommunityController = read(
    'apps/mobile/android/app/src/main/java/com/monerowallet/MoneroEnthusiastV1Controller.kt',
  );
  const iosCommunityNative = read(
    'apps/mobile/ios/MoneroWallet/NativeMoneroWallet/RCTNativeMoneroWallet.mm',
  );
  const iosCommunityController = read(
    'apps/mobile/ios/MoneroWallet/NativeMoneroWallet/MoneroEnthusiastV1Controller.inc',
  );
  const iosProject = read('apps/mobile/ios/MoneroWallet.xcodeproj/project.pbxproj');
  const matrixHeader = read(
    'native/community-matrix-core/include/community_matrix_core.h',
  );
  const runtimeHeader = read(
    'native/community-runtime-core/include/community_runtime_core.h',
  );
  const desktop = read('apps/desktop/src/App.tsx');
  const desktopNative = read('apps/desktop/src-tauri/src/lib.rs');
  const searchCore = read('packages/community-search-core/src/store.rs');
  const searchModel = read('packages/community-search-core/src/model.rs');
  const localInterest = read('packages/community-search-core/src/interest.rs');
  const commonQueries = read('packages/community-search-core/src/query.rs');
  const localQueryCache = read(
    'packages/community-search-core/src/local_query.rs',
  );
  const communityRuntime = read('native/community-runtime-core/src/lib.rs');
  const mobileCommunityService = read(
    'apps/mobile/src/backend/MoneroEnthusiastV1Service.ts',
  );
  const commonQueryPublisher = read(
    'packages/community-search-core/src/bin/publish_query_catalog.rs',
  );
  const harrierArtifact = read('packages/community-search-core/src/artifact.rs');
  const searchCargo = read('packages/community-search-core/Cargo.toml');
  const publicationCore = read('packages/community-publication-core/src/lib.rs');
  const v1Api = read('backend/enthusiast-v1/src/lib.rs');
  const v1Runtime = read('backend/enthusiast-v1/src/main.rs');

  assert.equal(typeof manifest.features.moneroEnthusiastV1, 'boolean');
  assert.equal(manifest.features.legacyCommunity, false);
  for (const source of [mobileNavigation, desktop]) {
    assert.match(source, /v1ReleaseFeatures\.legacyCommunity/);
    assert.doesNotMatch(
      source,
      /v1ReleaseFeatures\.moneroEnthusiastV1\s*\?\s*(?:[^:\n]{0,200})?(?:FindEnthusiasts|EnthusiastChat|<Community(?:\s|\/|>))/,
    );
  }
  assert.doesNotMatch(mobileMenu, /FindEnthusiasts|EnthusiastChat/);
  assert.doesNotMatch(mobileTabs, /FindEnthusiasts/);
  assert.match(mobileNavigation, /name="MoneroEnthusiast"/);
  assert.match(mobileMenu, /"MoneroEnthusiast", IcoCommunity/);
  assert.match(mobileTabs, /key: "MoneroEnthusiast"/);
  assert.match(mobileV1, /getMoneroEnthusiastV1Status/);
  assert.doesNotMatch(
    mobileV1,
    /FindEnthusiasts|EnthusiastChat|community_(?:list|send|load)|\/v1\/nearby|\/v1\/conversations/,
  );
  assert.doesNotMatch(
    mobileV1,
    /accessToken|matrixSession|privateKey|fetch\(|axios|XMLHttpRequest/,
  );
  assert.match(mobileNativeSpec, /getMoneroEnthusiastV1Status/);
  assert.match(androidCommunityBuild, /MONERO_COMMUNITY_MATRIX_LIBRARY/);
  assert.match(androidCommunityBuild, /MONERO_COMMUNITY_HARRIER_LIBRARY/);
  assert.match(androidCommunityBuild, /MONERO_ENTHUSIAST_V1_ENABLED/);
  assert.match(androidCommunityCmake, /TEX8_COMMUNITY_MATRIX_LINKED=1/);
  assert.match(androidCommunityCmake, /TEX8_COMMUNITY_RUNTIME_LINKED=1/);
  assert.match(androidCommunityCmake, /community_matrix_core\.h/);
  assert.match(androidCommunityCmake, /community_runtime_core\.h/);
  assert.match(androidCommunityJni, /tex8_community_matrix_link_anchor_v1/);
  assert.match(androidCommunityJni, /tex8_community_runtime_link_anchor_v1/);
  assert.match(androidCommunityController, /NativeMoneroWalletJni\.communityMatrixLinked\(\)/);
  assert.match(androidCommunityController, /NativeMoneroWalletJni\.communityRuntimeLinked\(\)/);
  assert.match(androidCommunityNative, /runMoneroEnthusiastV1Operation/);
  assert.match(iosCommunityNative, /TEX8_COMMUNITY_MATRIX_LINKED/);
  assert.match(iosCommunityNative, /TEX8_COMMUNITY_RUNTIME_LINKED/);
  assert.match(iosCommunityController, /tex8_community_matrix_link_anchor_v1/);
  assert.match(iosCommunityController, /tex8_community_runtime_link_anchor_v1/);
  assert.match(iosCommunityNative, /runMoneroEnthusiastV1Operation/);
  assert.match(iosCommunityController, /executeOperation/);
  assert.match(iosProject, /MONERO_COMMUNITY_MATRIX_LIBRARY/);
  assert.match(iosProject, /MONERO_COMMUNITY_HARRIER_LIBRARY/);
  assert.match(matrixHeader, /tex8_community_matrix_login_v1/);
  assert.match(matrixHeader, /tex8_community_matrix_selected_report_v1/);
  assert.match(matrixHeader, /tex8_community_matrix_free_buffer_v1/);
  assert.match(runtimeHeader, /tex8_community_runtime_install_catalog_v1/);
  assert.match(runtimeHeader, /tex8_community_runtime_search_v1/);
  assert.match(runtimeHeader, /normalized lookup keys and embeddings have no FFI export/);
  assert.match(desktop, /<MoneroEnthusiastV1 \/>/);
  const desktopV1 = desktop.slice(
    desktop.indexOf('function MoneroEnthusiastV1()'),
    desktop.indexOf('function CommunityConversation('),
  );
  assert.match(desktopV1, /enthusiast_v1_status/);
  assert.doesNotMatch(
    desktopV1,
    /community_(?:list|send|load)|accessToken|matrixSession|embedding|fetch\(|axios|XMLHttpRequest/,
  );
  assert.match(desktopNative, /fn enthusiast_v1_status/);
  assert.match(desktopNative, /require_legacy_community_release/);
  assert.match(desktopNative, /"legacyCommunity"/);

  assert.match(searchCore, /CatalogManifest::parse_and_verify/);
  assert.match(searchCore, /\.exact_search\(/);
  assert.match(searchCore, /exact_search\(&query\.embedding, count\)/);
  assert.match(searchCore, /matched_items\.insert\(item\.public_id\.clone\(\)\)/);
  assert.match(searchCore, /catalog_tombstone/);
  assert.match(searchModel, /query_prompt_version/);
  assert.match(searchModel, /embeddings must be L2-normalized/);
  assert.match(localInterest, /derive\(Clone, Debug, Default, Serialize, Deserialize\)/);
  assert.match(localInterest, /enabled: bool/);
  assert.match(localInterest, /Reported \| Self::Blocked => None/);
  assert.match(localInterest, /XChaCha20Poly1305/);
  assert.match(localInterest, /ModelResetAndApplied/);
  assert.match(localInterest, /\.clamp\(-0\.15, 0\.15\)/);
  assert.match(commonQueries, /QUERY_NORMALIZATION_VERSION/);
  assert.match(commonQueries, /CatalogManifest::parse_and_verify/);
  assert.match(commonQueries, /CREATE TABLE query_entry/);
  assert.match(commonQueries, /query_tombstone/);
  assert.match(commonQueries, /fn escape_like_prefix/);
  assert.match(localQueryCache, /DEFAULT_LOCAL_QUERY_CACHE_CAPACITY: usize = 512/);
  assert.match(localQueryCache, /XChaCha20Poly1305/);
  assert.match(localQueryCache, /LOCAL_QUERY_LOW_USE_MAX_AGE_MS/);
  assert.match(
    localQueryCache,
    /ORDER BY use_count ASC, last_used_ms ASC/,
  );
  assert.match(communityRuntime, /open_with_keys_and_query_cache/);
  assert.match(communityRuntime, /for suggestion in local/);
  assert.match(communityRuntime, /for suggestion in downloaded/);
  assert.match(communityRuntime, /cache\.record\(&request\.query/);
  assert.match(mobileCommunityService, /clearSearchHistory/);
  assert.match(androidCommunityController, /runCatching \{ installRemoteCatalogs\(\) \}/);
  assert.match(androidCommunityController, /monero\.community\.v1\.query-cache-key/);
  assert.match(iosCommunityController, /kCommunityV1QueryCacheKey/);
  assert.match(
    iosCommunityController,
    /tex8_community_runtime_clear_query_cache_v1/,
  );
  assert.match(commonQueryPublisher, /SignedQueryCatalogPackage::create/);
  assert.match(commonQueryPublisher, /output directory already exists/);
  assert.doesNotMatch(
    commonQueryPublisher,
    /reqwest|hyper|ureq|curl|fetch\(|axios/,
  );
  assert.match(
    searchModel,
    /90933b6826b61afd9331e0ebe3c0598b421a32eda5fb301a114fe36f306cb51a/,
  );
  assert.match(
    searchModel,
    /6852f8d561078cc0cebe70ca03c5bfdd0d60a45f9d2e0e1e4cc05b68e9ec329e/,
  );
  assert.match(harrierArtifact, /MIN_REFERENCE_COSINE_PPM: u32 = 980_000/);
  assert.match(harrierArtifact, /HarrierArtifactTarget::/);
  assert.match(harrierArtifact, /PayloadHashMismatch/);
  assert.doesNotMatch(
    searchCargo,
    /reqwest|hyper|ureq|curl|websocket|tokio-tungstenite/,
  );
  assert.match(publicationCore, /draft_cipher BLOB NOT NULL/);
  assert.match(publicationCore, /wording_suggestion_cipher BLOB/);
  assert.match(publicationCore, /MAX_LISTING_LIFETIME_MS/);
  const publicDraft = publicationCore.slice(
    publicationCore.indexOf('pub struct PublicContentDraft'),
    publicationCore.indexOf('pub enum PublicationStatus'),
  );
  assert.doesNotMatch(
    publicDraft,
    /price|checkout|escrow|wallet|payment|order|quantity/i,
  );

  assert.match(v1Api, /pub fn public_router/);
  assert.match(v1Api, /pub fn internal_router/);
  assert.doesNotMatch(v1Api, /\.route\(\s*"\/v2\/(?:search|rank|embed|messages)"/);
  assert.match(v1Runtime, /internal_bind\.ip\(\)\.is_loopback\(\)/);
});

function assertCompleteCommunityReleaseConfiguration(config) {
  assert.ok(config && typeof config === 'object');
  for (const origin of [
    config.apiOrigin,
    config.matrixHomeserver,
    config.catalogOrigin,
    config.advertisingOrigin,
  ]) {
    const parsed = new URL(origin);
    assert.ok(
      parsed.protocol === 'https:' ||
        (parsed.protocol === 'http:' &&
          /^[a-z2-7]{56}\.onion$/u.test(parsed.hostname)),
      'Community origins must use HTTPS or a Tor v3 Onion service',
    );
    assert.equal(origin, parsed.origin);
    assert.equal(parsed.username, '');
    assert.equal(parsed.password, '');
  }
  assert.match(config.catalogScope, /^[A-Za-z0-9_-]{1,128}$/);
  for (const key of [
    config.catalogVerifyingKeyHex,
    config.advertisingVerifyingKeyHex,
    config.artifactVerifyingKeyHex,
  ]) {
    assert.match(key, /^[0-9a-f]{64}$/);
  }
  assert.match(config.advertisingCountry, /^[A-Z]{2}$/);
  for (const resource of [
    config.artifactManifestResource,
    config.pteResource,
    config.tokenizerResource,
    config.conformanceResource,
  ]) {
    assert.match(resource, /^[A-Za-z0-9._/-]{1,256}$/);
    assert.ok(!resource.startsWith('/'));
    assert.ok(!resource.split('/').some(part => !part || part === '..'));
  }
}

test('Harrier release evidence accepts only the pinned A8W8 result', () => {
  const artifactContract = read('packages/community-search-core/src/artifact.rs');
  const referenceBytes = readBytes(
    'tools/community-harrier-testbench/reference_vectors.v2.json',
  );
  const preparedBytes = readBytes(
    'tools/community-harrier-testbench/prepared_inputs.v2.json',
  );
  const reference = JSON.parse(referenceBytes.toString('utf8'));
  const prepared = JSON.parse(preparedBytes.toString('utf8'));
  const accepted = JSON.parse(
    read(
      'tools/community-harrier-testbench/evidence/xnnpack-a8w8-conformance.v2.json',
    ),
  );
  const exported = JSON.parse(
    read(
      'tools/community-harrier-testbench/evidence/xnnpack-a8w8-export.v1.json',
    ),
  );
  const nativeMacos = JSON.parse(
    read(
      'tools/community-harrier-testbench/evidence/xnnpack-a8w8-native-macos-conformance.v2.json',
    ),
  );
  const referenceSha256 = createHash('sha256')
    .update(referenceBytes)
    .digest('hex');
  const preparedSha256 = createHash('sha256')
    .update(preparedBytes)
    .digest('hex');

  assert.equal(referenceSha256, 'e5731dc99b676e4186646c9a1d277ad1d20717231ee04f70da0a3fd10d0c39fd');
  assert.equal(preparedSha256, '4f942d9a068722e9fbc593ae0f907cc857282240a950b41983a850f6aa0eb379');
  assert.equal(reference.queryPromptVersion, 'community-query-v2');
  assert.equal(
    prepared.queryInstruction,
    'Instruct: Given a community search query, retrieve relevant public profiles, posts, services, products, news, and clearly labeled advertisements\nQuery: ',
  );
  assert.doesNotMatch(prepared.queryInstruction, /Monero community/);
  assert.equal(reference.vectors.length, 36);
  assert.equal(prepared.cases.length, 36);
  assert.equal(new Set(prepared.cases.map(item => item.id)).size, 36);
  assert.equal(new Set(reference.vectors.map(item => item.id)).size, 36);
  assert.equal(accepted.referenceSha256, referenceSha256);
  assert.equal(accepted.backend, 'xnnpack-a8w8');
  assert.equal(accepted.runtimeVersion, '1.3.1');
  assert.equal(accepted.artifactSha256, exported.pteSha256);
  assert.equal(accepted.passed, true);
  assert.ok(accepted.minimumCosine >= 0.98);
  assert.equal(nativeMacos.referenceSha256, referenceSha256);
  assert.equal(nativeMacos.artifactSha256, exported.pteSha256);
  assert.equal(nativeMacos.backend, 'xnnpack-a8w8');
  assert.equal(nativeMacos.runtime, 'executorch');
  assert.equal(nativeMacos.runtimeVersion, '1.3.1');
  assert.equal(nativeMacos.referenceCases, 36);
  assert.equal(nativeMacos.cases.length, 36);
  assert.equal(nativeMacos.passed, true);
  assert.ok(nativeMacos.minimumCosine >= 0.98);
  assert.match(artifactContract, /ARTIFACT_RUNTIME_VERSION: &str = "1\.3\.1"/);
  assert.match(artifactContract, /XnnpackA8w8/);
  assert.match(artifactContract, /validate_conformance_report/);
});

test('MFW clients remain release-gated behind purpose-bound native preparation', () => {
  const nativeSpec = read('apps/mobile/specs/NativeMoneroWallet.ts');
  const nativeService = read('apps/mobile/src/backend/NativeMoneroWallet.ts');
  const bridge = read('native/monero-bridge/cpp/FastWalletProtocolBridge.h');
  const protocol = read('native/fast-wallet-protocol/src/lib.rs');
  const android = read(
    'apps/mobile/android/app/src/main/java/com/monerowallet/NativeMoneroWalletModule.kt',
  );
  const ios = read(
    'apps/mobile/ios/MoneroWallet/NativeMoneroWallet/RCTNativeMoneroWallet.mm',
  );
  const nameScreen = read('apps/mobile/src/screens/MfwNamesScreen.tsx');
  const nameRegistry = read(
    'apps/mobile/src/backend/MfwNameRegistrationRegistry.ts',
  );
  const sendScreen = read('apps/mobile/src/screens/SendScreen.tsx');
  const resolverClient = read(
    'apps/mobile/src/backend/MfwNameResolverClient.ts',
  );
  const cuprateRpc = read(
    'node/mfn-monero-fast-node/binaries/cuprated/src/rpc/server.rs',
  );
  const desktopApp = read('apps/desktop/src/App.tsx');
  const desktopHost = read('apps/desktop/src-tauri/src/lib.rs');
  const desktopUi = read('apps/desktop/src/MfwNames.tsx');
  const desktopRegistry = read('apps/desktop/src-tauri/src/mfw_names.rs');
  const desktopResolver = read(
    'apps/desktop/src-tauri/src/mfw_name_resolver.rs',
  );
  const desktopNative = read(
    'native/desktop-bridge/cpp/DesktopWalletCore.cpp',
  );

  assert.equal(manifest.features.mfwNameResolution, true);
  assert.equal(manifest.features.mfwNameRegistration, true);
  assert.equal(manifest.parameters.mfwNameGenesis.network, 'mainnet');
  assert.deepEqual(manifest.parameters.mfwNameResolverOrigins, [
    'http://fastrelayrpcf3hbc4qvykjgbpwpmcuq5dpcsdxoe7gwfh2zxdib3eid.onion',
    'http://quietportrpccujodzxhwcfefbmhftof5i6oiq7rrx5tnzna7rxirhqd.onion',
  ]);
  assert.deepEqual(manifest.parameters.mfwNameSuggestionOnionOrigins, [
    'http://fastrelayrpcf3hbc4qvykjgbpwpmcuq5dpcsdxoe7gwfh2zxdib3eid.onion',
  ]);
  assert.equal(manifest.parameters.privatePhoneDirectory, null);
  assert.match(nativeSpec, /verifyMfwNameRecordAddress/);
  assert.match(nativeService, /verifyMfwNameRecordAddress/);
  assert.match(bridge, /verifiedNameAddress/);
  assert.match(protocol, /tex8_mfw_verify_and_encode_name_address_v1/);
  assert.match(bridge, /validateRecipientAddress\(address, network\)/);
  for (const method of [
    'prepareMfwNameRegistration',
    'prepareMfwNameClaim',
    'prepareMfwNameTransition',
  ]) {
    assert.match(nativeSpec, new RegExp(`\\b${method}\\s*\\(`));
    assert.match(nativeService, new RegExp(`\\b${method}\\s*\\(`));
    assert.match(android, new RegExp(`\\b${method}\\s*\\(`));
    assert.match(ios, new RegExp(`\\b${method}`));
  }
  assert.match(protocol, /tex8_mfw_generate_name_registration_v1/);
  assert.match(protocol, /tex8_mfw_prepare_name_claim_v1/);
  assert.match(protocol, /tex8_mfw_prepare_name_transition_v1/);
  assert.match(protocol, /tex8_mfw_export_name_recovery_v1/);
  assert.match(protocol, /tex8_mfw_import_name_recovery_v1/);
  assert.match(bridge, /exportMfwNameRecovery/);
  assert.match(bridge, /importMfwNameRecovery/);
  assert.match(nativeSpec, /\bexportMfwNameRecovery\s*\(/);
  assert.match(nativeService, /\bexportMfwNameRecovery\s*\(/);
  assert.match(android, /\bexportMfwNameRecovery\s*\(/);
  assert.match(ios, /\bexportMfwNameRecovery:/);
  assert.match(nativeSpec, /\bimportMfwNameRecovery\s*\(/);
  assert.match(nativeService, /\bimportMfwNameRecovery\s*\(/);
  assert.match(android, /\bimportMfwNameRecovery\s*\(/);
  assert.match(ios, /\bimportMfwNameRecovery:/);
  assert.doesNotMatch(nameScreen, /await walletService\.exportMfwNameRecovery\(/);
  assert.doesNotMatch(nameScreen, /if \(!recoveryExported\)/);
  assert.match(nameScreen, /await walletService\.importMfwNameRecovery\(/);
  assert.match(nameScreen, /resolveConfiguredMfwOwnedNameForImport/);
  for (const operation of ['update', 'renew', 'revoke']) {
    assert.match(
      nameScreen,
      new RegExp(`prepareOwnedNameTransition[\\s\\S]+['"]${operation}['"]`),
    );
    assert.match(sendScreen, new RegExp(`kind === ['"]${operation}['"]`));
  }
  assert.match(nameRegistry, /stage: 'update-pending'/);
  assert.match(nameRegistry, /stage: 'revoke-pending'/);
  assert.match(cuprateRpc, /"\/v1\/mfw\/names\/\{name\}"/);
  assert.match(cuprateRpc, /"\/v1\/mfw\/name-suggestions\/\{prefix\}"/);
  assert.match(cuprateRpc, /mfw_http_response/);
  assert.match(resolverClient, /MFW_RESOLUTION_KEYS/);
  assert.match(resolverClient, /parseMfwNameResolution/);
  assert.match(android, /storeDurableSecretValue\(mfwNameStateSecretKey/);
  assert.match(ios, /storeKeychainSecret\(mfwNameStateKey/);
  assert.match(desktopHost, /store_mfw_name_owner_state/);
  assert.doesNotMatch(desktopHost, /record\.recovery_exported_at\.is_none\(\)/);
  assert.match(desktopRegistry, /tex8_mfw_export_name_recovery_v1/);
  assert.match(desktopRegistry, /tex8_mfw_import_name_recovery_v1/);
  assert.match(
    desktopHost,
    /estimated_term_years\(resolution\.record_height, resolution\.expiry_height\)/,
  );
  assert.match(desktopResolver, /origins\.is_empty\(\) \|\| origins\.len\(\) > 4/);
  assert.match(desktopResolver, /Policy::none\(\)/);
  assert.match(desktopResolver, /deny_unknown_fields/);
  assert.match(
    desktopResolver,
    /tex8_mfw_verify_and_encode_name_address_v1/,
  );
  assert.match(desktopApp, /resolve_mfw_name_for_payment/);
  assert.match(desktopUi, /prepare_mfw_name_registration/);
  assert.match(desktopUi, /prepare_mfw_name_claim/);
  assert.match(desktopUi, /prepare_mfw_name_transition/);
  assert.match(desktopUi, /export_mfw_name_recovery/);
  assert.match(desktopUi, /import_mfw_name_recovery/);
  assert.match(
    desktopNative,
    /tex8_desktop_wallet_prepare_mfw_name_registration/,
  );
  assert.match(desktopNative, /tex8_desktop_wallet_prepare_mfw_name_claim/);
  assert.match(
    desktopNative,
    /tex8_desktop_wallet_prepare_mfw_name_transition/,
  );
  assert.match(desktopNative, /secureClear\(result->value\)/);
  assert.doesNotMatch(
    nativeSpec,
    /\bownerPrivateKeyHex\b|\bcommitSaltHex\b|\bbundleHex\b|\bpassphrase\b/,
  );
  assert.doesNotMatch(
    nativeService,
    /\bownerPrivateKeyHex\b|\bcommitSaltHex\b|\bmfwNameExtraNonce\b|\bbundleHex\b|\bpassphrase\b/,
  );
  assert.doesNotMatch(desktopUi, /ownerPrivateKeyHex|commitSaltHex/);
});

test('private phone discovery keeps cryptographic state and identity below React', () => {
  const nativeSpec = read('apps/mobile/specs/NativeMoneroWallet.ts');
  const nativeService = read('apps/mobile/src/backend/NativeMoneroWallet.ts');
  const packagedClient = read(
    'apps/mobile/src/backend/PrivatePhoneDirectoryClient.ts',
  );
  const bridge = read('native/monero-bridge/cpp/FastWalletProtocolBridge.h');
  const protocolHeader = read(
    'native/fast-wallet-protocol/include/fast_wallet_protocol.h',
  );
  const android = read(
    'apps/mobile/android/app/src/main/java/com/monerowallet/NativeMoneroWalletModule.kt',
  );
  const ios = read(
    'apps/mobile/ios/MoneroWallet/NativeMoneroWallet/RCTNativeMoneroWallet.mm',
  );

  assert.equal(manifest.features.deviceContactDiscovery, false);
  assert.match(nativeSpec, /resolvePrivatePhoneDirectoryContact/);
  assert.match(nativeService, /resolvePrivatePhoneDirectoryContact/);
  for (const forbiddenMethod of [
    'blindPrivatePhone',
    'finalizePrivatePhone',
    'discardPrivatePhoneSession',
    'combinePrivatePhoneToken',
    'derivePrivatePhonePairId',
    'ensurePrivatePhoneIdentity',
    'evaluatePrivatePhoneVoprf',
    'openPrivatePhoneDirectoryContact',
    'openPrivatePhoneSnapshotContact',
  ]) {
    assert.doesNotMatch(
      nativeSpec,
      new RegExp(`\\b${forbiddenMethod}\\s*\\(`),
    );
    assert.doesNotMatch(
      nativeService,
      new RegExp(`\\b${forbiddenMethod}\\s*\\(`),
    );
  }
  assert.doesNotMatch(
    packagedClient,
    /pairIdHex|publisherPhoneTokenHex|targetPhoneTokenHex|snapshotHex/,
  );
  assert.match(protocolHeader, /tex8_mfw_voprf_blind_session_v1/);
  assert.match(protocolHeader, /tex8_mfw_voprf_finalize_session_v1/);
  assert.match(protocolHeader, /tex8_mfw_generate_phone_identity_v1/);
  assert.match(bridge, /validateRecipientAddress/);
  assert.match(android, /PRIVATE_PHONE_IDENTITY_PRIVATE_KEY/);
  assert.match(android, /storeDurableSecretValue/);
  assert.match(ios, /kPrivatePhoneIdentityPrivateKey/);
  assert.match(ios, /storeKeychainSecret/);
});

test('private phone network trust and complete snapshots remain below React', () => {
  const nativeSpec = read('apps/mobile/specs/NativeMoneroWallet.ts');
  const packagedClient = read(
    'apps/mobile/src/backend/PrivatePhoneDirectoryClient.ts',
  );
  const consent = read(
    'apps/mobile/src/backend/PrivatePhoneConsentRegistry.ts',
  );
  const deviceContacts = read(
    'apps/mobile/src/backend/PrivatePhoneDeviceContacts.ts',
  );
  const resolver = read(
    'apps/mobile/src/backend/PrivateRecipientResolution.ts',
  );
  const androidBuild = read('apps/mobile/android/app/build.gradle');
  const android = read(
    'apps/mobile/android/app/src/main/java/com/monerowallet/NativeMoneroWalletModule.kt',
  );
  const androidJni = read(
    'apps/mobile/android/app/src/main/cpp/NativeMoneroWalletJni.cpp',
  );
  const iosInfo = read('apps/mobile/ios/MoneroWallet/Info.plist');
  const ios = read(
    'apps/mobile/ios/MoneroWallet/NativeMoneroWallet/RCTNativeMoneroWallet.mm',
  );
  const bridge = read('native/monero-bridge/cpp/FastWalletProtocolBridge.h');

  assert.equal(manifest.features.deviceContactDiscovery, false);
  assert.equal(manifest.parameters.privatePhoneDirectory, null);
  assert.match(nativeSpec, /resolvePrivatePhoneDirectoryContact/);
  assert.match(packagedClient, /native\.resolvePrivatePhoneDirectoryContact/);
  assert.doesNotMatch(packagedClient, /native\.evaluatePrivatePhoneVoprf/);
  assert.doesNotMatch(packagedClient, /native\.openPrivatePhoneDirectoryContact/);
  assert.doesNotMatch(
    packagedClient,
    /pairIdHex|publisherPhoneTokenHex|targetPhoneTokenHex|snapshotHex/,
  );
  assert.match(packagedClient, /const consentGranted =/);
  assert.match(packagedClient, /if \(!consentGranted\)/);
  assert.match(deviceContacts, /!provider\.consentGranted/);
  assert.match(consent, /findPeopleEnabled: false/);
  assert.match(consent, /sharingStatus: 'off'/);
  assert.match(consent, /'revocation-pending'/);
  assert.match(consent, /loadProtectedMetadata/);
  assert.match(resolver, /native\.resolveContact/);
  assert.doesNotMatch(resolver, /downloadCompleteSnapshot/);
  assert.doesNotMatch(packagedClient, /snapshotHex/);
  assert.match(androidBuild, /PRIVATE_PHONE_DIRECTORY_ORIGIN/);
  assert.match(androidBuild, /PRIVATE_PHONE_MAXIMUM_SNAPSHOT_BYTES/);
  assert.match(android, /route = "\/v1\/evaluate"/);
  assert.match(android, /route = "\/v1\/snapshot"/);
  assert.match(android, /openPrivatePhoneSnapshotContactBytes/);
  assert.match(android, /System\.currentTimeMillis\(\) \/ 1_000L/);
  assert.match(android, /enforcePrivatePhoneDirectoryHighWater/);
  assert.match(android, /snapshot rollback was rejected/);
  assert.match(android, /contact rollback was rejected/);
  assert.match(androidJni, /jbyteArray snapshot/);
  assert.match(androidJni, /const auto snapshotBytes/);
  assert.match(iosInfo, /PRIVATE_PHONE_DIRECTORY_ORIGIN/);
  assert.match(iosInfo, /PRIVATE_PHONE_MAXIMUM_SNAPSHOT_BYTES/);
  assert.match(ios, /@"\/v1\/evaluate"/);
  assert.match(ios, /@"\/v1\/snapshot"/);
  assert.match(ios, /openPrivatePhoneSnapshotContactBytes/);
  assert.match(ios, /NSDate\.date\.timeIntervalSince1970/);
  assert.match(ios, /enforcePrivatePhoneDirectoryHighWater/);
  assert.match(ios, /snapshot rollback was rejected/);
  assert.match(ios, /contact rollback was rejected/);
  assert.match(bridge, /openPrivatePhoneSnapshotContactBytes/);
});

test('private phone publication is signed monotone durable and has no lookup oracle', () => {
  const protocol = read('native/mfw-recipient-protocol/src/phone.rs');
  const protocolHeader = read(
    'native/fast-wallet-protocol/include/fast_wallet_protocol.h',
  );
  const service = read('backend/mfw-private-directory/src/lib.rs');
  const runtime = read('backend/mfw-private-directory/src/main.rs');
  const publisher = read(
    'backend/mfw-private-directory/src/bin/mfw-directory-publisher.rs',
  );
  const nativeSpec = read('apps/mobile/specs/NativeMoneroWallet.ts');
  const android = read(
    'apps/mobile/android/app/src/main/java/com/monerowallet/NativeMoneroWalletModule.kt',
  );
  const ios = read(
    'apps/mobile/ios/MoneroWallet/NativeMoneroWallet/RCTNativeMoneroWallet.mm',
  );

  assert.equal(manifest.features.deviceContactDiscovery, false);
  assert.match(protocol, /pub struct ParticipantRevocation/);
  assert.match(protocol, /pub struct ContactRevocation/);
  assert.match(protocol, /pub struct PermitRefreshRequest/);
  assert.match(protocol, /TEX8\/MFW\/phone-permit-refresh\/v1/);
  assert.match(protocolHeader, /tex8_mfw_sign_phone_permit_refresh_v1/);
  assert.match(service, /DirectorySnapshotBuilder/);
  assert.match(service, /NonMonotoneSequence/);
  assert.match(service, /ReassignmentCooldown/);
  assert.match(service, /encode_authenticated_state/);
  assert.match(service, /begin_directory_state_transaction/);
  assert.match(service, /try_lock_exclusive/);
  assert.match(service, /RemotePhoneTokenDeriver/);
  assert.match(service, /PhoneVerificationIssuer/);
  assert.match(service, /WebhookPhoneVerificationProvider/);
  assert.match(service, /x-mfw-provider-auth/);
  assert.match(service, /route\(\s*"\/v1\/contact"/);
  assert.match(service, /"\/v1\/contact\/revoke"/);
  assert.match(service, /"\/v1\/participant\/revoke"/);
  assert.match(service, /"\/v1\/phone-verification\/refresh-permits"/);
  assert.match(service, /MAX_PHONE_PERMIT_REFRESHES_PER_WINDOW/);
  assert.match(service, /security\.replays\.contains_key/);
  assert.doesNotMatch(service, /\/v1\/(?:phone-token|pair|contact)\/lookup/);
  assert.match(nativeSpec, /startPrivatePhoneVerification/);
  assert.match(nativeSpec, /completePrivatePhoneVerification/);
  assert.doesNotMatch(
    nativeSpec,
    /evaluatePrivatePhoneVoprf\s*\(\s*evaluatorIndex:\s*number,\s*blindedRequestHex:\s*string,\s*(?:permit|phoneToken)/,
  );
  assert.match(android, /PRIVATE_PHONE_PERMIT_REFRESH_AT_KEY/);
  assert.match(android, /refreshPrivatePhoneEvaluationPermitsIfNeeded/);
  assert.match(android, /"\/v1\/phone-verification\/refresh-permits"/);
  assert.match(ios, /kPrivatePhonePermitRefreshAtKey/);
  assert.match(ios, /refreshPrivatePhoneEvaluationPermitsIfNeeded/);
  assert.match(ios, /@"\/v1\/phone-verification\/refresh-permits"/);
  assert.match(runtime, /"verification"/);
  assert.match(publisher, /Persist the increased high-water generation/);
});

test('wallet-side private contact sharing is purpose-bound durable and gated', () => {
  const nativeSpec = read('apps/mobile/specs/NativeMoneroWallet.ts');
  const nativeService = read('apps/mobile/src/backend/NativeMoneroWallet.ts');
  const sharing = read(
    'apps/mobile/src/backend/PrivatePhoneSharingService.ts',
  );
  const screen = read('apps/mobile/src/screens/PrivateContactsScreen.tsx');
  const send = read('apps/mobile/src/screens/SendScreen.tsx');
  const recipientReview = read(
    'apps/mobile/src/backend/RecipientReview.ts',
  );
  const navigation = read('apps/mobile/src/navigation/TabNavigator.tsx');
  const android = read(
    'apps/mobile/android/app/src/main/java/com/monerowallet/NativeMoneroWalletModule.kt',
  );
  const ios = read(
    'apps/mobile/ios/MoneroWallet/NativeMoneroWallet/RCTNativeMoneroWallet.mm',
  );
  const bridge = read('native/monero-bridge/cpp/FastWalletProtocolBridge.h');
  const protocolHeader = read(
    'native/fast-wallet-protocol/include/fast_wallet_protocol.h',
  );

  assert.equal(manifest.features.deviceContactDiscovery, false);
  for (const method of [
    'getPrivatePhoneParticipantStatus',
    'publishPrivatePhoneContact',
    'revokePublishedPrivatePhoneContact',
    'removePrivatePhoneParticipant',
  ]) {
    assert.match(nativeSpec, new RegExp(`\\b${method}\\s*\\(`));
    assert.match(nativeService, new RegExp(`\\b${method}\\s*\\(`));
  }
  for (const forbiddenMethod of [
    'sealPrivatePhoneContact',
    'findPrivatePhoneSnapshotParticipant',
    'decodePrivatePhoneMoneroAddress',
  ]) {
    assert.doesNotMatch(
      nativeSpec,
      new RegExp(`\\b${forbiddenMethod}\\s*\\(`),
    );
    assert.doesNotMatch(
      nativeService,
      new RegExp(`\\b${forbiddenMethod}\\s*\\(`),
    );
  }
  assert.match(
    sharing,
    /publicationStatus: 'publishing'[\s\S]+setPrivatePhoneSharedContacts[\s\S]+native\.publishPrivatePhoneContact/,
  );
  assert.match(
    sharing,
    /publicationStatus: 'revoking'[\s\S]+native\.revokePublishedPrivatePhoneContact[\s\S]+filter/,
  );
  assert.doesNotMatch(
    sharing,
    /phoneTokenHex|pairIdHex|snapshotBytes|privateKeyHex|hpkePublicKeyHex|blindedRequest/,
  );
  assert.match(screen, /privateContacts\.findTitle/);
  assert.match(screen, /privateContacts\.verifyTitle/);
  assert.match(screen, /privateContacts\.shareTitle/);
  assert.match(screen, /createPrivatePhoneSendPreset/);
  assert.match(screen, /navigation\.navigate\('Send'/);
  assert.match(send, /validatePrivatePhoneSendPreset/);
  assert.match(send, /setStep\('recipient-review'\)/);
  assert.match(send, /walletService[\s\S]+validateRecipientAddress/);
  assert.match(send, /acceptRecipientReview\(recipientReview\)/);
  assert.match(recipientReview, /addressChanged: Boolean/);
  assert.match(recipientReview, /storeProtectedMetadata/);
  assert.doesNotMatch(
    recipientReview,
    /phoneTokenHex|pairIdHex|snapshotBytes|privateKeyHex|blindedRequest/,
  );
  assert.doesNotMatch(navigation, /PrivateContacts/);
  for (const platform of [android, ios]) {
    assert.match(platform, /\/v1\/contact"/);
    assert.match(platform, /\/v1\/contact\/revoke"/);
    assert.match(platform, /\/v1\/participant\/revoke"/);
    assert.match(platform, /publishing/);
    assert.match(platform, /revoking/);
    assert.match(platform, /participant-revocation-pending/);
  }
  assert.match(android, /PRIVATE_PHONE_CONTACT_ENVELOPE_BYTES = 537/);
  assert.match(ios, /kPrivatePhoneContactEnvelopeBytes = 537/);
  assert.match(bridge, /findPrivatePhoneSnapshotParticipant/);
  assert.match(bridge, /verifiedMoneroPublicAddressParts/);
  assert.match(protocolHeader, /tex8_mfw_find_snapshot_participant_v1/);
  assert.match(protocolHeader, /tex8_mfw_decode_monero_address_v1/);
});

test('retired device-contact discovery is unrouted, permissionless, and fail-closed', () => {
  const nativeSpec = read('apps/mobile/specs/NativeMoneroWallet.ts');
  const packagedProvider = read(
    'apps/mobile/src/backend/PrivatePhoneDeviceContacts.ts',
  );
  const androidManifest = read(
    'apps/mobile/android/app/src/main/AndroidManifest.xml',
  );
  const androidBuild = read('apps/mobile/android/app/build.gradle');
  const android = read(
    'apps/mobile/android/app/src/main/java/com/monerowallet/NativeMoneroWalletModule.kt',
  );
  const iosInfo = read('apps/mobile/ios/MoneroWallet/Info.plist');
  const ios = read(
    'apps/mobile/ios/MoneroWallet/NativeMoneroWallet/RCTNativeMoneroWallet.mm',
  );
  const podfile = read('apps/mobile/ios/Podfile');
  const navigation = read('apps/mobile/src/navigation/TabNavigator.tsx');
  const menu = read('apps/mobile/src/screens/MenuScreen.tsx');

  assert.equal(manifest.features.deviceContactDiscovery, false);
  assert.match(nativeSpec, /loadPrivatePhoneDeviceContacts/);
  assert.match(nativeSpec, /requestPrivatePhoneDiscoveryConsent/);
  assert.match(nativeSpec, /revokePrivatePhoneDiscoveryConsent/);
  assert.match(packagedProvider, /if \(!provider\.featureEnabled\)/);
  assert.match(packagedProvider, /MAX_CONTACTS = 5_000/);
  assert.match(packagedProvider, /MAX_NUMBERS_PER_CONTACT = 8/);
  assert.doesNotMatch(androidManifest, /android\.permission\.READ_CONTACTS/);
  assert.match(
    androidBuild,
    /PRIVATE_PHONE_DEVICE_CONTACTS_ENABLED[\s\S]*privatePhoneDeviceContactsEnabled/,
  );
  assert.match(android, /!BuildConfig\.PRIVATE_PHONE_DEVICE_CONTACTS_ENABLED/);
  assert.match(android, /PRIVATE_PHONE_DISCOVERY_CONSENT_KEY/);
  assert.match(android, /Find people you know\?/);
  assert.match(android, /monero_wallet_contacts_consent_required/);
  assert.match(android, /requestPermissions/);
  assert.match(android, /ContactsContract\.CommonDataKinds\.Phone/);
  assert.match(android, /formatNumberToE164/);
  assert.match(android, /MAX_PRIVATE_PHONE_CONTACTS = 5_000/);
  assert.doesNotMatch(iosInfo, /NSContactsUsageDescription/);
  assert.match(iosInfo, /PRIVATE_PHONE_DEVICE_CONTACTS_ENABLED/);
  assert.match(ios, /PRIVATE_PHONE_DEVICE_CONTACTS_ENABLED/);
  assert.match(ios, /kPrivatePhoneDiscoveryConsentKey/);
  assert.match(ios, /Find people you know\?/);
  assert.match(ios, /monero_wallet_contacts_consent_required/);
  assert.match(ios, /requestAccessForEntityType:CNEntityTypeContacts/);
  assert.match(ios, /CNContactFetchRequest/);
  assert.match(ios, /NBPhoneNumberUtil/);
  assert.match(podfile, /libPhoneNumber-iOS/);
  assert.doesNotMatch(navigation, /PrivateContacts/);
  assert.doesNotMatch(menu, /PrivateContacts/);
});

test('mobile treats Fast Wallet as a recoverable local wallet', () => {
  const preference = read('packages/wallet-shared/src/fastWalletPreference.ts');
  const service = read('apps/mobile/src/backend/WalletService.ts');
  const registry = read('apps/mobile/src/backend/WalletRegistry.ts');
  const state = read('apps/mobile/src/backend/WalletState.tsx');

  assert.match(preference, /defaultFastWalletPreference[^=]*=\s*'disabled'/);
  assert.match(service, /restoreFastReceiveIdentityWithNativeSeed/);
  assert.match(service, /plaintextFastWalletHosting/);
  assert.doesNotMatch(service, /checkFastReceiveKeyImages\s*\(/);
  assert.match(registry, /kind === 'software' \|\| kind === 'fast'/);
  assert.match(state, /backupRegisteredWalletSeed/);
});

test('desktop enforces recovery and security gates below the renderer', () => {
  const native = read('apps/desktop/src-tauri/src/lib.rs');
  const release = read('apps/desktop/src-tauri/src/release_features.rs');
  const notifications = read('apps/desktop/src-tauri/src/desktop_notifications.rs');
  const renderer = read('apps/desktop/src/App.tsx');

  assert.match(native, /restore_fast_wallet_with_native_seed/);
  assert.match(native, /present_fast_wallet_recovery_seed/);
  assert.match(native, /"plaintextFastWalletHosting"/);
  assert.match(native, /"ledgerFastWallet"/);
  assert.match(native, /require_legacy_community_release/);
  assert.match(release, /unwrap_or\(false\)/);
  assert.doesNotMatch(notifications, /fallback\s*=\s*now\(\)/);
  // The renderer may explain onboarding and diagnostics, but it must never
  // receive or invoke the raw Ledger private-view-key export boundary.
  assert.match(renderer, /Fast Wallet hosting/);
  assert.doesNotMatch(
    renderer,
    /export_hardware_private_view_key|private_view_key|privateViewKey/,
  );
  assert.match(renderer, /complete balance and history are rebuilt and verified on this device/);
});

test('retired legacy scanner has no server runtime or plaintext API', () => {
  const scannerModel = read('backend/fast-wallet-worker/scanner-core/src/model.rs');
  const scannerStore = read('backend/fast-wallet-worker/scanner-core/src/store.rs');
  const scannerLibrary = read('backend/fast-wallet-worker/scanner-core/src/lib.rs');
  const mobileSpec = read('apps/mobile/specs/NativeMoneroWallet.ts');
  const androidBridge = read(
    'apps/mobile/android/app/src/main/java/com/monerowallet/NativeMoneroWalletModule.kt',
  );
  const iosBridge = read(
    'apps/mobile/ios/MoneroWallet/NativeMoneroWallet/RCTNativeMoneroWallet.mm',
  );

  assert.doesNotMatch(scannerLibrary, /pub mod api|router_with_runtime|ApiState/);
  assert.equal(existsSync(new URL('backend/notify-scanner/Cargo.toml', repo)), false);
  assert.equal(existsSync(new URL('ops/notify-scanner/notify-scanner.service', repo)), false);
  for (const source of [
    scannerModel,
    scannerStore,
    mobileSpec,
    androidBridge,
    iosBridge,
  ]) {
    assert.doesNotMatch(source, /KeyImageStatus|checkFastReceiveKeyImages/);
  }
});

test('V1 documents local sync as the only spend-state authority', () => {
  const privacy = read('docs/PRIVACY_MODEL.md');
  const executionPlan = read('docs/V1_EXECUTION_PLAN.md');

  assert.match(privacy, /No wallet key images or\s+server-side key-image status are used/);
  assert.match(executionPlan, /client does not upload key images/);
  assert.doesNotMatch(executionPlan, /WalletService\.checkFastReceiveKeyImages/);
});

test('notification gateway rejects the legacy shared-token trust boundary', () => {
  const gateway = read('backend/notification-gateway/src/lib.rs');
  const agent = read('apps/desktop/src-tauri/src/bin/monero-fast-walletd.rs');
  const deploy = read(
    'backend/notification-gateway/deploy/deploy-live-from-macos.sh',
  );

  assert.doesNotMatch(
    gateway,
    /x-fast-wallet-push-token|fast-wallet-push-events|scanner_token/,
  );
  assert.match(gateway, /WorkerAuthPurpose::Wake/);
  assert.match(gateway, /MAX_REPLAYS_PER_ASSIGNMENT/);
  assert.match(gateway, /x-fast-wallet-installation-auth/);
  assert.match(agent, /x-fast-wallet-installation-auth/);
  assert.match(deploy, /Refusing live deployment/);
});

test('Community V1 deployment protects Synapse token per file without locking sibling services out', () => {
  const deploy = read(
    'backend/enthusiast-v1/deploy/deploy-live-from-macos.sh',
  );
  const unit = read(
    'backend/enthusiast-v1/deploy/enthusiast-v1.service',
  );

  assert.match(
    deploy,
    /install -d -o root -g root -m 0755 \/etc\/monero-fast-wallet/,
  );
  assert.match(
    deploy,
    /chown root:"\$service_user" "\$admin_token_file"/,
  );
  assert.match(deploy, /chmod 0640 "\$admin_token_file"/);
  assert.match(deploy, /install-nginx-include\.py/);
  assert.match(
    unit,
    /ENTHUSIAST_SYNAPSE_ADMIN_TOKEN_FILE=\/etc\/monero-fast-wallet\/enthusiast-synapse-admin-token/,
  );
});

test('Community V1 Nginx installer inserts exactly one validated HTTPS include', () => {
  const root = mkdtempSync(join(tmpdir(), 'enthusiast-nginx-'));
  try {
    const site = join(root, 'xmr.tex8.com');
    const snippetSource = join(root, 'candidate.conf');
    const snippetDestination = join(root, 'snippets', 'enthusiast-v1.conf');
    writeFileSync(
      site,
      [
        'server {',
        '    include /etc/nginx/snippets/enthusiast-v1.conf;',
        '    listen 443 ssl; # managed',
        '    server_name xmr.tex8.com;',
        '}',
        '',
      ].join('\n'),
    );
    writeFileSync(snippetSource, 'location = /v2 { return 404; }\n');

    const result = spawnSync(
      'python3',
      [
        new URL(
          'backend/enthusiast-v1/deploy/install-nginx-include.py',
          repo,
        ).pathname,
        '--site',
        site,
        '--snippet-source',
        snippetSource,
        '--snippet-destination',
        snippetDestination,
        '--include-path',
        '/etc/nginx/snippets/enthusiast-v1.conf',
      ],
      {encoding: 'utf8'},
    );
    assert.equal(result.status, 0, result.stderr);
    const installed = readFileSync(site, 'utf8');
    assert.equal(
      installed.match(
        /include \/etc\/nginx\/snippets\/enthusiast-v1\.conf;/g,
      )?.length,
      1,
    );
    assert.match(
      installed,
      /listen 443 ssl; # managed\n    include \/etc\/nginx\/snippets\/enthusiast-v1\.conf;/,
    );
    assert.equal(statSync(snippetDestination).mode & 0o777, 0o644);
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});

test('mobile installation identifiers come only from native secure randomness', () => {
  const push = read('apps/mobile/src/backend/FastWalletPushService.ts');
  const android = read(
    'apps/mobile/android/app/src/main/java/com/monerowallet/NativeMoneroWalletModule.kt',
  );
  const ios = read(
    'apps/mobile/ios/MoneroWallet/NativeMoneroWallet/RCTNativeMoneroWallet.mm',
  );

  assert.doesNotMatch(push, /(?:installation|subscription)Id\s*=\s*[^;]*(?:Math\.random|Date\.now)/i);
  assert.doesNotMatch(push, /(?:Math\.random|Date\.now)[^;]*(?:installation|subscription)Id/i);
  assert.match(push, /registerFastWalletProvider/);
  assert.match(android, /fastWalletInstallationCredentials/);
  assert.match(ios, /fastWalletInstallationCredentials/);
  assert.match(android, /SecureRandom\(\)\.nextBytes/);
  assert.match(ios, /SecRandomCopyBytes/);
});
