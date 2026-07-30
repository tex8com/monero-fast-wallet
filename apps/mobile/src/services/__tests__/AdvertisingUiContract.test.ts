import { readFileSync } from 'fs';
import { resolve } from 'path';

const repositoryRoot = resolve(__dirname, '../../../../..');
const read = (path: string) =>
  readFileSync(resolve(repositoryRoot, path), 'utf8');

describe('Private local advertising boundary', () => {
  const home = read('apps/mobile/src/screens/HomeScreen.tsx');
  const hook = read('apps/mobile/src/data/advertisements.ts');
  const service = read('apps/mobile/src/services/MoneroEnthusiastV1Service.ts');
  const android = read(
    'apps/mobile/android/app/src/main/java/com/monerowallet/MoneroEnthusiastV1Controller.kt',
  );
  const backend = read('services/monero-news/src/lib.rs');

  it('renders an explicit payer label and a local-selection explanation', () => {
    expect(home).toContain('advertisement.sponsorshipLabel');
    expect(home).toContain('advertisement.paidByDisplayName');
    expect(home).toContain("t('advertising.why')");
    expect(home).toContain('local_interests');
    expect(service).toContain('contextual_placement');
  });

  it('keeps selection and frequency state below React Native', () => {
    expect(hook).toContain('MoneroEnthusiastV1Service.advertisements()');
    expect(hook).not.toMatch(/fetch\(|axios|XMLHttpRequest|AsyncStorage/);
    expect(service).toContain("'recordAdvertisementView'");
    expect(android).toContain('communityRuntimeAdvertisements');
    expect(android).toContain('communityRuntimeRecordAdvertisementView');
    expect(android).not.toContain('/v1/ads/impressions');
    expect(backend).not.toContain('/v1/ads/impressions');
  });

  it('uses a signed bounded catalog path and remains release-gated', () => {
    const manifest = JSON.parse(read('config/v1-release-features.json')) as {
      parameters: { moneroEnthusiastV1: unknown };
      features: { moneroEnthusiastV1: boolean; news: boolean };
    };
    expect(android).toContain(
      '"v1/ads/catalog/${encodedSegment(country)}/news"',
    );
    expect(android).toContain('MAX_ADVERTISING_CATALOG_BYTES');
    expect(android).toContain('MONERO_ENTHUSIAST_ADVERTISING_KEY_HEX');
    expect(typeof manifest.features.moneroEnthusiastV1).toBe('boolean');
    if (manifest.features.moneroEnthusiastV1) {
      expect(manifest.parameters.moneroEnthusiastV1).not.toBeNull();
    }
    expect(manifest.features.news).toBe(false);
  });
});
