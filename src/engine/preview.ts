import { instrument } from "./instruments";
import { configFromSettings, planOrder, type RiskContext } from "./risk";
import type { Side, StoredSettings } from "./types";

export function previewTicket(input: {
  equity: number;
  cash: number;
  dayStartEquity: number;
  peakEquity: number;
  openNotionalUsd: number;
  kill: { daily: boolean; drawdown: boolean };
  settings: StoredSettings;
  leverageCap: number;
  symbol: string;
  side: Side;
  type: "market" | "limit";
  units: number | null;
  sizeFromRisk: boolean;
  mid: number;
  stopLoss: number | null;
  takeProfit: number | null;
  limitPrice: number | null;
  now: Date;
}) {
  const inst = instrument(input.symbol);
  if (!inst) return null;
  const ctx: RiskContext = {
    equity: input.equity,
    cash: input.cash,
    dayStartEquity: input.dayStartEquity,
    peakEquity: input.peakEquity,
    openNotionalUsd: input.openNotionalUsd,
    kill: input.kill,
    config: configFromSettings(input.settings, input.leverageCap),
  };
  const limit = input.type === "limit" && input.limitPrice && input.limitPrice > 0;
  return planOrder(ctx, {
    side: input.side,
    units: input.units,
    sizeFromRisk: input.sizeFromRisk,
    mid: limit ? (input.limitPrice as number) : input.mid,
    entryFillOverride: limit ? (input.limitPrice as number) : undefined,
    stopLoss: input.stopLoss,
    takeProfit: input.takeProfit,
    now: input.now,
    instrument: inst,
  });
}
