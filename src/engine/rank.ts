import type { Candle } from "./types";

export function rankStats(candles: Candle[]): { vol: number; momentum: number; score: number } {
  const closes = candles.map((candle) => candle.close).filter((close) => close > 0);
  if (closes.length < 8) return { vol: 0, momentum: 0, score: 0 };
  const window = closes.slice(-32);
  const returns: number[] = [];
  for (let i = 1; i < window.length; i++) returns.push(Math.log(window[i] / window[i - 1]));
  const mean = returns.reduce((sum, value) => sum + value, 0) / returns.length;
  const variance =
    returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / Math.max(1, returns.length - 1);
  const vol = Math.sqrt(Math.max(0, variance));
  const lookback = Math.min(16, closes.length - 1);
  const momentum = (closes[closes.length - 1] - closes[closes.length - 1 - lookback]) / closes[closes.length - 1 - lookback];
  const score = vol * (0.65 + 0.35 * Math.min(3, Math.abs(momentum) / (vol || 1e-9)));
  return { vol, momentum, score };
}
