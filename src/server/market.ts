import { generateCandles, hashSeed } from "@/engine/candles";
import { instrument } from "@/engine/instruments";
import type { Candle } from "@/engine/types";

export type Series = {
  symbol: string;
  candles: Candle[];
  source: "yahoo" | "recorded";
  proxy: boolean;
};

type CacheEntry = { at: number; series: Series };

const cache = new Map<string, CacheEntry>();
const TTL_MS = 45_000;

function yahooInterval(timeframeMinutes: number): { interval: string; range: string } {
  if (timeframeMinutes <= 1) return { interval: "1m", range: "1d" };
  if (timeframeMinutes <= 5) return { interval: "5m", range: "5d" };
  if (timeframeMinutes <= 15) return { interval: "15m", range: "60d" };
  if (timeframeMinutes <= 30) return { interval: "30m", range: "60d" };
  if (timeframeMinutes <= 60) return { interval: "60m", range: "3mo" };
  return { interval: "1d", range: "1y" };
}

function recorded(symbol: string, timeframeMinutes: number, bars: number): Series {
  const inst = instrument(symbol);
  return {
    symbol,
    source: "recorded",
    proxy: inst?.yahooProxy ?? false,
    candles: generateCandles({
      symbol,
      timeframeMinutes,
      bars,
      endTime: Math.floor(Date.now() / 1000),
      seed: hashSeed(`${symbol}:${timeframeMinutes}`),
    }),
  };
}

function parseYahoo(symbol: string, body: unknown, bars: number): Candle[] {
  const root = body as {
    chart?: {
      result?: Array<{
        timestamp?: number[];
        indicators?: { quote?: Array<Record<string, Array<number | null>>> };
      }>;
    };
  };
  const result = root.chart?.result?.[0];
  const times = result?.timestamp ?? [];
  const quote = result?.indicators?.quote?.[0];
  if (!quote) return [];
  const candles: Candle[] = [];
  for (let i = 0; i < times.length; i++) {
    const open = quote.open?.[i];
    const high = quote.high?.[i];
    const low = quote.low?.[i];
    const close = quote.close?.[i];
    if (
      open == null ||
      high == null ||
      low == null ||
      close == null ||
      !Number.isFinite(open) ||
      !Number.isFinite(close)
    ) {
      continue;
    }
    candles.push({
      time: times[i],
      open,
      high: Math.max(high, open, close),
      low: Math.min(low, open, close),
      close,
    });
  }
  const unique = new Map<number, Candle>();
  for (const candle of candles) unique.set(candle.time, candle);
  return [...unique.values()].sort((a, b) => a.time - b.time).slice(-bars);
}

async function fetchYahoo(symbol: string, timeframeMinutes: number, bars: number): Promise<Candle[] | null> {
  const inst = instrument(symbol);
  if (!inst) return null;
  const { interval, range } = yahooInterval(timeframeMinutes);
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(inst.yahooSymbol)}?interval=${interval}&range=${range}&includePrePost=true`;
  try {
    const response = await fetch(url, {
      headers: { "user-agent": "MinaFX/0.1 (paper desk)", accept: "application/json" },
      signal: AbortSignal.timeout(5000),
      cache: "no-store",
    });
    if (!response.ok) return null;
    const candles = parseYahoo(symbol, await response.json(), Math.max(bars, 30));
    if (candles.length < 8) return null;
    return candles.slice(-bars);
  } catch {
    return null;
  }
}

export async function getSeries(symbol: string, timeframeMinutes: number, bars: number): Promise<Series> {
  const inst = instrument(symbol);
  if (!inst) return { symbol, candles: [], source: "recorded", proxy: false };
  const key = `${symbol}:${timeframeMinutes}:${bars}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.series;
  const live = await fetchYahoo(symbol, timeframeMinutes, bars);
  const series: Series = live
    ? { symbol, candles: live, source: "yahoo", proxy: inst.yahooProxy }
    : recorded(symbol, timeframeMinutes, bars);
  cache.set(key, { at: Date.now(), series });
  return series;
}

export function clearMarketCache(): void {
  cache.clear();
}
