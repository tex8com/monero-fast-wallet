import AsyncStorage from '@react-native-async-storage/async-storage';
import { useCallback, useEffect, useRef, useState } from 'react';
import {PRIMARY_PRIVATE_SERVICE_ORIGIN} from '../../../../packages/wallet-shared/src/nodePresets';
import {torFetch} from '../backend/TorHttp';

export type MoneroNewsCategory = 'network' | 'wallet' | 'ecosystem';

export type MoneroNewsItem = {
  id: string;
  title: string;
  summary: string;
  publishedAt: string;
  category: MoneroNewsCategory;
  url?: string;
  imageDataUrl?: string;
};

type Cache = { items: MoneroNewsItem[]; updatedAt: number };

// The phone only talks to the TEX8 feed.  The server normalises and caches
// official Monero sources, so a provider change never requires a mobile app
// release and the app does not expose a third-party API integration.
const API_URL = `${PRIMARY_PRIVATE_SERVICE_ORIGIN}/news/v1/news?limit=10`;
const CACHE_KEY = '@tex8/monero/news-v2';
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

  return value.flatMap(item => {
    if (!item || typeof item !== 'object') return [];
    const candidate = item as Partial<MoneroNewsItem>;
    if (
      typeof candidate.id !== 'string' ||
      typeof candidate.title !== 'string' ||
      typeof candidate.summary !== 'string' ||
      typeof candidate.publishedAt !== 'string' ||
      !isNewsCategory(candidate.category) ||
      !Number.isFinite(Date.parse(candidate.publishedAt))
    ) {
      return [];
    }

    const url =
      typeof candidate.url === 'string' &&
      candidate.url.startsWith('https://www.getmonero.org/')
        ? candidate.url
        : undefined;
    const imageDataUrl =
      typeof candidate.imageDataUrl === 'string' &&
      candidate.imageDataUrl.startsWith('data:image/jpeg;base64,') &&
      candidate.imageDataUrl.length <= 100_000
        ? candidate.imageDataUrl
        : undefined;

    return [{
      id: candidate.id,
      title: candidate.title.trim(),
      summary: candidate.summary.trim(),
      publishedAt: candidate.publishedAt,
      category: candidate.category,
      url,
      imageDataUrl,
    }];
  }).slice(0, 10);
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
  const timeout = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await torFetch(API_URL, {
      signal: controller.signal,
      timeoutMs: 20_000,
      maximumResponseBytes: 1_048_576,
    });
    if (!response.ok) throw new Error(`News feed unavailable (${response.status}).`);
    const payload = (await response.json()) as { items?: unknown };
    const items = parseNews(payload.items);
    if (items.length === 0) throw new Error('News feed did not include articles.');
    return (await saveCache(items)).items;
  } finally {
    clearTimeout(timeout);
  }
}

export function useMoneroNews(enabled = true) {
  const [items, setItems] = useState<MoneroNewsItem[]>([]);
  const [loading, setLoading] = useState(enabled);
  const [unavailable, setUnavailable] = useState(false);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retryAttempt = useRef(0);
  const clearRetry = useCallback(() => {
    if (retryTimer.current) {
      clearTimeout(retryTimer.current);
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
      const cached = await loadCache();
      if (cached) setItems(cached.items);
      setUnavailable(true);
      const delay = RETRY_DELAYS_MS[Math.min(retryAttempt.current, RETRY_DELAYS_MS.length - 1)];
      retryAttempt.current += 1;
      retryTimer.current = setTimeout(() => {
        retryTimer.current = null;
        refresh(true, true).catch(() => undefined);
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
    refresh().catch(() => undefined);
    return clearRetry;
  }, [clearRetry, enabled, refresh]);

  return { items, loading, unavailable, refresh: () => refresh(true) };
}
