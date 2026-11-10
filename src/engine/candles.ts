import { mustInstrument } from "./instruments";
import { isFxMarketOpen } from "./time";
import type { Candle } from "./types";

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gaussian(rand: () => number): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = rand();
  while (v === 0) v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export function hashSeed(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function generateCandles(opts: {
  symbol: string;
  timeframeMinutes: number;
  bars: number;
  endTime: number;
  seed?: number;
}): Candle[] {
  const inst = mustInstrument(opts.symbol);
  const step = Math.max(1, opts.timeframeMinutes) * 60;
  const end = Math.floor(opts.endTime / step) * step;
  const times: number[] = [];
  let cursor = end;
  const floor = end - 86400 * 500;
  while (times.length < opts.bars && cursor > floor) {
    if (isFxMarketOpen(new Date(cursor * 1000))) times.push(cursor);
    cursor -= step;
  }
  times.reverse();

  const rand = mulberry32((opts.seed ?? hashSeed(opts.symbol)) ^ (opts.timeframeMinutes * 997));
  const barsPerYear = ((365 * 24 * 60) / opts.timeframeMinutes) * (5 / 7);
  const sigma = inst.annualVol / Math.sqrt(barsPerYear);
  const candles: Candle[] = [];
  let price = inst.anchor;
  for (const time of times) {
    const day = time / 86400;
    const seasonal = 0.25 * sigma * Math.sin((day / 2.7) * Math.PI * 2);
    const open = price;
    const ret = seasonal + sigma * gaussian(rand);
    const close = open * Math.exp(ret);
    const span = Math.abs(close - open);
    const wick = Math.abs(sigma * open) * (0.25 + rand());
    let high = Math.max(open, close) + Math.max(span * 0.15, wick);
    let low = Math.min(open, close) - Math.max(span * 0.15, wick * 0.8);
    if (low <= 0) low = Math.min(open, close) * 0.999;
    if (high < low) high = low;
    const decimals = inst.decimals;
    const round = (n: number) => {
      const f = 10 ** decimals;
      return Math.round(n * f) / f;
    };
    const bar: Candle = {
      time,
      open: round(open),
      high: round(high),
      low: round(low),
      close: round(close),
    };
    if (bar.high < Math.max(bar.open, bar.close)) bar.high = Math.max(bar.open, bar.close);
    if (bar.low > Math.min(bar.open, bar.close)) bar.low = Math.min(bar.open, bar.close);
    candles.push(bar);
    price = bar.close;
  }
  return candles;
}
