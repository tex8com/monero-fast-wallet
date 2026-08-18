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

    for (const screen of ['Wallets', 'MoneroEnthusiast', 'Settings']) {
      expect(menu).toContain(`"${screen}"`);
      expect(navigation).toContain(`name="${screen}"`);
    }
    expect(menu).toContain('v1ReleaseFeatures.mfwNameRegistration');
    expect(menu).toContain('"MfwNames", IcoKey');
    expect(menu).toContain('v1ReleaseFeatures.assistant');
    expect(menu).toContain('"Tex8Assistant", IcoSpark');
    expect(navigation).toContain('name="MfwNames"');
    expect(navigation).toContain('name="Tex8Assistant"');
    expect(tabs).toContain('key: "MoneroEnthusiast"');
    expect(tabs).toContain('"MfwNames"');
    expect(menu).not.toMatch(/FindEnthusiasts|EnthusiastChat/);
  });
});
