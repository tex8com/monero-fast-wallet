import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';

export type MoneroNewsCategory = 'network' | 'wallet' | 'ecosystem';

export type MoneroNewsItem = {
  id: string;
  title: string;
  summary: string;
  publishedAt: string;
  category: MoneroNewsCategory;
  url?: string;
  imageUrl?: string;
};

type Cache = { items: MoneroNewsItem[]; catalogHash?: string; updatedAt: number };

// Keep desktop on the same TEX8-owned catalog as mobile. The client never
// presents a third-party market/news provider as a wallet authority.
const API_URL = 'Monero Fast Wallet Onion news service';
const CATALOG_HASH_SERVICE = 'Monero Fast Wallet Onion news catalog hash';
const CACHE_KEY = 'tex8-monero-news-v3';
const NEWS_IMAGE_PREFIX = 'https://cdn.tex8.com/tex8-images/monero-fast-wallet/news/v1/';
const NEWS_IMAGE_URL_PATTERN = /^https:\/\/cdn\.tex8\.com\/tex8-images\/monero-fast-wallet\/news\/v1\/[a-z0-9-]+\/[a-z0-9-]+\.webp$/;
const RETRY_DELAYS_MS = [15_000, 30_000, 60_000, 5 * 60_000];
let memoryCache: Cache | null = null;

function isNewsCategory(value: unknown): value is MoneroNewsCategory {
  return value === 'network' || value === 'wallet' || value === 'ecosystem';
}

function isCatalogHash(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

function isNewsImageUrl(value: unknown): value is string {
  return typeof value === 'string'
    && value.startsWith(NEWS_IMAGE_PREFIX)
    && NEWS_IMAGE_URL_PATTERN.test(value);
}

function parseNews(value: unknown): MoneroNewsItem[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const candidate = item as Partial<MoneroNewsItem>;
    if (
      typeof candidate.id !== 'string' ||
      typeof candidate.title !== 'string' ||
      typeof candidate.summary !== 'string' ||
      typeof candidate.publishedAt !== 'string' ||
      !isNewsCategory(candidate.category) ||
      !Number.isFinite(Date.parse(candidate.publishedAt))
    ) return [];
    const url = typeof candidate.url === 'string'
      && candidate.url.startsWith('https://www.getmonero.org/')
      ? candidate.url
      : undefined;
    const imageUrl = isNewsImageUrl(candidate.imageUrl)
      ? candidate.imageUrl
      : undefined;
    return [{
      id: candidate.id,
      title: candidate.title.trim(),
      summary: candidate.summary.trim(),
      publishedAt: candidate.publishedAt,
      category: candidate.category,
      url,
      imageUrl,
    }];
  }).slice(0, 10);
}

function loadCache(): Cache | null {
  if (memoryCache) return memoryCache;
  try {
    const raw = window.localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<Cache>;
    if (typeof parsed.updatedAt !== 'number') return null;
    const items = parseNews(parsed.items);
    if (items.length === 0) return null;
    memoryCache = {
      items,
      catalogHash: isCatalogHash(parsed.catalogHash) ? parsed.catalogHash : undefined,
      updatedAt: parsed.updatedAt,
    };
    return memoryCache;
  } catch {
    return null;
  }
}

function saveCache(items: MoneroNewsItem[], catalogHash?: string) {
  const cache = { items, catalogHash, updatedAt: Date.now() };
  memoryCache = cache;
  try { window.localStorage.setItem(CACHE_KEY, JSON.stringify(cache)); } catch { /* Cache is optional. */ }
  return cache;
}

async function fetchNews(force = false) {
  const cached = loadCache();
  if (!force && cached?.catalogHash) {
    try {
      if ((await fetchCatalogHash()) === cached.catalogHash) return cached.items;
    } catch {
      return cached.items;
    }
  }
  try {
    const payload = JSON.parse(await invoke<string>('fetch_private_service', {
      input: { kind: 'news' },
    })) as { catalogHash?: unknown; items?: unknown };
    const items = parseNews(payload.items);
    if (items.length === 0) throw new Error(`${API_URL} did not include articles.`);
    return saveCache(
      items,
      isCatalogHash(payload.catalogHash) ? payload.catalogHash : undefined,
    ).items;
  } catch (error) {
    throw error;
  }
}

async function fetchCatalogHash(): Promise<string> {
  const payload = JSON.parse(await invoke<string>('fetch_private_service', {
    input: { kind: 'news-catalog-hash' },
  })) as { catalogHash?: unknown };
  if (!isCatalogHash(payload.catalogHash)) {
    throw new Error(`${CATALOG_HASH_SERVICE} did not include a valid hash.`);
  }
  return payload.catalogHash;
}

export function useMoneroNews(enabled = true) {
  const cached = enabled ? loadCache() : null;
  const [items, setItems] = useState<MoneroNewsItem[]>(() => cached?.items ?? []);
  const [loading, setLoading] = useState(enabled && !cached);
  const [unavailable, setUnavailable] = useState(false);
  const retryTimer = useRef<number | null>(null);
  const retryAttempt = useRef(0);
  const clearRetry = useCallback(() => {
    if (retryTimer.current !== null) {
      window.clearTimeout(retryTimer.current);
      retryTimer.current = null;
    }
  }, []);
  const refresh = useCallback(async (force = false, automatic = false) => {
    if (!enabled) {
      clearRetry();
      setItems([]);
      setLoading(false);
      setUnavailable(false);
      return;
    }
    if (!automatic) {
      clearRetry();
      retryAttempt.current = 0;
    }
    setLoading(true);
    setUnavailable(false);
    try {
      setItems(await fetchNews(force));
      retryAttempt.current = 0;
    } catch {
      setUnavailable(true);
      const delay = RETRY_DELAYS_MS[Math.min(retryAttempt.current, RETRY_DELAYS_MS.length - 1)];
      retryAttempt.current += 1;
      retryTimer.current = window.setTimeout(() => {
        retryTimer.current = null;
        void refresh(true, true);
      }, delay);
    } finally {
      setLoading(false);
    }
  }, [clearRetry, enabled]);
  useEffect(() => {
    if (!enabled) {
      clearRetry();
      setItems([]);
      setLoading(false);
      setUnavailable(false);
      return clearRetry;
    }
    void refresh();
    return clearRetry;
  }, [clearRetry, enabled, refresh]);
  return { items, loading, unavailable, refresh: () => refresh(true) };
}
