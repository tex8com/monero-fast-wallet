import { useState, useEffect } from "react";

const BASE = "https://api.coingecko.com/api/v3";

export interface PriceData {
  price: number;
  change24h: number;
  loading: boolean;
}

export interface ChartData {
  points: number[];
  loading: boolean;
}

let cachedPrice: { price: number; change24h: number; ts: number } | null = null;
const chartCache: Record<string, { points: number[]; ts: number }> = {};
const CACHE_TTL = 60_000; // 1 min

/* ── Current price ──────────────────────────────────────────────────── */
async function fetchPrice(): Promise<{ price: number; change24h: number }> {
  if (cachedPrice && Date.now() - cachedPrice.ts < CACHE_TTL) {
    return cachedPrice;
  }
  try {
    const resp = await fetch(`${BASE}/simple/price?ids=monero&vs_currencies=usd&include_24hr_change=true`);
    const data = await resp.json();
    const result = {
      price: data.monero.usd,
      change24h: data.monero.usd_24h_change ?? 0,
    };
    cachedPrice = { ...result, ts: Date.now() };
    return result;
  } catch {
    return cachedPrice ?? { price: 0, change24h: 0 };
  }
}

/* ── Chart data for timeframes ──────────────────────────────────────── */
const TF_DAYS: Record<string, string> = {
  "Today": "1",
  "24H": "1",
  "7D": "7",
  "1M": "30",
  "1Y": "365",
  "Max": "max",
};

async function fetchChart(tf: string): Promise<number[]> {
  const key = tf;
  if (chartCache[key] && Date.now() - chartCache[key].ts < CACHE_TTL * 5) {
    return chartCache[key].points;
  }
  const days = TF_DAYS[tf] ?? "1";
  try {
    const resp = await fetch(`${BASE}/coins/monero/market_chart?vs_currency=usd&days=${days}`);
    const data = await resp.json();
    const prices: number[] = (data.prices ?? []).map((p: number[]) => p[1]);
    // Downsample to ~40 points for smooth chart
    const step = Math.max(1, Math.floor(prices.length / 40));
    const sampled = prices.filter((_: number, i: number) => i % step === 0);
    if (sampled.length > 0) {
      chartCache[key] = { points: sampled, ts: Date.now() };
    }
    return sampled;
  } catch {
    return chartCache[key]?.points ?? [];
  }
}

/* ── Hooks ──────────────────────────────────────────────────────────── */

export function useXmrPrice(): PriceData {
  const [data, setData] = useState<PriceData>({ price: 0, change24h: 0, loading: true });

  useEffect(() => {
    let mounted = true;
    fetchPrice().then(r => {
      if (mounted) setData({ price: r.price, change24h: r.change24h, loading: false });
    });
    const iv = setInterval(() => {
      fetchPrice().then(r => {
        if (mounted) setData({ price: r.price, change24h: r.change24h, loading: false });
      });
    }, 30_000); // refresh every 30s
    return () => { mounted = false; clearInterval(iv); };
  }, []);

  return data;
}

export function useXmrChart(tf: string): ChartData {
  const [data, setData] = useState<ChartData>({ points: [], loading: true });

  useEffect(() => {
    let mounted = true;
    setData(d => ({ ...d, loading: true }));
    fetchChart(tf).then(points => {
      if (mounted) setData({ points, loading: false });
    });
    return () => { mounted = false; };
  }, [tf]);

  return data;
}

/* ── Utility ────────────────────────────────────────────────────────── */

export function xmrToUsd(xmr: number, price: number): string {
  return (xmr * price).toFixed(2);
}
