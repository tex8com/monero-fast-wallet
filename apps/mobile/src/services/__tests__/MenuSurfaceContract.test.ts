import { readFileSync } from 'fs';
import { resolve } from 'path';

const mobileRoot = resolve(__dirname, '..', '..', '..');
const read = (...parts: string[]) =>
  readFileSync(resolve(mobileRoot, ...parts), 'utf8');

describe('mobile menu surface contract', () => {
  it('keeps every local V1 destination discoverable without activating unfinished services', () => {
    const menu = read('src', 'screens', 'MenuScreen.tsx');
    const navigation = read('src', 'navigation', 'TabNavigator.tsx');
    const tabs = read('src', 'components', 'CustomTabBar.tsx');

    for (const screen of [
      'Wallets',
      'MfwNames',
      'MoneroEnthusiast',
      'Settings',
      'Tex8Assistant',
    ]) {
      expect(menu).toContain(`screen: "${screen}"`);
      expect(navigation).toContain(`name="${screen}"`);
    }
    expect(tabs).toContain('key: "MoneroEnthusiast"');
    expect(tabs).toContain('"MfwNames"');
    expect(menu).not.toMatch(/FindEnthusiasts|EnthusiastChat/);
  });
});
