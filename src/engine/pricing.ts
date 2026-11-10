import type { Instrument, Side } from "./types";

export function halfSpread(inst: Instrument): number {
  return (inst.spreadPips * inst.pip) / 2;
}

/** Price you pay to enter. Long buys the ask, short sells the bid. */
export function entryFill(inst: Instrument, side: Side, mid: number): number {
  const half = halfSpread(inst);
  return side === "long" ? mid + half : mid - half;
}

/** Price you receive to exit, before stop/limit caps. */
export function exitFill(inst: Instrument, side: Side, mid: number): number {
  const half = halfSpread(inst);
  return side === "long" ? mid - half : mid + half;
}

export function roundPrice(price: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(price * factor) / factor;
}

export function roundUnits(units: number): number {
  if (!Number.isFinite(units) || units <= 0) return 0;
  return Math.floor(units * 100) / 100;
}

export function pnlUsd(
  inst: Instrument,
  side: Side,
  units: number,
  entry: number,
  exit: number,
): number {
  const dir = side === "long" ? 1 : -1;
  const quotePnl = dir * (exit - entry) * units;
  if (inst.quote === "USD") return quotePnl;
  if (inst.base === "USD") {
    if (exit === 0) return 0;
    return quotePnl / exit;
  }
  return quotePnl;
}

export function notionalUsd(inst: Instrument, units: number, price: number): number {
  if (inst.base === "USD" && inst.quote !== "USD") return Math.abs(units);
  return Math.abs(units * price);
}

export function unitsForNotional(inst: Instrument, price: number, notional: number): number {
  if (notional <= 0 || price <= 0) return 0;
  if (inst.base === "USD" && inst.quote !== "USD") return notional;
  return notional / price;
}

/** Loss in USD if the position is closed at `stop`. */
export function lossAtStop(
  inst: Instrument,
  side: Side,
  units: number,
  entry: number,
  stop: number,
): number {
  return Math.max(0, -pnlUsd(inst, side, units, entry, stop));
}

export function unitsForRisk(
  inst: Instrument,
  side: Side,
  entry: number,
  stop: number,
  riskBudgetUsd: number,
): number {
  if (riskBudgetUsd <= 0) return 0;
  const perUnit = lossAtStop(inst, side, 1, entry, stop);
  if (perUnit <= 0) return 0;
  return riskBudgetUsd / perUnit;
}

export function stopPips(inst: Instrument, entry: number, stop: number): number {
  return Math.abs(entry - stop) / inst.pip;
}

export function spreadCostUsd(inst: Instrument, units: number, price: number): number {
  const quote = inst.spreadPips * inst.pip * Math.abs(units);
  if (inst.quote === "USD") return quote;
  if (inst.base === "USD") return price === 0 ? 0 : quote / price;
  return quote;
}
