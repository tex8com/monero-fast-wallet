import {readFileSync} from 'fs';
import {resolve} from 'path';

const mobileRoot = resolve(__dirname, '..', '..', '..');
const read = (...parts: string[]) =>
  readFileSync(resolve(mobileRoot, ...parts), 'utf8');

describe('Private Monero news catalog', () => {
  const home = read('src', 'screens', 'HomeScreen.tsx');
  const feed = read('src', 'data', 'moneroNews.ts');

  it('loads one bounded TEX8 Onion catalog and keeps it locally', () => {
    expect(feed).toContain('/news/v1/news?limit=10');
    expect(feed).toContain("torFetch(API_URL");
    expect(feed).toContain("const CACHE_KEY = '@tex8/monero/news-v2'");
    expect(feed).toContain('const CACHE_TTL_MS = 30 * 60 * 1_000');
    expect(feed).toContain('maximumResponseBytes: 1_048_576');
  });

  it('renders a swipeable 16:9 image, text, dots, and an optional link', () => {
    expect(home).toContain('snapToInterval={NEWS_CARD_W + NEWS_CARD_GAP}');
    expect(home).toContain('aspectRatio: 16 / 9');
    expect(home).toContain('item.imageDataUrl');
    expect(home).toContain('displayedNews = visibleNews.slice(0, 10)');
    expect(home).toContain('s.newsDots');
    expect(home).toContain("t('home.newsReadMore')");
  });
});
