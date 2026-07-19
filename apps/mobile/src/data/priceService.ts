import AsyncStorage from '@react-native-async-storage/async-storage';
import { useCallback, useEffect, useState } from 'react';

const COINGECKO_BASE = 'https://api.coingecko.com/api/v3';
const BITFINEX_BASE = 'https://api-pub.bitfinex.com/v2';
const CACHE_TTL = 60_000;
const PERSISTED_CHART_TTL = 24 * 60 * 60 * 1_000;
const REQUEST_TIMEOUT_MS = 12_000;
const CHART_CACHE_PREFIX = '@tex8/monero/market-chart/';

export interface PriceData {
  price: number;
  change24h: number;
  loading: boolean;
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

let cachedPrice: { price: number; change24h: number; ts: number } | null = null;
const chartCache: Record<string, ChartCache | undefined> = {};

const TF_DAYS: Record<string, string> = {
  '24H': '1',
  '7D': '7',
  '1M': '30',
  '1Y': '365',
  Max: 'max',
};

const BITFINEX_CANDLES: Record<string, { interval: string; limit: number }> = {
  '24H': { interval: '1h', limit: 25 },
  '7D': { interval: '6h', limit: 29 },
  '1M': { interval: '12h', limit: 61 },
  '1Y': { interval: '1D', limit: 366 },
  Max: { interval: '1D', limit: 10_000 },
};

async function fetchJson(url: string): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: controller.signal,
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

function coinGeckoPoints(value: unknown): ChartPoint[] {
  if (!value || typeof value !== 'object' || !Array.isArray((value as { prices?: unknown }).prices)) {
    return [];
  }
  return (value as { prices: unknown[] }).prices.flatMap(entry => {
    if (!Array.isArray(entry)) return [];
    const point = validPoint(entry[0], entry[1]);
    return point ? [point] : [];
  });
}

function bitfinexPoints(value: unknown): ChartPoint[] {
  if (!Array.isArray(value)) return [];
  return value
    .flatMap(entry => {
      if (!Array.isArray(entry)) return [];
      const point = validPoint(entry[0], entry[2]);
      return point ? [point] : [];
    })
    .reverse();
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

async function fetchPriceFromCoinGecko(): Promise<{ price: number; change24h: number }> {
  const data = await fetchJson(
    `${COINGECKO_BASE}/simple/price?ids=monero&vs_currencies=usd&include_24hr_change=true`,
  );
  const monero = data && typeof data === 'object'
    ? (data as { monero?: { usd?: unknown; usd_24h_change?: unknown } }).monero
    : undefined;
  if (typeof monero?.usd !== 'number' || !Number.isFinite(monero.usd)) {
    throw new Error('Primary market source did not return an XMR/USD price.');
  }
  return {
    price: monero.usd,
    change24h:
      typeof monero.usd_24h_change === 'number' && Number.isFinite(monero.usd_24h_change)
        ? monero.usd_24h_change
        : 0,
  };
}

async function fetchPriceFromBitfinex(): Promise<{ price: number; change24h: number }> {
  const data = await fetchJson(`${BITFINEX_BASE}/ticker/tXMRUSD`);
  if (!Array.isArray(data) || typeof data[6] !== 'number' || !Number.isFinite(data[6])) {
    throw new Error('Backup market source did not return an XMR/USD price.');
  }
  return {
    price: data[6],
    change24h: typeof data[5] === 'number' && Number.isFinite(data[5]) ? data[5] * 100 : 0,
  };
}

async function fetchPrice(): Promise<{ price: number; change24h: number }> {
  if (cachedPrice && Date.now() - cachedPrice.ts < CACHE_TTL) return cachedPrice;
  const result = await fetchPriceFromCoinGecko().catch(() => fetchPriceFromBitfinex());
  cachedPrice = { ...result, ts: Date.now() };
  return cachedPrice;
}

async function fetchCoinGeckoChart(tf: string): Promise<ChartPoint[]> {
  const data = await fetchJson(
    `${COINGECKO_BASE}/coins/monero/market_chart?vs_currency=usd&days=${TF_DAYS[tf] ?? '1'}`,
  );
  const points = downsampleChartPoints(coinGeckoPoints(data));
  if (points.length < 2) throw new Error('Primary market chart did not contain enough price points.');
  return points;
}

async function fetchBitfinexChart(tf: string): Promise<ChartPoint[]> {
  const candle = BITFINEX_CANDLES[tf] ?? BITFINEX_CANDLES['24H'];
  const data = await fetchJson(
    `${BITFINEX_BASE}/candles/trade:${candle.interval}:tXMRUSD/hist?limit=${candle.limit}&sort=-1`,
  );
  const points = downsampleChartPoints(bitfinexPoints(data));
  if (points.length < 2) throw new Error('Backup market chart did not contain enough price points.');
  return points;
}

async function fetchChart(tf: string, force = false): Promise<ChartPoint[]> {
  const existing = chartCache[tf];
  if (!force && existing && Date.now() - existing.ts < CACHE_TTL * 5) return existing.points;
  const points = await fetchCoinGeckoChart(tf).catch(() => fetchBitfinexChart(tf));
  return (await persistChart(tf, points)).points;
}

export function useXmrPrice(): PriceData {
  const [data, setData] = useState<PriceData>({
    price: cachedPrice?.price ?? 0,
    change24h: cachedPrice?.change24h ?? 0,
    loading: !cachedPrice,
  });

  useEffect(() => {
    let mounted = true;
    const load = async () => {
      try {
        const quote = await fetchPrice();
        if (mounted) setData({ price: quote.price, change24h: quote.change24h, loading: false });
      } catch {
        if (mounted) setData(current => ({ ...current, loading: false }));
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
  }, []);

  return data;
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
