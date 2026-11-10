export type Side = "long" | "short";

export type Candle = {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
};

export type Instrument = {
  symbol: string;
  name: string;
  base: string;
  quote: string;
  pip: number;
  decimals: number;
  spreadPips: number;
  yahooSymbol: string;
  /** Public feed is a proxy (COMEX future) rather than the spot pair. */
  yahooProxy: boolean;
  searchTerms: string[];
  annualVol: number;
  anchor: number;
};

export type RiskConfig = {
  /** Fraction of equity. 0.005 is 0.5%. */
  perTradeRiskPct: number;
  /** Fraction of equity allowed in one symbol. */
  maxPositionNotionalPct: number;
  /** Fraction. A 0.02 latch trips when the Dubai day is down 2%. */
  dailyLossKillPct: number;
  /** Fraction of peak equity. */
  maxDrawdownKillPct: number;
  /** Gross exposure cap as a multiple of equity. 2 is the approved ceiling. */
  leverageCap: number;
  minStopPips: number;
};

export type StoredSettings = {
  perTradeRiskPct: number;
  maxPositionNotionalPct: number;
  dailyLossKillPct: number;
  maxDrawdownKillPct: number;
  minStopPips: number;
  watchlist: string[];
  realMoneyConfirmed: boolean;
};

export type Position = {
  id: string;
  symbol: string;
  side: Side;
  units: number;
  entryPrice: number;
  stopLoss: number;
  takeProfit: number | null;
  openedAt: number;
  marginUsd: number;
  riskUsd: number;
  entryReason: string;
};

export type WorkingOrder = {
  id: string;
  symbol: string;
  side: Side;
  units: number;
  limitPrice: number;
  stopLoss: number;
  takeProfit: number | null;
  createdAt: number;
  entryReason: string;
};

export type Trade = {
  id: string;
  symbol: string;
  side: Side;
  units: number;
  entryPrice: number;
  exitPrice: number;
  openedAt: number;
  closedAt: number;
  pnlUsd: number;
  riskUsd: number;
  spreadCostUsd: number;
  reason: "stop" | "target" | "manual" | "signal" | "session" | "end";
  entryReason: string;
};

export type Notice = {
  time: number;
  text: string;
};

export type PaperBook = {
  cash: number;
  startEquity: number;
  peakEquity: number;
  dayStartEquity: number;
  dayKey: string;
  monthStartEquity: number;
  monthKey: string;
  positions: Position[];
  orders: WorkingOrder[];
  trades: Trade[];
  equityCurve: { time: number; equity: number }[];
  kill: { daily: boolean; drawdown: boolean };
  notices: Notice[];
  settings: StoredSettings;
};

export type RiskDecision = {
  allowed: boolean;
  reasons: string[];
  units: number;
  riskUsd: number;
  riskBudgetUsd: number;
  notionalUsd: number;
  stopPips: number | null;
  entryFill: number;
  marginUsd: number;
  cappedBy: string[];
};

export const DAILY_TARGET_LOW = 0.02;
export const DAILY_TARGET_HIGH = 0.03;
export const STARTING_BALANCE = 50_000;

export const DEFAULT_SETTINGS: StoredSettings = {
  perTradeRiskPct: 0.005,
  maxPositionNotionalPct: 1,
  dailyLossKillPct: 0.02,
  maxDrawdownKillPct: 0.1,
  minStopPips: 5,
  watchlist: [
    "EURUSD",
    "GBPUSD",
    "USDJPY",
    "AUDUSD",
    "USDCAD",
    "USDCHF",
    "NZDUSD",
    "XAUUSD",
  ],
  realMoneyConfirmed: false,
};
