import { UNIVERSE } from "./instruments";
import type { StoredSettings } from "./types";

export function sanitizeSettings(
  input: Partial<StoredSettings>,
  current: StoredSettings,
): { settings: StoredSettings; error: string | null } {
  const next: StoredSettings = {
    ...current,
    watchlist: [...current.watchlist],
    realMoneyConfirmed: current.realMoneyConfirmed,
  };
  const bounds: Array<[keyof StoredSettings, number, number, string]> = [
    ["perTradeRiskPct", 0.0005, 0.2, "Per-trade risk"],
    ["maxPositionNotionalPct", 0.05, 1, "Max position"],
    ["dailyLossKillPct", 0.005, 0.5, "Daily loss kill"],
    ["maxDrawdownKillPct", 0.02, 0.8, "Drawdown kill"],
    ["minStopPips", 1, 200, "Minimum stop"],
  ];
  for (const [key, min, max, label] of bounds) {
    if (input[key] == null) continue;
    const value = Number(input[key]);
    if (!Number.isFinite(value) || value < min || value > max) {
      return { settings: current, error: `${label} must be between ${min} and ${max}.` };
    }
    if (key === "minStopPips") next.minStopPips = value;
    else if (key === "perTradeRiskPct") next.perTradeRiskPct = value;
    else if (key === "maxPositionNotionalPct") next.maxPositionNotionalPct = value;
    else if (key === "dailyLossKillPct") next.dailyLossKillPct = value;
    else if (key === "maxDrawdownKillPct") next.maxDrawdownKillPct = value;
  }
  if (input.watchlist) {
    const watchlist = input.watchlist.map((item) => item.toUpperCase()).filter((item) => UNIVERSE.includes(item));
    if (watchlist.length === 0) return { settings: current, error: "Keep at least one symbol on the watchlist." };
    next.watchlist = [...new Set(watchlist)];
  }
  return { settings: next, error: null };
}
