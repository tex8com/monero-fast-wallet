import { useCallback, useEffect, useRef, useState } from 'react';

export type MoneroNewsCategory = 'network' | 'wallet' | 'ecosystem';

export type MoneroNewsItem = {
  id: string;
  title: string;
  summary: string;
  publishedAt: string;
  category: MoneroNewsCategory;
  url: string;
};

type Cache = { items: MoneroNewsItem[]; updatedAt: number };

// Keep desktop on the same TEX8-owned, normalized feed as mobile. The client
// never presents a third-party market/news provider as a wallet authority.
const API_URL = 'https://xmr.tex8.com/news/v1/news?limit=18';
const CACHE_KEY = 'tex8-monero-news-v1';
const CACHE_TTL_MS = 30 * 60 * 1_000;
const RETRY_DELAYS_MS = [15_000, 30_000, 60_000, 5 * 60_000];
let memoryCache: Cache | null = null;

function isFresh(cache: Cache) {
  return Date.now() - cache.updatedAt < CACHE_TTL_MS;
}

function isNewsCategory(value: unknown): value is MoneroNewsCategory {
  return value === 'network' || value === 'wallet' || value === 'ecosystem';
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
      typeof candidate.url !== 'string' ||
      !isNewsCategory(candidate.category) ||
      !Number.isFinite(Date.parse(candidate.publishedAt)) ||
      !candidate.url.startsWith('https://www.getmonero.org/')
    ) return [];
    return [{
      id: candidate.id,
      title: candidate.title.trim(),
      summary: candidate.summary.trim(),
      publishedAt: candidate.publishedAt,
      category: candidate.category,
      url: candidate.url,
    }];
  });
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
    memoryCache = { items, updatedAt: parsed.updatedAt };
    return memoryCache;
  } catch {
    return null;
  }
}

function saveCache(items: MoneroNewsItem[]) {
  const cache = { items, updatedAt: Date.now() };
  memoryCache = cache;
  try { window.localStorage.setItem(CACHE_KEY, JSON.stringify(cache)); } catch { /* Cache is optional. */ }
  return cache;
}

async function fetchNews(force = false) {
  const cached = loadCache();
  if (!force && cached && isFresh(cached)) return cached.items;
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), 12_000);
  try {
    const response = await fetch(API_URL, { signal: controller.signal });
    if (!response.ok) throw new Error(`TEX8 news feed unavailable (${response.status}).`);
    const payload = await response.json() as { items?: unknown };
    const items = parseNews(payload.items);
    if (items.length === 0) throw new Error('TEX8 news feed did not include articles.');
    return saveCache(items).items;
  } finally {
    window.clearTimeout(timer);
  }
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
