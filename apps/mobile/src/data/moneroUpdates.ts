import AsyncStorage from '@react-native-async-storage/async-storage';
import { useCallback, useEffect, useState } from 'react';
import {torFetch} from '../services/TorHttp';

export type MoneroUpdate = {
  id: string;
  publishedAt: string;
  title: string;
  url: string;
};

type Cache = { items: MoneroUpdate[]; updatedAt: number };

const API_URL = 'https://api.github.com/repos/monero-project/monero/releases?per_page=3';
const CACHE_KEY = '@tex8/monero/official-updates';
const CACHE_TTL_MS = 30 * 60 * 1_000;
let memoryCache: Cache | null = null;

function isFresh(cache: Cache) {
  return Date.now() - cache.updatedAt < CACHE_TTL_MS;
}

function parseUpdates(value: unknown): MoneroUpdate[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap(item => {
    if (!item || typeof item !== 'object') return [];
    const release = item as {id?: unknown; name?: unknown; tag_name?: unknown; published_at?: unknown; html_url?: unknown};
    const title = typeof release.name === 'string' && release.name.trim() ? release.name.trim() : typeof release.tag_name === 'string' ? release.tag_name : '';
    if (typeof release.id !== 'number' || !title || typeof release.published_at !== 'string' || typeof release.html_url !== 'string') return [];
    if (!Number.isFinite(Date.parse(release.published_at)) || !release.html_url.startsWith('https://github.com/monero-project/monero/')) return [];
    return [{id: String(release.id), title, publishedAt: release.published_at, url: release.html_url}];
  });
}

async function loadCache(): Promise<Cache | null> {
  if (memoryCache) return memoryCache;
  try {
    const raw = await AsyncStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<Cache>;
    if (typeof parsed.updatedAt !== 'number') return null;
    const items = parseUpdates(parsed.items);
    if (items.length === 0) return null;
    memoryCache = {items, updatedAt: parsed.updatedAt};
    return memoryCache;
  } catch {
    return null;
  }
}

async function saveCache(items: MoneroUpdate[]) {
  const cache = {items, updatedAt: Date.now()};
  memoryCache = cache;
  try { await AsyncStorage.setItem(CACHE_KEY, JSON.stringify(cache)); } catch { /* Optional cache only. */ }
  return cache;
}

async function fetchUpdates(force = false) {
  const cached = await loadCache();
  if (!force && cached && isFresh(cached)) return cached.items;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12_000);
  try {
    const response = await torFetch(API_URL, {headers: {Accept: 'application/vnd.github+json'}, signal: controller.signal, timeoutMs: 12_000});
    if (!response.ok) throw new Error(`Official update feed unavailable (${response.status}).`);
    const items = parseUpdates(await response.json());
    if (items.length === 0) throw new Error('Official update feed did not include releases.');
    return (await saveCache(items)).items;
  } finally {
    clearTimeout(timeout);
  }
}

export function useMoneroUpdates() {
  const [items, setItems] = useState<MoneroUpdate[]>([]);
  const [loading, setLoading] = useState(true);
  const [unavailable, setUnavailable] = useState(false);
  const refresh = useCallback((force = false) => {
    setLoading(true);
    setUnavailable(false);
    fetchUpdates(force)
      .then(setItems)
      .catch(() => setUnavailable(true))
      .finally(() => setLoading(false));
  }, []);
  useEffect(() => { refresh(); }, [refresh]);
  return {items, loading, unavailable, refresh: () => refresh(true)};
}
