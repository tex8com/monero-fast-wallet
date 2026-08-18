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

const PRICE_TTL_MS = 60_000;
const CHART_TTL_MS = PRICE_TTL_MS * 5;
const PERSISTED_CHART_TTL_MS = 24 * 60 * 60 * 1_000;

type PriceCache = { change24h: number; price: number; updatedAt: number };
type ChartCache = { points: MarketPoint[]; updatedAt: number };

let priceCache: PriceCache | null = null;
const chartCache = new Map<MarketTimeframe, ChartCache>();

function isFresh(updatedAt: number, ttl: number) {
  return Date.now() - updatedAt < ttl;
}

function validPoint(timestamp: unknown, price: unknown): MarketPoint | null {
  if (typeof timestamp !== 'number' || !Number.isFinite(timestamp) || typeof price !== 'number' || !Number.isFinite(price) || price <= 0) return null;
  return { timestamp, price };
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

async function fetchPriceFromTex8() {
  const value = JSON.parse(await invoke<string>('fetch_private_service', { input: { kind: 'quote' } })) as { price?: unknown; change24h?: unknown };
  if (typeof value.price !== 'number' || !Number.isFinite(value.price) || typeof value.change24h !== 'number' || !Number.isFinite(value.change24h)) throw new Error('Market data did not include an XMR/USD price.');
  return { price: value.price, change24h: value.change24h };
}

async function fetchPrice() {
  if (priceCache && isFresh(priceCache.updatedAt, PRICE_TTL_MS)) return priceCache;
  const quote = await fetchPriceFromTex8();
  priceCache = { ...quote, updatedAt: Date.now() };
  return priceCache;
}

async function fetchChartFromTex8(timeframe: MarketTimeframe) {
  const value = JSON.parse(await invoke<string>('fetch_private_service', { input: { kind: 'chart', timeframe } })) as { points?: unknown };
  const points = downsample(Array.isArray(value.points) ? value.points.flatMap((entry) => entry && typeof entry === 'object' ? [validPoint((entry as MarketPoint).timestamp, (entry as MarketPoint).price)].filter((point): point is MarketPoint => point !== null) : []) : []);
  if (points.length < 2) throw new Error('Primary market chart did not include enough price points.');
  return points;
}

async function fetchChart(timeframe: MarketTimeframe, force = false) {
  const cached = cachedChart(timeframe);
  if (!force && cached && isFresh(cached.updatedAt, CHART_TTL_MS)) return cached.points;
  const points = await fetchChartFromTex8(timeframe);
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
