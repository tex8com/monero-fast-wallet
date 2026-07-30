import { readFileSync } from 'fs';
import { resolve } from 'path';

const mobileRoot = resolve(__dirname, '..', '..', '..');
const source = (...parts: string[]) =>
  readFileSync(resolve(mobileRoot, ...parts), 'utf8');

describe('Wallet dashboard interaction contract', () => {
  const home = source('src', 'screens', 'HomeScreen.tsx');
  const setup = source('src', 'screens', 'WalletSetupScreen.tsx');
  const wallets = source('src', 'screens', 'WalletsScreen.tsx');
  const selector = source('src', 'components', 'WalletSelector.tsx');
  const walletState = source('src', 'services', 'WalletState.tsx');
  const priceService = source('src', 'data', 'priceService.ts');

  it('opens a tapped saved wallet instead of only changing its active id', () => {
    expect(home).toContain('await openRegisteredWalletById(walletId)');
    expect(home).not.toContain(
      'changedWallet && selectedWallet?.credentialKey',
    );
    expect(setup).toContain(
      'chooseSavedWallet(registeredWallet.id).catch(() => undefined)',
    );
    expect(setup).toContain('const isFocused = useIsFocused()');
    expect(setup).toMatch(
      /useEffect\(\(\) => \{\s+if \(!isFocused\) \{\s+return;/,
    );
    expect(wallets).toContain(
      'const opened = await openRegisteredWalletById(wallet.id)',
    );
    expect(wallets).toContain('accessibilityLabel={`Open ${title}`}');
    expect(wallets).toContain("navigation.navigate('Home')");
  });

  it('deduplicates concurrent native wallet opens and shows card progress', () => {
    expect(walletState).toContain('walletOpenInFlightRef.current.get');
    expect(walletState).toContain('walletOpenInFlightRef.current.set');
    expect(selector).toContain('openingWalletId');
    expect(selector).toContain(
      '<ActivityIndicator color={colors.orange} size="small" />',
    );
  });

  it('defers network refresh until the local open promise can release the UI', () => {
    expect(walletState).toContain('deferredNativeRefreshTimeoutsRef');
    expect(walletState).toContain(
      "startNativeRefresh(registeredSession, 'sessionOpenedDeferred')",
    );
    expect(walletState).not.toContain(
      "startNativeRefresh(registeredSession, 'sessionOpened');",
    );
  });

  it('uses only the cached TEX8 public-content API', () => {
    expect(priceService).toContain('const REQUEST_TIMEOUT_MS = 6_000');
    expect(priceService).toContain('const PRICE_CACHE_KEY');
    expect(priceService).toContain(
      "const TEX8_MARKET_BASE = 'https://xmr.tex8.com/api/v1/market'",
    );
    expect(priceService).toContain('await fetchPriceFromTex8()');
    expect(priceService).toContain('await fetchTex8Chart(tf)');
    expect(priceService).not.toContain('api.coingecko.com');
    expect(priceService).not.toContain('api-pub.bitfinex.com');
    expect(priceService).toContain('loadPersistedPrice()');
    expect(home).toContain("t('home.priceUnavailable')");
  });
});
