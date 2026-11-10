/** Approved ceiling. The desk will not lever past this, even if the env var is higher. */
export const LEVERAGE_HARD_CEILING = 2;
export const DEFAULT_LEVERAGE_CAP = 2;

/** Configured cap used for paper exposure, margin, and the backtester. Always in [1, 2]. */
export function clampLeverageCap(value: number): number {
  if (!Number.isFinite(value) || value < 1) return DEFAULT_LEVERAGE_CAP;
  return Math.min(LEVERAGE_HARD_CEILING, Math.floor(value));
}

/**
 * Leverage written onto an order: min(requested, configured cap), and never above 2.
 * A missing or unusable request uses the cap.
 */
export function orderLeverage(requested: number | undefined, cap: number): number {
  const boundedCap = clampLeverageCap(cap);
  if (requested == null || !Number.isFinite(requested) || requested < 1) return boundedCap;
  return Math.min(Math.floor(requested), boundedCap, LEVERAGE_HARD_CEILING);
}
