import { readFileSync } from 'fs';
import { resolve } from 'path';

const mobileRoot = resolve(__dirname, '..', '..', '..');
const read = (...parts: string[]) =>
  readFileSync(resolve(mobileRoot, ...parts), 'utf8');

describe('mobile menu surface contract', () => {
  it('keeps release-ready destinations discoverable and unfinished services explicitly gated', () => {
    const menu = read('src', 'screens', 'MenuScreen.tsx');
    const navigation = read('src', 'navigation', 'TabNavigator.tsx');
    const tabs = read('src', 'components', 'CustomTabBar.tsx');

    for (const screen of ['Wallets', 'Settings']) {
      expect(menu).toMatch(new RegExp(`["']${screen}["']`));
      expect(navigation).toContain(`name="${screen}"`);
    }
    expect(menu).toContain('v1ReleaseFeatures.mfwNameRegistration');
    expect(menu).toMatch(/["']MfwNames["'], IcoKey/);
    expect(menu).toContain('v1ReleaseFeatures.vanityAddress');
    expect(menu).toMatch(/["']VanityAddress["'], IcoKey/);
    expect(menu).toContain('v1ReleaseFeatures.assistant');
    expect(menu).toContain('v1ReleaseFeatures.moneroEnthusiastV1');
    expect(menu).toMatch(/["']Tex8Assistant["']/);
    expect(menu).toContain('IcoSpark');
    expect(navigation).toContain('name="MfwNames"');
    expect(navigation).toContain('name="VanityAddress"');
    expect(navigation).toContain('name="VanityPayment"');
    expect(navigation).toContain('v1ReleaseFeatures.vanityAddress');
    expect(navigation).toContain('name="Tex8Assistant"');
    expect(tabs).toContain('key: "MoneroEnthusiast"');
    expect(tabs).toContain('v1ReleaseFeatures.moneroEnthusiastV1');
    expect(tabs).toContain('"MfwNames"');
    expect(menu).not.toMatch(/FindEnthusiasts|EnthusiastChat/);
    const release = JSON.parse(
      read('..', '..', 'config', 'v1-release-features.json'),
    );
    expect(release.features.vanityAddress).toBe(false);
    expect(release.features.moneroEnthusiastV1).toBe(false);
  });
});
