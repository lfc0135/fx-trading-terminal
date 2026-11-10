import type { Candle, Side, StoredSettings, Trade } from "./types";

export type PriceSource = "yahoo" | "recorded";

export type DeskSnapshot = {
  now: string;
  dubaiLabel: string;
  dubaiDayKey: string;
  marketOpen: boolean;
  sessions: { id: string; name: string; open: boolean; hoursUtc: string }[];
  route: {
    name: "paper" | "etoro-demo" | "etoro-real" | "blocked";
    warning: string | null;
    keysConfigured: boolean;
    venue: "paper" | "etoro";
    etoroMode: "demo" | "real";
    realMoneyConfirmed: boolean;
    leverageCap: number;
    startingBalance: number;
  };
  account: {
    equity: number;
    cash: number;
    startEquity: number;
    unrealizedPnl: number;
    realizedPnl: number;
    dayPnl: number;
    dayPnlPct: number;
    monthPnlPct: number;
    drawdownPct: number;
    peakEquity: number;
    exposureUsd: number;
    exposureCapUsd: number;
    dayBand: "below" | "inside" | "above";
    monthTradingDays: number;
    monthIfLow: number;
    monthIfHigh: number;
    source: "paper" | "etoro";
  };
  kill: {
    daily: boolean;
    drawdown: boolean;
    dailyLossKillPct: number;
    maxDrawdownKillPct: number;
    dailyPnlPct: number;
    drawdownPct: number;
  };
  settings: StoredSettings;
  watchlist: Array<{
    symbol: string;
    name: string;
    bid: number;
    ask: number;
    mid: number;
    decimals: number;
    changePct: number;
    vol: number;
    momentum: number;
    score: number;
    rank: number;
    source: PriceSource;
    proxy: boolean;
    instrumentId: number | null;
  }>;
  chart: {
    symbol: string;
    name: string;
    timeframeMinutes: number;
    candles: Candle[];
    source: PriceSource;
    proxy: boolean;
    decimals: number;
  };
  strategies: { id: string; name: string; description: string }[];
  signals: Array<{
    id: string;
    name: string;
    action: "hold" | "enter" | "exit";
    side: Side | null;
    stopLoss: number | null;
    takeProfit: number | null;
    reason: string | null;
    text: string;
  }>;
  positions: Array<{
    id: string;
    symbol: string;
    side: Side;
    units: number;
    entryPrice: number;
    mark: number;
    stopLoss: number | null;
    takeProfit: number | null;
    unrealizedPnl: number;
    notionalUsd: number;
    source: "paper" | "etoro";
    instrumentId: number | null;
    decimals: number;
  }>;
  orders: Array<{
    id: string;
    symbol: string;
    side: Side;
    units: number;
    limitPrice: number;
    stopLoss: number;
    takeProfit: number | null;
    decimals: number;
  }>;
  trades: Trade[];
  notices: { time: number; text: string }[];
  equityCurve: { time: number; equity: number }[];
  priceFeed: "yahoo" | "recorded" | "mixed";
  etoroError: string | null;
};

export type ActionResult = { ok: true; message: string } | { ok: false; error: string };
