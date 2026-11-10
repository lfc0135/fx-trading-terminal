import { describe, expect, it } from "vitest";
import { runBacktest, targetReport } from "./backtest";
import { generateCandles } from "./candles";
import { mustInstrument } from "./instruments";
import { entryFill } from "./pricing";
import { getStrategy, type Strategy } from "./strategies";
import { isFxMarketOpen } from "./time";
import type { Candle, RiskConfig } from "./types";

const baseConfig: RiskConfig = {
  perTradeRiskPct: 0.005,
  maxPositionNotionalPct: 1,
  dailyLossKillPct: 0.02,
  maxDrawdownKillPct: 0.1,
  leverageCap: 1,
  minStopPips: 5,
};

function bar(time: number, open: number, high: number, low: number, close: number): Candle {
  return { time, open, high, low, close };
}

describe("daily target accounting", () => {
  it("counts only sessions that actually cleared 2% and 3%", () => {
    const report = targetReport([
      { day: "2026-11-09", ret: 0.01 },
      { day: "2026-11-10", ret: 0.02 },
      { day: "2026-11-11", ret: 0.025 },
      { day: "2026-11-12", ret: 0.031 },
      { day: "2026-11-13", ret: -0.004 },
    ]);
    expect(report.days).toBe(5);
    expect(report.daysAtOrAboveLow).toBe(3);
    expect(report.daysAtOrAboveHigh).toBe(1);
    expect(report.lowHitRate).toBeCloseTo(0.6);
    expect(report.highHitRate).toBeCloseTo(0.2);
  });
});

describe("backtester", () => {
  it("pays the spread on entry and reports sharpe, drawdown, win rate, and the target hit rate", () => {
    const start = Date.UTC(2026, 10, 9, 10, 0, 0) / 1000;
    const candles: Candle[] = [];
    let price = 1.1;
    for (let i = 0; i < 8; i++) {
      const open = price;
      const close = i === 4 ? open + 0.004 : open + 0.0002;
      candles.push(
        bar(
          start + i * 900,
          open,
          Math.max(open, close) + 0.0003,
          Math.min(open, close) - 0.0001,
          close,
        ),
      );
      price = close;
    }
    const strategy: Strategy = {
      id: "script",
      name: "Script",
      description: "Enter once, wide stop, near target.",
      onBar({ candles: history, position }) {
        if (position) return { action: "hold" };
        if (history.length === 2) {
          const close = history[1].close;
          return {
            action: "enter",
            side: "long",
            stopLoss: close - 0.05,
            takeProfit: close + 0.003,
            reason: "script",
          };
        }
        return { action: "hold" };
      },
    };
    const result = runBacktest({
      symbol: "EURUSD",
      candles,
      strategy,
      config: { ...baseConfig, perTradeRiskPct: 0.01 },
      startingEquity: 50_000,
      timeframeMinutes: 15,
    });
    expect(result.trades).toBe(1);
    const trade = result.tradeLog[0];
    const fillBar = candles[2];
    expect(trade.entryPrice).toBeGreaterThan(fillBar.open);
    expect(trade.entryPrice).toBeCloseTo(entryFill(mustInstrument("EURUSD"), "long", fillBar.open), 6);
    expect(result.totalReturn).not.toBe(0);
    expect(result.maxDrawdown).toBeGreaterThanOrEqual(0);
    expect(result.maxDrawdown).toBeLessThan(1);
    expect(result.winRate === null || (result.winRate >= 0 && result.winRate <= 1)).toBe(true);
    expect(result.dailyTarget.days).toBeGreaterThan(0);
    expect(result.dailyTarget.lowHitRate).not.toBeNull();
    expect(result.endingEquity).toBeGreaterThan(0);
  });

  it("assumes the stop filled when a bar touches both stop and target", () => {
    const start = Date.UTC(2026, 10, 9, 10, 0, 0) / 1000;
    const candles: Candle[] = [
      bar(start, 1.1, 1.1002, 1.0998, 1.1),
      bar(start + 900, 1.1, 1.1002, 1.0998, 1.1001),
      bar(start + 1800, 1.1001, 1.1002, 1.0999, 1.1001),
      bar(start + 2700, 1.1001, 1.13, 1.05, 1.08),
    ];
    const strategy: Strategy = {
      id: "both",
      name: "Both",
      description: "Tight bracket.",
      onBar({ candles: history, position }) {
        if (position || history.length !== 2) return { action: "hold" };
        return {
          action: "enter",
          side: "long",
          stopLoss: 1.09,
          takeProfit: 1.11,
          reason: "both",
        };
      },
    };
    const result = runBacktest({
      symbol: "EURUSD",
      candles,
      strategy,
      config: baseConfig,
    });
    expect(result.tradeLog[0].reason).toBe("stop");
    expect(result.tradeLog[0].pnlUsd).toBeLessThan(0);
    expect(result.winRate).toBe(0);
  });

  it("does not open trades on weekend candles", () => {
    const saturday = Date.UTC(2026, 10, 7, 12, 0, 0) / 1000;
    const candles = [0, 1, 2].map((i) => bar(saturday + i * 3600, 1.1, 1.12, 1.08, 1.11));
    expect(candles.every((candle) => !isFxMarketOpen(new Date(candle.time * 1000)))).toBe(true);
    const strategy: Strategy = {
      id: "always",
      name: "Always",
      description: "Would trade if the market were open.",
      onBar({ position }) {
        if (position) return { action: "hold" };
        return { action: "enter", side: "long", stopLoss: 1.0, takeProfit: 1.2, reason: "always" };
      },
    };
    const result = runBacktest({ symbol: "EURUSD", candles, strategy, config: baseConfig });
    expect(result.trades).toBe(0);
    expect(result.dailyTarget.lowHitRate === 0 || result.dailyTarget.days === 0).toBe(true);
    expect(result.skips.some((skip) => /closed/i.test(skip.reason))).toBe(true);
  });

  it("reports a zero hit rate when the book never reaches the band", () => {
    const start = Date.UTC(2026, 10, 9, 8, 0, 0) / 1000;
    const candles: Candle[] = [];
    for (let i = 0; i < 6; i++) {
      candles.push(bar(start + i * 900, 1.1, 1.1004, 1.0996, 1.1));
    }
    const strategy: Strategy = {
      id: "flat",
      name: "Flat",
      description: "Never trades.",
      onBar() {
        return { action: "hold" };
      },
    };
    const result = runBacktest({ symbol: "EURUSD", candles, strategy, config: baseConfig });
    expect(result.trades).toBe(0);
    expect(result.totalReturn).toBe(0);
    expect(result.dailyTarget.daysAtOrAboveLow).toBe(0);
    expect(result.dailyTarget.lowHitRate).toBe(0);
    expect(result.sharpe).toBeNull();
  });

  it("keeps recorded candles inside FX market hours", () => {
    const candles = generateCandles({
      symbol: "EURUSD",
      timeframeMinutes: 60,
      bars: 120,
      endTime: Date.UTC(2026, 10, 6, 20, 0, 0) / 1000,
      seed: 7,
    });
    expect(candles).toHaveLength(120);
    expect(candles.every((candle) => isFxMarketOpen(new Date(candle.time * 1000)))).toBe(true);
    for (let i = 1; i < candles.length; i++) expect(candles[i].time).toBeGreaterThan(candles[i - 1].time);
  });
});

describe("example strategies", () => {
  it("buys the first London close through the Asia high and will not take a second break", () => {
    const strategy = getStrategy("session-breakout");
    expect(strategy).not.toBeNull();
    const day = Date.UTC(2026, 10, 9, 0, 0, 0) / 1000;
    const candles: Candle[] = [];
    for (let i = 0; i < 28; i++) {
      const time = day + i * 900;
      const high = 1.101;
      const low = 1.099;
      candles.push(bar(time, 1.1, high, low, 1.1));
    }
    const breakBar = bar(day + 28 * 900, 1.1008, 1.1022, 1.1006, 1.1016);
    const first = strategy!.onBar({
      candles: [...candles, breakBar],
      instrument: mustInstrument("EURUSD"),
      position: null,
    });
    expect(first.action).toBe("enter");
    if (first.action === "enter") {
      expect(first.side).toBe("long");
      expect(first.stopLoss).toBeCloseTo(1.099, 5);
    }
    const second = strategy!.onBar({
      candles: [...candles, breakBar, bar(day + 29 * 900, 1.1016, 1.103, 1.101, 1.1025)],
      instrument: mustInstrument("EURUSD"),
      position: null,
    });
    expect(second.action).toBe("hold");
  });

  it("emits a momentum entry once the fast EMA crosses the slow EMA", () => {
    const strategy = getStrategy("momentum");
    expect(strategy).not.toBeNull();
    const start = Date.UTC(2026, 10, 9, 8, 0, 0) / 1000;
    const candles: Candle[] = [];
    let price = 1.1;
    for (let i = 0; i < 50; i++) {
      const drift = i < 28 ? -0.00015 : 0.0012;
      const open = price;
      price = Math.max(0.5, price + drift);
      candles.push(
        bar(start + i * 900, open, Math.max(open, price) + 0.00005, Math.min(open, price) - 0.00005, price),
      );
    }
    const signals = candles.map((_, index) =>
      strategy!.onBar({
        candles: candles.slice(0, index + 1),
        instrument: mustInstrument("EURUSD"),
        position: null,
      }),
    );
    expect(signals.some((signal) => signal.action === "enter" && signal.side === "long")).toBe(true);
  });
});
