import AsyncStorage from '@react-native-async-storage/async-storage';
import { useCallback, useEffect, useState } from 'react';
import {PRIMARY_PRIVATE_SERVICE_ORIGIN} from '../../../../packages/wallet-shared/src/nodePresets';
import {torFetch} from '../services/TorHttp';

const TEX8_MARKET_BASE = `${PRIMARY_PRIVATE_SERVICE_ORIGIN}/api/v1/market`;
const CACHE_TTL = 60_000;
const PERSISTED_PRICE_TTL = 24 * 60 * 60 * 1_000;
const PERSISTED_CHART_TTL = 24 * 60 * 60 * 1_000;
const REQUEST_TIMEOUT_MS = 6_000;
const PRICE_CACHE_KEY = '@tex8/monero/market-price';
const CHART_CACHE_PREFIX = '@tex8/monero/market-chart/';

export interface PriceData {
  price: number;
  change24h: number;
  loading: boolean;
  error: boolean;
  refresh: () => void;
}

export interface ChartPoint {
  price: number;
  timestamp: number;
}

export interface ChartData {
  points: ChartPoint[];
  loading: boolean;
  error: boolean;
  refresh: () => void;
}

type ChartCache = { points: ChartPoint[]; ts: number };
type PriceCache = { price: number; change24h: number; ts: number };

let cachedPrice: PriceCache | null = null;
const chartCache: Record<string, ChartCache | undefined> = {};

async function fetchJson(
  url: string,
  timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await torFetch(url, {
      headers: { Accept: 'application/json' },
      signal: controller.signal,
      timeoutMs,
    });
    if (!response.ok) {
      throw new Error(`Market data request failed with HTTP ${response.status}.`);
    }
    return response.json();
  } finally {
    clearTimeout(timeout);
  }
}

function validPoint(timestamp: unknown, price: unknown): ChartPoint | null {
  if (
    typeof timestamp !== 'number' ||
    !Number.isFinite(timestamp) ||
    typeof price !== 'number' ||
    !Number.isFinite(price) ||
    price <= 0
  ) {
    return null;
  }
  return { timestamp, price };
}

function tex8Quote(
  value: unknown,
): { price: number; change24h: number } | null {
  if (!value || typeof value !== 'object') return null;
  const quote = value as { price?: unknown; change24h?: unknown };
  if (
    typeof quote.price !== 'number' ||
    !Number.isFinite(quote.price) ||
    quote.price <= 0 ||
    typeof quote.change24h !== 'number' ||
    !Number.isFinite(quote.change24h)
  ) {
    return null;
  }
  return { price: quote.price, change24h: quote.change24h };
}

function tex8Points(value: unknown): ChartPoint[] {
  if (
    !value ||
    typeof value !== 'object' ||
    !Array.isArray((value as { points?: unknown }).points)
  ) {
    return [];
  }
  return (value as { points: unknown[] }).points.flatMap(entry => {
    if (!entry || typeof entry !== 'object') return [];
    const point = entry as { timestamp?: unknown; price?: unknown };
    const valid = validPoint(point.timestamp, point.price);
    return valid ? [valid] : [];
  });
}

function downsampleChartPoints(points: ChartPoint[], maximum = 120): ChartPoint[] {
  if (points.length <= maximum) return points;
  return Array.from(
    { length: maximum },
    (_, index) => points[Math.round((index * (points.length - 1)) / (maximum - 1))],
  );
}

async function loadPersistedChart(tf: string): Promise<ChartCache | null> {
  if (chartCache[tf]) return chartCache[tf] ?? null;
  try {
    const raw = await AsyncStorage.getItem(`${CHART_CACHE_PREFIX}${tf}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { points?: unknown; ts?: unknown };
    if (typeof parsed.ts !== 'number' || Date.now() - parsed.ts > PERSISTED_CHART_TTL || !Array.isArray(parsed.points)) {
      return null;
    }
    const points = parsed.points.flatMap(point => {
      if (!point || typeof point !== 'object') return [];
      const valid = validPoint((point as ChartPoint).timestamp, (point as ChartPoint).price);
      return valid ? [valid] : [];
    });
    if (points.length < 2) return null;
    const cached = { points, ts: parsed.ts };
    chartCache[tf] = cached;
    return cached;
  } catch {
    return null;
  }
}

async function loadPersistedPrice(): Promise<PriceCache | null> {
  if (cachedPrice) return cachedPrice;
  try {
    const raw = await AsyncStorage.getItem(PRICE_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PriceCache>;
    if (
      typeof parsed.ts !== 'number' ||
      Date.now() - parsed.ts > PERSISTED_PRICE_TTL ||
      typeof parsed.price !== 'number' ||
      !Number.isFinite(parsed.price) ||
      parsed.price <= 0 ||
      typeof parsed.change24h !== 'number' ||
      !Number.isFinite(parsed.change24h)
    ) {
      return null;
    }
    cachedPrice = {
      price: parsed.price,
      change24h: parsed.change24h,
      ts: parsed.ts,
    };
    return cachedPrice;
  } catch {
    return null;
  }
}

async function persistPrice(
  value: Omit<PriceCache, 'ts'>,
): Promise<PriceCache> {
  const cached = { ...value, ts: Date.now() };
  cachedPrice = cached;
  try {
    await AsyncStorage.setItem(PRICE_CACHE_KEY, JSON.stringify(cached));
  } catch {
    // The live quote remains useful even if optional local caching fails.
  }
  return cached;
}

async function persistChart(tf: string, points: ChartPoint[]): Promise<ChartCache> {
  const cached = { points, ts: Date.now() };
  chartCache[tf] = cached;
  try {
    await AsyncStorage.setItem(`${CHART_CACHE_PREFIX}${tf}`, JSON.stringify(cached));
  } catch {
    // A market chart remains useful even if optional local caching is unavailable.
  }
  return cached;
}

async function fetchPriceFromTex8(): Promise<{
  price: number;
  change24h: number;
}> {
  const result = tex8Quote(await fetchJson(`${TEX8_MARKET_BASE}/quote`));
  if (!result) {
    throw new Error('TEX8 market API did not return a valid XMR/USD quote.');
  }
  return result;
}

async function fetchPrice(
  force = false,
): Promise<{ price: number; change24h: number }> {
  if (!force && cachedPrice && Date.now() - cachedPrice.ts < CACHE_TTL) {
    return cachedPrice;
  }
  const result = await fetchPriceFromTex8();
  return persistPrice(result);
}

async function fetchTex8Chart(tf: string): Promise<ChartPoint[]> {
  const data = await fetchJson(
    `${TEX8_MARKET_BASE}/chart?timeframe=${encodeURIComponent(tf)}`,
  );
  const points = downsampleChartPoints(tex8Points(data));
  if (points.length < 2) {
    throw new Error('TEX8 market API did not return enough chart points.');
  }
  return points;
}

async function fetchChart(tf: string, force = false): Promise<ChartPoint[]> {
  const existing = chartCache[tf];
  if (!force && existing && Date.now() - existing.ts < CACHE_TTL * 5) return existing.points;
  const points = await fetchTex8Chart(tf);
  return (await persistChart(tf, points)).points;
}

export function useXmrPrice(): PriceData {
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [data, setData] = useState<Omit<PriceData, 'refresh'>>({
    price: cachedPrice?.price ?? 0,
    change24h: cachedPrice?.change24h ?? 0,
    loading: !cachedPrice,
    error: false,
  });
  const refresh = useCallback(
    () => setRefreshVersion(version => version + 1),
    [],
  );

  useEffect(() => {
    let mounted = true;
    const load = async () => {
      const persisted = await loadPersistedPrice();
      if (mounted && persisted) {
        setData({
          price: persisted.price,
          change24h: persisted.change24h,
          loading: false,
          error: false,
        });
      }
      try {
        const quote = await fetchPrice(refreshVersion > 0);
        if (mounted) {
          setData({
            price: quote.price,
            change24h: quote.change24h,
            loading: false,
            error: false,
          });
        }
      } catch {
        if (mounted) {
          setData(current => ({
            ...current,
            loading: false,
            error: current.price <= 0,
          }));
        }
      }
    };
    load();
    const interval = setInterval(() => {
      load();
    }, 30_000);
    return () => {
      mounted = false;
      clearInterval(interval);
    };
  }, [refreshVersion]);

  return { ...data, refresh };
}

export function useXmrChart(tf: string): ChartData {
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [data, setData] = useState<Omit<ChartData, 'refresh'>>({
    points: chartCache[tf]?.points ?? [],
    loading: !chartCache[tf],
    error: false,
  });
  const refresh = useCallback(() => setRefreshVersion(version => version + 1), []);

  useEffect(() => {
    let mounted = true;
    const load = async () => {
      const persisted = await loadPersistedChart(tf);
      if (mounted) {
        setData({ points: persisted?.points ?? [], loading: !persisted, error: false });
      }
      try {
        const points = await fetchChart(tf, refreshVersion > 0);
        if (mounted) setData({ points, loading: false, error: false });
      } catch {
        if (mounted) setData(current => ({ ...current, loading: false, error: true }));
      }
    };
    load();
    return () => {
      mounted = false;
    };
  }, [tf, refreshVersion]);

  return { ...data, refresh };
}

export function xmrToUsd(xmr: number, price: number): string {
  return (xmr * price).toFixed(2);
}
