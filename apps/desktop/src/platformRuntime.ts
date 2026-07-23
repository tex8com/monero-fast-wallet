import { createDesktopProductRuntime } from '@tex8/customer-desktop';

/**
 * The wallet remains privacy-specialised; this only centralises public app
 * composition, module versions and runtime detection.
 */
export const moneroWalletPlatformRuntime = createDesktopProductRuntime({
  productId: 'monero-fast-wallet',
  tenantId: 'tex8',
  shopId: 'monero-fast-wallet',
  appId: 'monero-fast-wallet-desktop',
  apiBaseUrl: import.meta.env.VITE_MONERO_WALLET_API_URL || '',
  locale: 'en',
  locales: ['en', 'de', 'es'],
  capabilities: { notifications: true },
});
