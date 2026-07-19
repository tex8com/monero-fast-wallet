import { invoke } from '@tauri-apps/api/core';
import { useCallback, useEffect, useState } from 'react';

export type MarketTimeframe = '24H' | '7D' | '1M' | '1Y' | 'Max';

export type MarketPoint = {
  price: number;
  timestamp: number;
};

export type XmrPriceData = {
  change24h: number;
  loading: boolean;
  price: number;
};

export type XmrChartData = {
  error: boolean;
  loading: boolean;
  points: MarketPoint[];
  refresh: () => void;
};

const COINGECKO_BASE = 'https://api.coingecko.com/api/v3';
const PRICE_TTL_MS = 60_000;
const CHART_TTL_MS = PRICE_TTL_MS * 5;
const PERSISTED_CHART_TTL_MS = 24 * 60 * 60 * 1_000;
const REQUEST_TIMEOUT_MS = 12_000;
const DAYS_BY_TIMEFRAME: Record<MarketTimeframe, string> = {
  '24H': '1',
  '7D': '7',
  '1M': '30',
  '1Y': '365',
  Max: 'max',
};

type PriceCache = { change24h: number; price: number; updatedAt: number };
type ChartCache = { points: MarketPoint[]; updatedAt: number };

let priceCache: PriceCache | null = null;
const chartCache = new Map<MarketTimeframe, ChartCache>();

function isFresh(updatedAt: number, ttl: number) {
  return Date.now() - updatedAt < ttl;
}

async function fetchJson(url: string): Promise<unknown> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, { headers: { Accept: 'application/json' }, signal: controller.signal });
    if (!response.ok) throw new Error(`Market data request failed (${response.status}).`);
    return response.json();
  } finally {
    window.clearTimeout(timer);
  }
}

function validPoint(timestamp: unknown, price: unknown): MarketPoint | null {
  if (typeof timestamp !== 'number' || !Number.isFinite(timestamp) || typeof price !== 'number' || !Number.isFinite(price) || price <= 0) return null;
  return { timestamp, price };
}

function pointsFromCoinGecko(value: unknown): MarketPoint[] {
  if (!value || typeof value !== 'object' || !Array.isArray((value as { prices?: unknown }).prices)) return [];
  return (value as { prices: unknown[] }).prices.flatMap((entry) => Array.isArray(entry) ? [validPoint(entry[0], entry[1])].filter((point): point is MarketPoint => point !== null) : []);
}

function pointsFromBitfinex(value: unknown): MarketPoint[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => Array.isArray(entry) ? [validPoint(entry[0], entry[2])].filter((point): point is MarketPoint => point !== null) : []).reverse();
}

function downsample(points: MarketPoint[], maximum = 120) {
  if (points.length <= maximum) return points;
  return Array.from({ length: maximum }, (_, index) => points[Math.round((index * (points.length - 1)) / (maximum - 1))]);
}

function chartStorageKey(timeframe: MarketTimeframe) {
  return `tex8-monero-market-chart-${timeframe}`;
}

function loadPersistedChart(timeframe: MarketTimeframe): ChartCache | null {
  try {
    const raw = window.localStorage.getItem(chartStorageKey(timeframe));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { points?: unknown; updatedAt?: unknown };
    if (typeof parsed.updatedAt !== 'number' || !isFresh(parsed.updatedAt, PERSISTED_CHART_TTL_MS) || !Array.isArray(parsed.points)) return null;
    const points = parsed.points.flatMap((point) => point && typeof point === 'object' ? [validPoint((point as MarketPoint).timestamp, (point as MarketPoint).price)].filter((value): value is MarketPoint => value !== null) : []);
    return points.length >= 2 ? { points, updatedAt: parsed.updatedAt } : null;
  } catch {
    return null;
  }
}

function rememberChart(timeframe: MarketTimeframe, points: MarketPoint[]) {
  const cached = { points, updatedAt: Date.now() };
  chartCache.set(timeframe, cached);
  try { window.localStorage.setItem(chartStorageKey(timeframe), JSON.stringify(cached)); } catch { /* Storage is optional. */ }
  return cached;
}

function cachedChart(timeframe: MarketTimeframe) {
  const cached = chartCache.get(timeframe) ?? loadPersistedChart(timeframe);
  if (cached && !chartCache.has(timeframe)) chartCache.set(timeframe, cached);
  return cached ?? null;
}

async function fetchPriceFromCoinGecko() {
  const value = await fetchJson(`${COINGECKO_BASE}/simple/price?ids=monero&vs_currencies=usd&include_24hr_change=true`);
  const monero = value && typeof value === 'object' ? (value as { monero?: { usd?: unknown; usd_24h_change?: unknown } }).monero : undefined;
  if (typeof monero?.usd !== 'number' || !Number.isFinite(monero.usd)) throw new Error('Market data did not include an XMR/USD price.');
  return { price: monero.usd, change24h: typeof monero.usd_24h_change === 'number' && Number.isFinite(monero.usd_24h_change) ? monero.usd_24h_change : 0 };
}

async function fetchPriceFromBitfinex() {
  const value = JSON.parse(await invoke<string>('fetch_market_backup', { input: { kind: 'ticker' } })) as unknown;
  if (!Array.isArray(value) || typeof value[6] !== 'number' || !Number.isFinite(value[6])) throw new Error('Backup market data did not include an XMR/USD price.');
  return { price: value[6], change24h: typeof value[5] === 'number' && Number.isFinite(value[5]) ? value[5] * 100 : 0 };
}

async function fetchPrice() {
  if (priceCache && isFresh(priceCache.updatedAt, PRICE_TTL_MS)) return priceCache;
  const quote = await fetchPriceFromCoinGecko().catch(() => fetchPriceFromBitfinex());
  priceCache = { ...quote, updatedAt: Date.now() };
  return priceCache;
}

async function fetchChartFromCoinGecko(timeframe: MarketTimeframe) {
  const points = downsample(pointsFromCoinGecko(await fetchJson(`${COINGECKO_BASE}/coins/monero/market_chart?vs_currency=usd&days=${DAYS_BY_TIMEFRAME[timeframe]}`)));
  if (points.length < 2) throw new Error('Primary market chart did not include enough price points.');
  return points;
}

async function fetchChartFromBitfinex(timeframe: MarketTimeframe) {
  const points = downsample(pointsFromBitfinex(JSON.parse(await invoke<string>('fetch_market_backup', { input: { kind: 'chart', timeframe } })) as unknown));
  if (points.length < 2) throw new Error('Backup market chart did not include enough price points.');
  return points;
}

async function fetchChart(timeframe: MarketTimeframe, force = false) {
  const cached = cachedChart(timeframe);
  if (!force && cached && isFresh(cached.updatedAt, CHART_TTL_MS)) return cached.points;
  const points = await fetchChartFromCoinGecko(timeframe).catch(() => fetchChartFromBitfinex(timeframe));
  return rememberChart(timeframe, points).points;
}

export function useXmrPrice(): XmrPriceData {
  const [data, setData] = useState<XmrPriceData>(() => ({ price: priceCache?.price ?? 0, change24h: priceCache?.change24h ?? 0, loading: !priceCache }));

  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const next = await fetchPrice();
        if (active) setData({ price: next.price, change24h: next.change24h, loading: false });
      } catch {
        if (active) setData((current) => ({ ...current, loading: false }));
      }
    };
    void load();
    const timer = window.setInterval(() => void load(), 30_000);
    return () => { active = false; window.clearInterval(timer); };
  }, []);

  return data;
}

export function useXmrChart(timeframe: MarketTimeframe): XmrChartData {
  const [refreshVersion, setRefreshVersion] = useState(0);
  const initial = cachedChart(timeframe);
  const [data, setData] = useState(() => ({ points: initial?.points ?? [], loading: !initial, error: false }));
  const refresh = useCallback(() => setRefreshVersion((version) => version + 1), []);

  useEffect(() => {
    let active = true;
    const cached = cachedChart(timeframe);
    setData({ points: cached?.points ?? [], loading: !cached, error: false });
    void fetchChart(timeframe, refreshVersion > 0)
      .then((points) => { if (active) setData({ points, loading: false, error: false }); })
      .catch(() => {
        if (active) setData((current) => ({ ...current, loading: false, error: true }));
      });
    return () => { active = false; };
  }, [timeframe, refreshVersion]);

  return { ...data, refresh };
}
