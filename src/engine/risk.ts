import { isFxMarketOpen } from "./time";
import {
  entryFill,
  lossAtStop,
  notionalUsd,
  roundUnits,
  stopPips,
  unitsForNotional,
  unitsForRisk,
} from "./pricing";
import type { Instrument, RiskConfig, RiskDecision, Side } from "./types";

export type RiskContext = {
  equity: number;
  cash: number;
  dayStartEquity: number;
  peakEquity: number;
  openNotionalUsd: number;
  kill: { daily: boolean; drawdown: boolean };
  config: RiskConfig;
};

export type PlanInput = {
  side: Side;
  /** Ignored when sizeFromRisk is true, except as a hard request when false. */
  units: number | null;
  sizeFromRisk: boolean;
  mid: number;
  entryFillOverride?: number;
  stopLoss: number | null;
  takeProfit: number | null;
  now: Date;
  instrument: Instrument;
};

export function killStatus(
  account: { equity: number; dayStartEquity: number; peakEquity: number },
  config: Pick<RiskConfig, "dailyLossKillPct" | "maxDrawdownKillPct">,
): {
  dailyPnlPct: number;
  drawdownPct: number;
  dailyLossTripped: boolean;
  drawdownTripped: boolean;
} {
  const dailyPnlPct =
    account.dayStartEquity > 0
      ? (account.equity - account.dayStartEquity) / account.dayStartEquity
      : 0;
  const drawdownPct =
    account.peakEquity > 0
      ? (account.peakEquity - account.equity) / account.peakEquity
      : 0;
  return {
    dailyPnlPct,
    drawdownPct,
    dailyLossTripped: dailyPnlPct <= -config.dailyLossKillPct,
    drawdownTripped: drawdownPct >= config.maxDrawdownKillPct - 1e-12,
  };
}

function emptyDecision(partial: Partial<RiskDecision> & { reasons: string[] }): RiskDecision {
  return {
    allowed: false,
    units: 0,
    riskUsd: 0,
    riskBudgetUsd: 0,
    notionalUsd: 0,
    stopPips: null,
    entryFill: partial.entryFill ?? 0,
    marginUsd: 0,
    cappedBy: [],
    ...partial,
  };
}

export function planOrder(ctx: RiskContext, input: PlanInput): RiskDecision {
  const reasons: string[] = [];
  const fill =
    input.entryFillOverride ?? entryFill(input.instrument, input.side, input.mid);

  if (!isFxMarketOpen(input.now)) {
    reasons.push("FX market is closed");
  }
  if (!Number.isFinite(input.mid) || input.mid <= 0 || !Number.isFinite(fill) || fill <= 0) {
    reasons.push("Price is not usable");
  }
  if (ctx.equity <= 0) {
    reasons.push("Equity is zero");
  }

  const stop = input.stopLoss;
  if (stop == null || !Number.isFinite(stop) || stop <= 0) {
    reasons.push("Stop-loss is required");
  } else if (input.side === "long" && stop >= fill) {
    reasons.push("Stop is on the wrong side of the fill");
  } else if (input.side === "short" && stop <= fill) {
    reasons.push("Stop is on the wrong side of the fill");
  }

  const pips = stop != null && stop > 0 ? stopPips(input.instrument, fill, stop) : null;
  if (pips != null && pips + 1e-9 < ctx.config.minStopPips) {
    reasons.push(
      `Stop is inside the minimum of ${ctx.config.minStopPips} pips`,
    );
  }

  if (input.takeProfit != null && Number.isFinite(input.takeProfit)) {
    if (input.side === "long" && input.takeProfit <= fill) {
      reasons.push("Take-profit is on the wrong side of the fill");
    }
    if (input.side === "short" && input.takeProfit >= fill) {
      reasons.push("Take-profit is on the wrong side of the fill");
    }
  }

  const fresh = killStatus(ctx, ctx.config);
  if (ctx.kill.daily || fresh.dailyLossTripped) {
    reasons.push("Daily loss kill switch is on");
  }
  if (ctx.kill.drawdown || fresh.drawdownTripped) {
    reasons.push("Drawdown kill switch is on");
  }

  const riskBudgetUsd = Math.max(0, ctx.equity * ctx.config.perTradeRiskPct);
  const cappedBy: string[] = [];
  let units = 0;

  const stopOk = reasons.every(
    (reason) =>
      !reason.startsWith("Stop") &&
      !reason.startsWith("Take-profit") &&
      reason !== "Stop-loss is required",
  );

  if (stop != null && stopOk && fill > 0 && ctx.equity > 0) {
    const maxName = ctx.equity * ctx.config.maxPositionNotionalPct;
    const room = ctx.equity * ctx.config.leverageCap - ctx.openNotionalUsd;
    const cashRoom = ctx.cash * ctx.config.leverageCap;
    const notionalRoom = Math.max(0, Math.min(maxName, room, cashRoom));
    const maxUnits = unitsForNotional(input.instrument, fill, notionalRoom);

    if (input.sizeFromRisk) {
      const wanted = unitsForRisk(input.instrument, input.side, fill, stop, riskBudgetUsd);
      units = wanted;
      if (wanted > maxUnits + 1e-8) {
        units = maxUnits;
        if (maxUnits + 1e-8 < wanted) {
          if (room <= maxName && room <= cashRoom) cappedBy.push("exposure cap");
          else if (cashRoom <= maxName) cappedBy.push("cash");
          else cappedBy.push("position cap");
        }
      }
      units = roundUnits(units);
    } else {
      units = roundUnits(input.units ?? 0);
      if (!input.units || input.units <= 0) {
        reasons.push("Units must be positive");
      }
    }
  }

  if (stopOk && input.sizeFromRisk && units <= 0 && reasons.length === 0) {
    reasons.push("Size rounds to zero under the exposure cap");
  }
  if (!input.sizeFromRisk && units <= 0 && !reasons.some((r) => r.startsWith("Units"))) {
    reasons.push("Units must be positive");
  }

  const riskUsd =
    stop != null && units > 0 ? lossAtStop(input.instrument, input.side, units, fill, stop) : 0;
  const notional = units > 0 ? notionalUsd(input.instrument, units, fill) : 0;
  const marginUsd =
    ctx.config.leverageCap > 0 ? notional / ctx.config.leverageCap : notional;

  if (units > 0 && !input.sizeFromRisk && riskUsd > riskBudgetUsd + 0.02) {
    reasons.push("Per-trade risk exceeds the budget");
  }
  if (units > 0 && notional > ctx.equity * ctx.config.maxPositionNotionalPct + 0.02) {
    reasons.push("Position notional exceeds the per-name cap");
  }
  if (
    units > 0 &&
    ctx.openNotionalUsd + notional > ctx.equity * ctx.config.leverageCap + 0.02
  ) {
    reasons.push("Exposure cap would be exceeded");
  }
  if (units > 0 && marginUsd > ctx.cash + 0.02) {
    reasons.push("Not enough cash for the margin");
  }

  const hard = reasons.filter(
    (reason) => reason !== "Size rounds to zero under the exposure cap",
  );
  // A zero size after a structural rejection should not add a second sizing error.
  const finalReasons =
    units <= 0 && hard.length > 0
      ? hard
      : reasons;

  return {
    allowed: finalReasons.length === 0 && units > 0,
    reasons: finalReasons,
    units,
    riskUsd,
    riskBudgetUsd,
    notionalUsd: notional,
    stopPips: pips,
    entryFill: fill,
    marginUsd,
    cappedBy,
  };
}

export function configFromSettings(
  settings: {
    perTradeRiskPct: number;
    maxPositionNotionalPct: number;
    dailyLossKillPct: number;
    maxDrawdownKillPct: number;
    minStopPips: number;
  },
  leverageCap: number,
): RiskConfig {
  return {
    perTradeRiskPct: settings.perTradeRiskPct,
    maxPositionNotionalPct: settings.maxPositionNotionalPct,
    dailyLossKillPct: settings.dailyLossKillPct,
    maxDrawdownKillPct: settings.maxDrawdownKillPct,
    minStopPips: settings.minStopPips,
    leverageCap,
  };
}

export { emptyDecision };
