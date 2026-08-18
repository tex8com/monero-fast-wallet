import {readFileSync} from 'fs';
import {resolve} from 'path';

const mobileRoot = resolve(__dirname, '..', '..', '..');
const repoRoot = resolve(mobileRoot, '..', '..');
const readMobile = (...parts: string[]) =>
  readFileSync(resolve(mobileRoot, ...parts), 'utf8');
const readRepo = (...parts: string[]) =>
  readFileSync(resolve(repoRoot, ...parts), 'utf8');

describe('Project Page and services', () => {
  const settings = readMobile('src', 'screens', 'SettingsScreen.tsx');
  const screen = readMobile('src', 'screens', 'ProjectPageScreen.tsx');
  const navigation = readMobile('src', 'navigation', 'TabNavigator.tsx');
  const shared = readRepo('packages', 'wallet-shared', 'src', 'projectServices.ts');
  const website = readRepo('website', 'src', 'App.jsx');

  it('uses one shared set of all Clearnet and Onion project routes', () => {
    expect(settings).toContain('PROJECT_PAGE_ADDRESSES.map');
    expect(screen).toContain('PROJECT_PAGE_ADDRESSES.map');
    expect(shared).toContain("address: 'xmr.tex8.com'");
    expect(shared).toContain("address: 'mfw-resolver2.tex8.com'");
    expect(shared).toContain('FIXED_MAINNET_NODES.tex8.onionHost');
    expect(shared).toContain('FIXED_MAINNET_NODES.community.onionHost');

    for (const address of [
      'xmr.tex8.com',
      'mfw-resolver2.tex8.com',
      'fastrelayrpcf3hbc4qvykjgbpwpmcuq5dpcsdxoe7gwfh2zxdib3eid.onion',
      'quietportrpccujodzxhwcfefbmhftof5i6oiq7rrx5tnzna7rxirhqd.onion',
    ]) {
      expect(website).toContain(address);
    }
  });

  it('opens a dedicated screen with self-hosting and service links', () => {
    expect(navigation).toContain(
      'name="ProjectPage" component={ProjectPageScreen}',
    );
    expect(settings).toContain("navigation.navigate('ProjectPage')");
    expect(screen).toContain("t('projectPage.ownNodeText')");
    expect(screen).toContain("t('projectPage.ownWorkerText')");
    expect(screen).toContain('PROJECT_SERVICE_LINKS.map');
    expect(screen).toContain('PROJECT_SOURCE_URL');
  });
});
