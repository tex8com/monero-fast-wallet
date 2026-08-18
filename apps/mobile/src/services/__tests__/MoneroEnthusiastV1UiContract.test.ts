import { readFileSync } from 'fs';
import { resolve } from 'path';

const repositoryRoot = resolve(__dirname, '../../../../..');
const read = (path: string) =>
  readFileSync(resolve(repositoryRoot, path), 'utf8');

describe('Monero Enthusiast V1 app boundary', () => {
  it('uses a separate discoverable route and never imports the legacy chat client', () => {
    const navigation = read('apps/mobile/src/navigation/TabNavigator.tsx');
    const menu = read('apps/mobile/src/screens/MenuScreen.tsx');
    const tabs = read('apps/mobile/src/components/CustomTabBar.tsx');
    const screen = read('apps/mobile/src/screens/MoneroEnthusiastScreen.tsx');
    const service = read(
      'apps/mobile/src/backend/MoneroEnthusiastV1Service.ts',
    );

    expect(navigation).toContain('name="MoneroEnthusiast"');
    expect(menu).toContain('"MoneroEnthusiast", IcoCommunity');
    expect(tabs).toContain('key: "MoneroEnthusiast"');
    expect(screen).toContain('getMoneroEnthusiastV1Status');
    expect(screen).toContain('MoneroEnthusiastV1Service.search');
    expect(screen).toContain('submitProductListing');
    expect(screen).toContain("kind: 'product_listing'");
    expect(screen).toContain('MoneroEnthusiastV1Service.submitContent(draft)');
    expect(service).toContain('confirmedExactMessage');
    expect(service).toContain('runMoneroEnthusiastV1Operation');
    expect(service).toContain('FORBIDDEN_NATIVE_FIELDS');
    expect(screen).not.toMatch(
      /FindEnthusiasts|EnthusiastChat|community_(?:load|list|send)|\/v1\/nearby|\/v1\/conversations/,
    );
    expect(screen).not.toMatch(
      /accessToken|matrixSession|privateKey|fetch\(|axios|XMLHttpRequest/,
    );
  });

  it('fails closed until the verified native packages are present', () => {
    const android = read(
      'apps/mobile/android/app/src/main/java/com/monerowallet/NativeMoneroWalletModule.kt',
    );
    const ios = read(
      'apps/mobile/ios/MoneroWallet/NativeMoneroWallet/RCTNativeMoneroWallet.mm',
    );
    const iosController = read(
      'apps/mobile/ios/MoneroWallet/NativeMoneroWallet/MoneroEnthusiastV1Controller.inc',
    );
    const androidBuild = read('apps/mobile/android/app/build.gradle');
    const androidCmake = read(
      'apps/mobile/android/app/src/main/cpp/CMakeLists.txt',
    );
    const androidJni = read(
      'apps/mobile/android/app/src/main/cpp/NativeMoneroWalletJni.cpp',
    );
    const iosProject = read(
      'apps/mobile/ios/MoneroWallet.xcodeproj/project.pbxproj',
    );
    const manifest = JSON.parse(read('config/v1-release-features.json')) as {
      parameters: { moneroEnthusiastV1: unknown };
      features: { moneroEnthusiastV1: boolean; legacyCommunity: boolean };
    };

    expect(typeof manifest.features.moneroEnthusiastV1).toBe('boolean');
    if (manifest.features.moneroEnthusiastV1) {
      expect(manifest.parameters.moneroEnthusiastV1).not.toBeNull();
    }
    expect(manifest.features.legacyCommunity).toBe(false);
    expect(android).toContain('override fun getMoneroEnthusiastV1Status');
    expect(android).toContain('moneroEnthusiastV1.status()');
    expect(android).toContain(
      'moneroEnthusiastV1.execute(operation, inputJson)',
    );
    expect(androidBuild).toContain('MONERO_COMMUNITY_MATRIX_LIBRARY');
    expect(androidBuild).toContain('MONERO_COMMUNITY_HARRIER_LIBRARY');
    expect(androidCmake).toContain('TEX8_COMMUNITY_MATRIX_LINKED=1');
    expect(androidCmake).toContain('TEX8_COMMUNITY_RUNTIME_LINKED=1');
    expect(androidJni).toContain('tex8_community_matrix_link_anchor_v1');
    expect(androidJni).toContain('tex8_community_runtime_link_anchor_v1');
    expect(ios).toContain('getMoneroEnthusiastV1Status');
    expect(ios).toContain('runMoneroEnthusiastV1Operation');
    expect(iosController).toContain('tex8_community_matrix_link_anchor_v1');
    expect(iosController).toContain('tex8_community_runtime_link_anchor_v1');
    expect(iosController).toContain('willPerformHTTPRedirection');
    expect(iosController).toContain('kCommunityV1MatrixSessionKey');
    expect(iosProject).toContain('MONERO_COMMUNITY_MATRIX_LIBRARY');
    expect(iosProject).toContain('MONERO_COMMUNITY_HARRIER_LIBRARY');
  });

  it('keeps entered-query caching encrypted native bounded and user-clearable', () => {
    const core = read('packages/community-search-core/src/local_query.rs');
    const runtime = read('native/community-runtime-core/src/lib.rs');
    const screen = read('apps/mobile/src/screens/MoneroEnthusiastScreen.tsx');
    const service = read(
      'apps/mobile/src/backend/MoneroEnthusiastV1Service.ts',
    );
    const android = read(
      'apps/mobile/android/app/src/main/java/com/monerowallet/MoneroEnthusiastV1Controller.kt',
    );
    const ios = read(
      'apps/mobile/ios/MoneroWallet/NativeMoneroWallet/MoneroEnthusiastV1Controller.inc',
    );

    expect(core).toContain('DEFAULT_LOCAL_QUERY_CACHE_CAPACITY: usize = 512');
    expect(core).toContain('XChaCha20Poly1305');
    expect(core).toContain('LOCAL_QUERY_LOW_USE_MAX_AGE_MS');
    expect(core).toContain('ORDER BY use_count ASC, last_used_ms ASC');
    expect(runtime).toContain('open_with_keys_and_query_cache');
    expect(runtime).toContain('cache.record(&request.query');
    expect(runtime).toContain('for suggestion in local');
    expect(runtime).toContain('for suggestion in downloaded');
    expect(service).toContain(
      "runCommunityV1<CommunityV1QuerySuggestion[]>('suggestions'",
    );
    expect(service).toContain("runCommunityV1('clearSearchHistory')");
    expect(screen).toContain('MoneroEnthusiastV1Service.suggestions');
    expect(screen).toContain('suggestion.displayText');
    expect(android).toContain('monero.community.v1.query-cache-key');
    expect(android).toContain('communityRuntimeClearQueryCache');
    expect(ios).toContain('kCommunityV1QueryCacheKey');
    expect(ios).toContain('tex8_community_runtime_clear_query_cache_v1');
    expect(screen).not.toMatch(/fetch\(|axios|XMLHttpRequest/);
  });

  it('learns from bounded UI events only inside encrypted native storage', () => {
    const runtime = read('native/community-runtime-core/src/lib.rs');
    const core = read('packages/community-search-core/src/store.rs');
    const screen = read('apps/mobile/src/screens/MoneroEnthusiastScreen.tsx');
    const service = read(
      'apps/mobile/src/backend/MoneroEnthusiastV1Service.ts',
    );
    const android = read(
      'apps/mobile/android/app/src/main/java/com/monerowallet/MoneroEnthusiastV1Controller.kt',
    );
    const ios = read(
      'apps/mobile/ios/MoneroWallet/NativeMoneroWallet/MoneroEnthusiastV1Controller.inc',
    );

    expect(runtime).toContain('search_personalized');
    expect(runtime).toContain('seal_for_protected_storage');
    expect(runtime).toContain('INTEREST_STATE_FILE');
    expect(core).toContain('pub fn interest_item');
    expect(service).toContain("runCommunityV1<{ status: string }>('recordInterest'");
    expect(screen).toContain("'content_opened'");
    expect(screen).toContain("'longer_local_view'");
    expect(screen).toContain("'contact_requested'");
    expect(android).toContain('"recordInterest" -> recordInterest(input)');
    expect(ios).toContain('isEqualToString:@"recordInterest"');
    expect(screen).not.toMatch(/embedding|fetch\(|axios|XMLHttpRequest/);
  });

  it('shares completed search terms by default with visible Welcome and Settings controls', () => {
    const contribution = read(
      'apps/mobile/src/backend/CommunityQueryContribution.ts',
    );
    const screen = read('apps/mobile/src/screens/MoneroEnthusiastScreen.tsx');
    const welcome = read('apps/mobile/src/screens/WelcomeScreen.tsx');
    const settings = read('apps/mobile/src/screens/SettingsScreen.tsx');
    const android = read(
      'apps/mobile/android/app/src/main/java/com/monerowallet/MoneroEnthusiastV1Controller.kt',
    );
    const ios = read(
      'apps/mobile/ios/MoneroWallet/NativeMoneroWallet/MoneroEnthusiastV1Controller.inc',
    );

    expect(contribution).toContain('enabled: true');
    expect(contribution).toContain('MAX_PENDING_CONTRIBUTIONS = 64');
    expect(contribution).toContain('isSafeCommunityQueryContribution');
    expect(screen).toContain('contributeSuccessfulCommunityQuery');
    expect(screen.indexOf('MoneroEnthusiastV1Service.search')).toBeLessThan(
      screen.indexOf('contributeSuccessfulCommunityQuery(submittedQuery'),
    );
    expect(welcome).toContain('setCommunityQueryContributionEnabled');
    expect(settings).toContain('setCommunityQueryContributionEnabled');
    expect(welcome).toContain('<Switch');
    expect(settings).toContain('<Switch');
    expect(android).toContain('"contributeQuery" -> contributeQuery(input)');
    expect(android).toContain('"v2/query-contributions"');
    expect(android).toContain('isSafeContributionQuery');
    expect(ios).toContain('isEqualToString:@"contributeQuery"');
    expect(ios).toContain('@"v2/query-contributions"');
    expect(ios).toContain('communityV1SafeContributionQuery');
    expect(screen).not.toMatch(/fetch\(|axios|XMLHttpRequest/);
  });
});
