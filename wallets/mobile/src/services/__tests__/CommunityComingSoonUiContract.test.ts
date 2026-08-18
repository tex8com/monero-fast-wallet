import {readFileSync} from 'fs';
import {resolve} from 'path';

const mobileRoot = resolve(__dirname, '..', '..', '..');
const read = (...parts: string[]) =>
  readFileSync(resolve(mobileRoot, ...parts), 'utf8');

describe('Locked Community preview', () => {
  const navigation = read('src', 'navigation', 'TabNavigator.tsx');
  const preview = read('src', 'screens', 'CommunityComingSoonScreen.tsx');
  const translations = read('src', 'i18n', 'translations.ts');

  it('routes Community to a static coming-soon screen', () => {
    expect(navigation).toContain(
      'name="MoneroEnthusiast" component={CommunityComingSoonScreen}',
    );
    expect(navigation).not.toContain(
      'component={MoneroEnthusiastScreen}',
    );
    expect(navigation).not.toMatch(
      /component=\{FindEnthusiastsScreen\}|component=\{EnthusiastChatScreen\}/,
    );
    expect(preview).not.toMatch(
      /MoneroEnthusiastV1Service|requireNativeMoneroWallet|invoke\(/,
    );
  });

  it('shows the agreed Community scope and regulatory boundary', () => {
    for (const key of [
      'communitySoon.bulletinTitle',
      'communitySoon.meetTitle',
      'communitySoon.matrixTitle',
      'communitySoon.profilesTitle',
      'communitySoon.verifiedTitle',
      'communitySoon.noMarketplaceTitle',
    ]) {
      expect(preview).toContain(key);
      expect(translations).toContain(key);
    }
    expect(translations).toContain('Schwarzes Brett');
    expect(translations).toContain('Matrix-Chat');
    expect(translations).toContain('Kein Marktplatz');
  });
});
