import type { Candle, Instrument, Side } from "./types";

export type StrategyPosition = { side: Side } | null;

export type StrategyContext = {
  candles: Candle[];
  instrument: Instrument;
  position: StrategyPosition;
};

export type StrategySignal =
  | { action: "hold" }
  | {
      action: "enter";
      side: Side;
      stopLoss: number;
      takeProfit: number | null;
      reason: string;
    }
  | { action: "exit"; reason: string };

export type Strategy = {
  id: string;
  name: string;
  description: string;
  onBar: (ctx: StrategyContext) => StrategySignal;
};

function utcParts(time: number): { day: string; hour: number } {
  const d = new Date(time * 1000);
  const day = d.toISOString().slice(0, 10);
  return { day, hour: d.getUTCHours() };
}

function ema(values: number[], period: number): number | null {
  if (values.length < period) return null;
  const k = 2 / (period + 1);
  let value = 0;
  for (let i = 0; i < period; i++) value += values[i];
  value /= period;
  for (let i = period; i < values.length; i++) {
    value = values[i] * k + value * (1 - k);
  }
  return value;
}

function atr(candles: Candle[], period: number): number | null {
  if (candles.length < period + 1) return null;
  const trs: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const current = candles[i];
    const prev = candles[i - 1].close;
    trs.push(
      Math.max(
        current.high - current.low,
        Math.abs(current.high - prev),
        Math.abs(current.low - prev),
      ),
    );
  }
  if (trs.length < period) return null;
  let value = 0;
  for (let i = 0; i < period; i++) value += trs[i];
  value /= period;
  for (let i = period; i < trs.length; i++) {
    value = (value * (period - 1) + trs[i]) / period;
  }
  return value;
}

export const sessionBreakout: Strategy = {
  id: "session-breakout",
  name: "London session breakout",
  description:
    "Uses the 00:00–07:00 UTC range as the Asia box, then takes the first 15-minute close through that box after London opens. Stop sits on the far side of the range, target is 1.5R, and the position is flattened after 16:00 UTC. One break per UTC day.",
  onBar(ctx) {
    const last = ctx.candles[ctx.candles.length - 1];
    if (!last) return { action: "hold" };
    const { day, hour } = utcParts(last.time);
    if (ctx.position && hour >= 16) {
      return { action: "exit", reason: "London session flat" };
    }
    if (ctx.position) return { action: "hold" };
    if (hour < 7 || hour >= 16) return { action: "hold" };

    const asia = ctx.candles.filter((candle) => {
      const parts = utcParts(candle.time);
      return parts.day === day && parts.hour < 7;
    });
    if (asia.length < 4) return { action: "hold" };
    const high = Math.max(...asia.map((candle) => candle.high));
    const low = Math.min(...asia.map((candle) => candle.low));
    const rangePips = (high - low) / ctx.instrument.pip;
    if (rangePips < 8 || rangePips > 90) return { action: "hold" };

    const earlier = ctx.candles.filter((candle) => {
      const parts = utcParts(candle.time);
      return parts.day === day && parts.hour >= 7 && candle.time < last.time;
    });
    if (earlier.some((candle) => candle.close > high || candle.close < low)) {
      return { action: "hold" };
    }

    if (last.close > high) {
      const risk = last.close - low;
      return {
        action: "enter",
        side: "long",
        stopLoss: low,
        takeProfit: last.close + 1.5 * risk,
        reason: "Asia high break",
      };
    }
    if (last.close < low) {
      const risk = high - last.close;
      return {
        action: "enter",
        side: "short",
        stopLoss: high,
        takeProfit: last.close - 1.5 * risk,
        reason: "Asia low break",
      };
    }
    return { action: "hold" };
  },
};

export const momentum: Strategy = {
  id: "momentum",
  name: "EMA momentum",
  description:
    "Short-term trend following. Enters when the 8-period EMA crosses the 21-period EMA and exits on the opposite cross. Stop is 1.5 ATR, target is 2.5 ATR. New risk is skipped after 20:00 UTC on Friday, ahead of the weekend close.",
  onBar(ctx) {
    const candles = ctx.candles;
    const last = candles[candles.length - 1];
    if (!last || candles.length < 30) return { action: "hold" };
    const closes = candles.map((candle) => candle.close);
    const fast = ema(closes, 8);
    const slow = ema(closes, 21);
    const prevFast = ema(closes.slice(0, -1), 8);
    const prevSlow = ema(closes.slice(0, -1), 21);
    const range = atr(candles, 14);
    if (
      fast == null ||
      slow == null ||
      prevFast == null ||
      prevSlow == null ||
      range == null ||
      range <= 0
    ) {
      return { action: "hold" };
    }
    const crossUp = prevFast <= prevSlow && fast > slow;
    const crossDown = prevFast >= prevSlow && fast < slow;
    if (ctx.position?.side === "long" && crossDown) {
      return { action: "exit", reason: "EMA cross down" };
    }
    if (ctx.position?.side === "short" && crossUp) {
      return { action: "exit", reason: "EMA cross up" };
    }
    if (ctx.position) return { action: "hold" };

    const date = new Date(last.time * 1000);
    if (date.getUTCDay() === 5 && date.getUTCHours() >= 20) return { action: "hold" };

    if (crossUp) {
      return {
        action: "enter",
        side: "long",
        stopLoss: last.close - 1.5 * range,
        takeProfit: last.close + 2.5 * range,
        reason: "EMA 8 crossed above 21",
      };
    }
    if (crossDown) {
      return {
        action: "enter",
        side: "short",
        stopLoss: last.close + 1.5 * range,
        takeProfit: last.close - 2.5 * range,
        reason: "EMA 8 crossed below 21",
      };
    }
    return { action: "hold" };
  },
};

export const STRATEGIES: Strategy[] = [sessionBreakout, momentum];

export function getStrategy(id: string): Strategy | null {
  return STRATEGIES.find((strategy) => strategy.id === id) ?? null;
}
