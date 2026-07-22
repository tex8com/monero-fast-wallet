import AsyncStorage from '@react-native-async-storage/async-storage';
import { useCallback, useEffect, useState } from 'react';

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

// The phone only talks to the TEX8 feed.  The server normalises and caches
// official Monero sources, so a provider change never requires a mobile app
// release and the app does not expose a third-party API integration.
const API_URL = 'https://xmr.tex8.com/news/v1/news?limit=18';
const CACHE_KEY = '@tex8/monero/news-v1';
const CACHE_TTL_MS = 30 * 60 * 1_000;
let memoryCache: Cache | null = null;

function isFresh(cache: Cache) {
  return Date.now() - cache.updatedAt < CACHE_TTL_MS;
}

function isNewsCategory(value: unknown): value is MoneroNewsCategory {
  return value === 'network' || value === 'wallet' || value === 'ecosystem';
}

function parseNews(value: unknown): MoneroNewsItem[] {
  if (!Array.isArray(value)) return [];

  return value.flatMap(item => {
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
    ) {
      return [];
    }

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

async function loadCache(): Promise<Cache | null> {
  if (memoryCache) return memoryCache;
  try {
    const raw = await AsyncStorage.getItem(CACHE_KEY);
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

async function saveCache(items: MoneroNewsItem[]) {
  const cache = { items, updatedAt: Date.now() };
  memoryCache = cache;
  try {
    await AsyncStorage.setItem(CACHE_KEY, JSON.stringify(cache));
  } catch {
    // Caching is optional. The live feed remains usable when storage is full.
  }
  return cache;
}

async function fetchNews(force = false) {
  const cached = await loadCache();
  if (!force && cached && isFresh(cached)) return cached.items;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12_000);
  try {
    const response = await fetch(API_URL, { signal: controller.signal });
    if (!response.ok) throw new Error(`News feed unavailable (${response.status}).`);
    const payload = (await response.json()) as { items?: unknown };
    const items = parseNews(payload.items);
    if (items.length === 0) throw new Error('News feed did not include articles.');
    return (await saveCache(items)).items;
  } finally {
    clearTimeout(timeout);
  }
}

export function useMoneroNews() {
  const [items, setItems] = useState<MoneroNewsItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [unavailable, setUnavailable] = useState(false);

  const refresh = useCallback(async (force = false) => {
    setLoading(true);
    setUnavailable(false);
    try {
      setItems(await fetchNews(force));
    } catch {
      const cached = await loadCache();
      if (cached) setItems(cached.items);
      setUnavailable(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh().catch(() => undefined);
  }, [refresh]);

  return { items, loading, unavailable, refresh: () => refresh(true) };
}
