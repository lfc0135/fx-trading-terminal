import { generateCandles } from "./candles";
import { mustInstrument } from "./instruments";
import {
  applyBar,
  closePosition,
  createBook,
  equityOf,
  midsFromBook,
  placeOrder,
  type OrderResult,
} from "./paper";
import { entryFill } from "./pricing";
import type { Strategy } from "./strategies";
import { zonedParts } from "./time";
import {
  DAILY_TARGET_HIGH,
  DAILY_TARGET_LOW,
  DEFAULT_SETTINGS,
  type Candle,
  type PaperBook,
  type RiskConfig,
  type Trade,
} from "./types";

export type DailyTargetReport = {
  low: number;
  high: number;
  days: number;
  daysAtOrAboveLow: number;
  daysAtOrAboveHigh: number;
  lowHitRate: number | null;
  highHitRate: number | null;
  returns: { day: string; ret: number; hitLow: boolean; hitHigh: boolean }[];
};

export type BacktestResult = {
  symbol: string;
  strategyId: string;
  strategyName: string;
  timeframeMinutes: number;
  startingEquity: number;
  endingEquity: number;
  totalReturn: number;
  maxDrawdown: number;
  sharpe: number | null;
  trades: number;
  wins: number;
  losses: number;
  winRate: number | null;
  averagePnl: number | null;
  profitFactor: number | null;
  dailyTarget: DailyTargetReport;
  skips: { reason: string; count: number }[];
  equityCurve: { time: number; equity: number }[];
  tradeLog: Trade[];
  note: string;
  source: "recorded" | "yahoo" | "supplied";
};

export function targetReport(returns: { day: string; ret: number }[], low = DAILY_TARGET_LOW, high = DAILY_TARGET_HIGH): DailyTargetReport {
  const rows = returns.map((row) => ({
    ...row,
    hitLow: row.ret >= low - 1e-12,
    hitHigh: row.ret >= high - 1e-12,
  }));
  const days = rows.length;
  const daysAtOrAboveLow = rows.filter((row) => row.hitLow).length;
  const daysAtOrAboveHigh = rows.filter((row) => row.hitHigh).length;
  return {
    low,
    high,
    days,
    daysAtOrAboveLow,
    daysAtOrAboveHigh,
    lowHitRate: days > 0 ? daysAtOrAboveLow / days : null,
    highHitRate: days > 0 ? daysAtOrAboveHigh / days : null,
    returns: rows,
  };
}

function sampleStdev(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance =
    values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

function dailyReturns(curve: { time: number; equity: number }[], startingEquity: number): { day: string; ret: number }[] {
  const lastByDay = new Map<string, number>();
  for (const point of curve) {
    const day = zonedParts(new Date(point.time * 1000)).dayKey;
    lastByDay.set(day, point.equity);
  }
  const rows: { day: string; ret: number }[] = [];
  let baseline = startingEquity;
  for (const [day, equity] of lastByDay) {
    const ret = baseline > 0 ? (equity - baseline) / baseline : 0;
    rows.push({ day, ret });
    baseline = equity;
  }
  return rows;
}

function maxDrawdown(curve: { equity: number }[], startingEquity: number): number {
  let peak = startingEquity;
  let worst = 0;
  for (const point of curve) {
    peak = Math.max(peak, point.equity);
    if (peak > 0) worst = Math.max(worst, (peak - point.equity) / peak);
  }
  return worst;
}

function downsample<T>(rows: T[], maxPoints: number): T[] {
  if (rows.length <= maxPoints) return rows;
  const out: T[] = [];
  const step = (rows.length - 1) / (maxPoints - 1);
  for (let i = 0; i < maxPoints; i++) out.push(rows[Math.round(i * step)]);
  return out;
}

export function runBacktest(opts: {
  symbol: string;
  candles: Candle[];
  strategy: Strategy;
  config: RiskConfig;
  startingEquity?: number;
  timeframeMinutes?: number;
  source?: BacktestResult["source"];
}): BacktestResult {
  const inst = mustInstrument(opts.symbol);
  const startingEquity = opts.startingEquity ?? 50_000;
  const settings = {
    ...DEFAULT_SETTINGS,
    perTradeRiskPct: opts.config.perTradeRiskPct,
    maxPositionNotionalPct: opts.config.maxPositionNotionalPct,
    dailyLossKillPct: opts.config.dailyLossKillPct,
    maxDrawdownKillPct: opts.config.maxDrawdownKillPct,
    minStopPips: opts.config.minStopPips,
  };
  const firstTime = opts.candles[0]?.time ?? Math.floor(Date.now() / 1000);
  let book: PaperBook = createBook(startingEquity, new Date(firstTime * 1000), settings);
  const skips = new Map<string, number>();
  let pending: ReturnType<Strategy["onBar"]> | null = null;
  const curve: { time: number; equity: number }[] = [
    { time: firstTime, equity: startingEquity },
  ];

  const noteSkip = (result: OrderResult) => {
    const reason = result.error ?? "rejected";
    skips.set(reason, (skips.get(reason) ?? 0) + 1);
  };

  for (let i = 0; i < opts.candles.length; i++) {
    const bar = opts.candles[i];
    const now = new Date(bar.time * 1000);
    if (pending?.action === "enter" && book.positions.length === 0) {
      const opened = placeOrder(
        book,
        {
          symbol: opts.symbol,
          side: pending.side,
          type: "market",
          units: null,
          sizeFromRisk: true,
          stopLoss: pending.stopLoss,
          takeProfit: pending.takeProfit,
          reason: pending.reason,
        },
        { [opts.symbol]: bar.open },
        now,
        opts.config.leverageCap,
      );
      book = opened.book;
      if (opened.error) noteSkip(opened);
    } else if (pending?.action === "exit" && book.positions.length > 0) {
      const closed = closePosition(
        book,
        book.positions[0].id,
        { [opts.symbol]: bar.open },
        now,
        opts.config.leverageCap,
        pending.reason.toLowerCase().includes("session") ? "session" : "signal",
      );
      book = closed.book;
      if (closed.error) noteSkip(closed);
    }
    pending = null;
    book = applyBar(book, opts.symbol, bar, now, opts.config.leverageCap);
    const history = opts.candles.slice(0, i + 1);
    const signal = opts.strategy.onBar({
      candles: history,
      instrument: inst,
      position: book.positions[0] ? { side: book.positions[0].side } : null,
    });
    if (signal.action !== "hold") pending = signal;
    curve.push({
      time: bar.time,
      equity: equityOf(book, midsFromBook(book, { [opts.symbol]: bar.close })),
    });
  }

  if (book.positions.length > 0 && opts.candles.length > 0) {
    const last = opts.candles[opts.candles.length - 1];
    const closed = closePosition(
      book,
      book.positions[0].id,
      { [opts.symbol]: last.close },
      new Date(last.time * 1000),
      opts.config.leverageCap,
      "end",
    );
    if (!closed.error) {
      book = closed.book;
      curve.push({
        time: last.time,
        equity: equityOf(book, midsFromBook(book, { [opts.symbol]: last.close })),
      });
    }
  }

  const endingEquity = equityOf(book, midsFromBook(book));
  const returns = dailyReturns(curve, startingEquity);
  const report = targetReport(returns);
  const stdev = sampleStdev(returns.map((row) => row.ret));
  const mean =
    returns.length > 0
      ? returns.reduce((sum, row) => sum + row.ret, 0) / returns.length
      : 0;
  const sharpe = returns.length >= 2 && stdev > 0 ? (mean / stdev) * Math.sqrt(252) : null;
  const wins = book.trades.filter((trade) => trade.pnlUsd > 0);
  const losses = book.trades.filter((trade) => trade.pnlUsd < 0);
  const grossWin = wins.reduce((sum, trade) => sum + trade.pnlUsd, 0);
  const grossLoss = Math.abs(losses.reduce((sum, trade) => sum + trade.pnlUsd, 0));
  const lowPct = report.lowHitRate == null ? "n/a" : `${(report.lowHitRate * 100).toFixed(1)}%`;
  const note = `The 2% daily band was hit on ${report.daysAtOrAboveLow} of ${report.days} Dubai sessions (${lowPct}). The 3% line was hit on ${report.daysAtOrAboveHigh}. This is the measured rate for this sample, not a forecast. At ${opts.config.leverageCap}:1 a 2% day still needs a large favorable move relative to the cash actually deployed.`;

  return {
    symbol: opts.symbol,
    strategyId: opts.strategy.id,
    strategyName: opts.strategy.name,
    timeframeMinutes: opts.timeframeMinutes ?? 15,
    startingEquity,
    endingEquity,
    totalReturn: startingEquity > 0 ? (endingEquity - startingEquity) / startingEquity : 0,
    maxDrawdown: maxDrawdown(curve, startingEquity),
    sharpe,
    trades: book.trades.length,
    wins: wins.length,
    losses: losses.length,
    winRate: book.trades.length > 0 ? wins.length / book.trades.length : null,
    averagePnl:
      book.trades.length > 0
        ? book.trades.reduce((sum, trade) => sum + trade.pnlUsd, 0) / book.trades.length
        : null,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : null,
    dailyTarget: report,
    skips: [...skips.entries()].map(([reason, count]) => ({ reason, count })),
    equityCurve: downsample(curve, 280),
    tradeLog: book.trades,
    note,
    source: opts.source ?? "supplied",
  };
}

export function recordedSample(opts: {
  symbol: string;
  strategy: Strategy;
  timeframeMinutes?: number;
  bars?: number;
  config: RiskConfig;
  startingEquity?: number;
}): BacktestResult {
  const timeframeMinutes = opts.timeframeMinutes ?? 15;
  const endTime = Date.UTC(2026, 10, 6, 20, 0, 0) / 1000;
  const candles = generateCandles({
    symbol: opts.symbol,
    timeframeMinutes,
    bars: opts.bars ?? 800,
    endTime,
    seed: 42,
  });
  return runBacktest({
    symbol: opts.symbol,
    candles,
    strategy: opts.strategy,
    config: opts.config,
    startingEquity: opts.startingEquity,
    timeframeMinutes,
    source: "recorded",
  });
}

export function assertSpreadOnEntry(symbol: string, mid: number, side: "long" | "short"): number {
  return entryFill(mustInstrument(symbol), side, mid);
}
