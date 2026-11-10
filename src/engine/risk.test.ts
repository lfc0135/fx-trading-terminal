import { describe, expect, it } from "vitest";
import { mustInstrument } from "./instruments";
import { createBook, equityOf, markQuotes, midsFromBook, placeOrder, closePosition } from "./paper";
import { entryFill, lossAtStop } from "./pricing";
import { planOrder, type RiskContext } from "./risk";
import { isFxMarketOpen } from "./time";
import { DEFAULT_SETTINGS, type PaperBook, type RiskConfig } from "./types";

const eur = mustInstrument("EURUSD");
const jpy = mustInstrument("USDJPY");

function tuesday(): Date {
  return new Date(Date.UTC(2026, 10, 10, 12, 0, 0));
}

function config(overrides: Partial<RiskConfig> = {}): RiskConfig {
  return {
    perTradeRiskPct: 0.005,
    maxPositionNotionalPct: 1,
    dailyLossKillPct: 0.02,
    maxDrawdownKillPct: 0.1,
    leverageCap: 1,
    minStopPips: 5,
    ...overrides,
  };
}

function context(overrides: Partial<RiskContext> = {}): RiskContext {
  return {
    equity: 50_000,
    cash: 50_000,
    dayStartEquity: 50_000,
    peakEquity: 50_000,
    openNotionalUsd: 0,
    kill: { daily: false, drawdown: false },
    config: config(),
    ...overrides,
  };
}

function bookWith(settings: Partial<PaperBook["settings"]> = {}): PaperBook {
  return createBook(50_000, tuesday(), { ...DEFAULT_SETTINGS, ...settings });
}

describe("market hours", () => {
  it("is open Tuesday and closed across the weekend boundary", () => {
    expect(isFxMarketOpen(new Date(Date.UTC(2026, 10, 10, 12, 0, 0)))).toBe(true);
    expect(isFxMarketOpen(new Date(Date.UTC(2026, 10, 6, 21, 59, 0)))).toBe(true);
    expect(isFxMarketOpen(new Date(Date.UTC(2026, 10, 6, 22, 0, 0)))).toBe(false);
    expect(isFxMarketOpen(new Date(Date.UTC(2026, 10, 7, 15, 0, 0)))).toBe(false);
    expect(isFxMarketOpen(new Date(Date.UTC(2026, 10, 8, 21, 59, 0)))).toBe(false);
    expect(isFxMarketOpen(new Date(Date.UTC(2026, 10, 8, 22, 0, 0)))).toBe(true);
  });
});

describe("risk engine", () => {
  it("allows a modest long with a stop beyond the ask", () => {
    const decision = planOrder(context(), {
      side: "long",
      units: 10_000,
      sizeFromRisk: false,
      mid: 1.1,
      stopLoss: 1.095,
      takeProfit: 1.11,
      now: tuesday(),
      instrument: eur,
    });
    expect(decision.allowed).toBe(true);
    expect(decision.entryFill).toBeGreaterThan(1.1);
    expect(decision.riskUsd).toBeGreaterThan(0);
    expect(decision.notionalUsd).toBeLessThan(50_000);
  });

  it("rejects a missing stop, a stop on the wrong side, and a stop inside the minimum", () => {
    const missing = planOrder(context(), {
      side: "long",
      units: 10_000,
      sizeFromRisk: false,
      mid: 1.1,
      stopLoss: null,
      takeProfit: null,
      now: tuesday(),
      instrument: eur,
    });
    expect(missing.allowed).toBe(false);
    expect(missing.reasons.join(" ")).toMatch(/Stop-loss is required/);

    const wrong = planOrder(context(), {
      side: "long",
      units: 10_000,
      sizeFromRisk: false,
      mid: 1.1,
      stopLoss: 1.2,
      takeProfit: null,
      now: tuesday(),
      instrument: eur,
    });
    expect(wrong.reasons.join(" ")).toMatch(/wrong side/);

    const tight = planOrder(context(), {
      side: "short",
      units: 10_000,
      sizeFromRisk: false,
      mid: 1.1,
      stopLoss: 1.1001,
      takeProfit: 1.09,
      now: tuesday(),
      instrument: eur,
    });
    expect(tight.allowed).toBe(false);
    expect(tight.reasons.join(" ")).toMatch(/minimum/);
  });

  it("rejects a take-profit on the wrong side", () => {
    const decision = planOrder(context(), {
      side: "short",
      units: 10_000,
      sizeFromRisk: false,
      mid: 1.1,
      stopLoss: 1.105,
      takeProfit: 1.12,
      now: tuesday(),
      instrument: eur,
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reasons.join(" ")).toMatch(/Take-profit/);
  });

  it("rejects when explicit size exceeds the per-trade budget", () => {
    const decision = planOrder(context({ config: config({ perTradeRiskPct: 0.001 }) }), {
      side: "long",
      units: 20_000,
      sizeFromRisk: false,
      mid: 1.1,
      stopLoss: 1.095,
      takeProfit: null,
      now: tuesday(),
      instrument: eur,
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reasons.join(" ")).toMatch(/Per-trade risk/);
  });

  it("shrinks risk-based size to the exposure cap instead of opening an oversized trade", () => {
    const mid = 1.1;
    const stop = 1.095;
    const uncapped = 50_000 * 0.2 / lossAtStop(eur, "long", 1, entryFill(eur, "long", mid), stop);
    const decision = planOrder(
      context({ config: config({ perTradeRiskPct: 0.2, leverageCap: 1 }) }),
      {
        side: "long",
        units: null,
        sizeFromRisk: true,
        mid,
        stopLoss: stop,
        takeProfit: 1.12,
        now: tuesday(),
        instrument: eur,
      },
    );
    expect(decision.allowed).toBe(true);
    expect(decision.units).toBeLessThan(uncapped);
    expect(decision.notionalUsd).toBeLessThanOrEqual(50_000 + 0.05);
    expect(decision.cappedBy.length).toBeGreaterThan(0);
    expect(decision.riskUsd).toBeLessThanOrEqual(50_000 * 0.2 + 0.05);
  });

  it("sizes up to twice equity when the leverage cap is 2", () => {
    const decision = planOrder(
      context({ config: config({ perTradeRiskPct: 0.5, leverageCap: 2, maxPositionNotionalPct: 1 }) }),
      {
        side: "long",
        units: null,
        sizeFromRisk: true,
        mid: 1.1,
        stopLoss: 1.095,
        takeProfit: 1.12,
        now: tuesday(),
        instrument: eur,
      },
    );
    expect(decision.allowed).toBe(true);
    expect(decision.notionalUsd).toBeGreaterThan(50_000);
    expect(decision.notionalUsd).toBeLessThanOrEqual(100_000 + 0.05);
    expect(decision.marginUsd).toBeLessThanOrEqual(50_000 + 0.05);
  });

  it("rejects a new order when gross exposure is already above the leverage cap", () => {
    const decision = planOrder(
      context({
        openNotionalUsd: 52_000,
        cash: 20_000,
        config: config({ leverageCap: 1 }),
      }),
      {
        side: "long",
        units: 1_000,
        sizeFromRisk: false,
        mid: 1.1,
        stopLoss: 1.09,
        takeProfit: null,
        now: tuesday(),
        instrument: eur,
      },
    );
    expect(decision.allowed).toBe(false);
    expect(decision.reasons.join(" ")).toMatch(/Exposure cap/);
  });

  it("blocks new risk when the daily loss or drawdown latch is on", () => {
    const daily = planOrder(context({ kill: { daily: true, drawdown: false } }), {
      side: "long",
      units: 5_000,
      sizeFromRisk: false,
      mid: 1.1,
      stopLoss: 1.09,
      takeProfit: null,
      now: tuesday(),
      instrument: eur,
    });
    expect(daily.reasons.join(" ")).toMatch(/Daily loss kill switch/);

    const drawdown = planOrder(
      context({ equity: 44_000, peakEquity: 50_000, cash: 44_000, config: config({ maxDrawdownKillPct: 0.1 }) }),
      {
        side: "long",
        units: 1_000,
        sizeFromRisk: false,
        mid: 1.1,
        stopLoss: 1.09,
        takeProfit: null,
        now: tuesday(),
        instrument: eur,
      },
    );
    expect(drawdown.reasons.join(" ")).toMatch(/Drawdown kill switch/);
  });

  it("rejects opens while the FX week is closed", () => {
    const decision = planOrder(context(), {
      side: "long",
      units: 5_000,
      sizeFromRisk: false,
      mid: 1.1,
      stopLoss: 1.09,
      takeProfit: null,
      now: new Date(Date.UTC(2026, 10, 7, 12, 0, 0)),
      instrument: eur,
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reasons.join(" ")).toMatch(/FX market is closed/);
  });

  it("measures USDJPY risk in dollars, not yen", () => {
    const entry = entryFill(jpy, "long", 158.8);
    const stop = 158.3;
    const loss = lossAtStop(jpy, "long", 10_000, entry, stop);
    expect(loss).toBeGreaterThan(20);
    expect(loss).toBeLessThan(80);
    const decision = planOrder(context(), {
      side: "long",
      units: 10_000,
      sizeFromRisk: false,
      mid: 158.8,
      stopLoss: stop,
      takeProfit: 159.5,
      now: tuesday(),
      instrument: jpy,
    });
    expect(decision.allowed).toBe(true);
    expect(decision.notionalUsd).toBeCloseTo(10_000, 0);
    expect(decision.riskUsd).toBeCloseTo(loss, 2);
  });
});

describe("paper book", () => {
  it("buys the ask and marks an immediate spread cost", () => {
    const mid = 1.1;
    const opened = placeOrder(
      bookWith(),
      {
        symbol: "EURUSD",
        side: "long",
        type: "market",
        units: 10_000,
        sizeFromRisk: false,
        stopLoss: 1.09,
        takeProfit: 1.12,
      },
      { EURUSD: mid },
      tuesday(),
      1,
    );
    expect(opened.error).toBeNull();
    const position = opened.book.positions[0];
    expect(position.entryPrice).toBeCloseTo(entryFill(eur, "long", mid), 8);
    expect(position.entryPrice).toBeGreaterThan(mid);
    const equity = equityOf(opened.book, { EURUSD: mid });
    expect(equity).toBeLessThan(50_000);
  });

  it("stops out a long when the bid trades through the stop", () => {
    const opened = placeOrder(
      bookWith(),
      {
        symbol: "EURUSD",
        side: "long",
        type: "market",
        units: 10_000,
        sizeFromRisk: false,
        stopLoss: 1.09,
        takeProfit: 1.2,
      },
      { EURUSD: 1.1 },
      tuesday(),
      1,
    );
    const later = new Date(Date.UTC(2026, 10, 10, 13, 0, 0));
    const marked = markQuotes(
      opened.book,
      [{ symbol: "EURUSD", mid: 1.08, time: Math.floor(later.getTime() / 1000) }],
      later,
      1,
    );
    expect(marked.positions).toHaveLength(0);
    expect(marked.trades[0].reason).toBe("stop");
    expect(marked.trades[0].pnlUsd).toBeLessThan(0);
  });

  it("latches the daily loss kill switch, blocks new risk, and still allows a close", () => {
    const book = bookWith({ perTradeRiskPct: 0.2, dailyLossKillPct: 0.02 });
    const opened = placeOrder(
      book,
      {
        symbol: "EURUSD",
        side: "long",
        type: "market",
        units: null,
        sizeFromRisk: true,
        stopLoss: 1.0,
        takeProfit: null,
      },
      { EURUSD: 1.1 },
      tuesday(),
      1,
    );
    expect(opened.error).toBeNull();
    const later = new Date(Date.UTC(2026, 10, 10, 14, 0, 0));
    const marked = markQuotes(
      opened.book,
      [{ symbol: "EURUSD", mid: 1.07, time: Math.floor(later.getTime() / 1000) }],
      later,
      1,
    );
    expect(marked.positions).toHaveLength(1);
    expect(marked.kill.daily).toBe(true);
    const blocked = placeOrder(
      marked,
      {
        symbol: "GBPUSD",
        side: "long",
        type: "market",
        units: 1_000,
        sizeFromRisk: false,
        stopLoss: 1.3,
        takeProfit: null,
      },
      { EURUSD: 1.07, GBPUSD: 1.33 },
      later,
      1,
    );
    expect(blocked.error ?? "").toMatch(/Daily loss kill switch/);
    const closed = closePosition(marked, marked.positions[0].id, { EURUSD: 1.07 }, later, 1, "manual");
    expect(closed.error).toBeNull();
    expect(closed.book.positions).toHaveLength(0);
    expect(closed.book.trades.at(-1)?.reason).toBe("manual");
  });

  it("fills a buy limit when the ask trades down to the limit", () => {
    const opened = placeOrder(
      bookWith(),
      {
        symbol: "EURUSD",
        side: "long",
        type: "limit",
        units: 10_000,
        sizeFromRisk: false,
        limitPrice: 1.09,
        stopLoss: 1.08,
        takeProfit: 1.12,
      },
      { EURUSD: 1.1 },
      tuesday(),
      1,
    );
    expect(opened.book.orders).toHaveLength(1);
    expect(opened.book.positions).toHaveLength(0);
    const later = new Date(Date.UTC(2026, 10, 10, 15, 0, 0));
    const marked = markQuotes(
      opened.book,
      [{ symbol: "EURUSD", mid: 1.089, time: Math.floor(later.getTime() / 1000) }],
      later,
      1,
    );
    expect(marked.orders).toHaveLength(0);
    expect(marked.positions).toHaveLength(1);
    expect(marked.positions[0].entryPrice).toBeLessThanOrEqual(1.09);
  });

  it("does not fill or stop out over the weekend", () => {
    const opened = placeOrder(
      bookWith(),
      {
        symbol: "EURUSD",
        side: "long",
        type: "market",
        units: 5_000,
        sizeFromRisk: false,
        stopLoss: 1.09,
        takeProfit: 1.2,
      },
      { EURUSD: 1.1 },
      tuesday(),
      1,
    );
    expect(opened.error).toBeNull();
    const saturday = new Date(Date.UTC(2026, 10, 7, 12, 0, 0));
    const marked = markQuotes(
      opened.book,
      [{ symbol: "EURUSD", mid: 1.02, time: Math.floor(saturday.getTime() / 1000) }],
      saturday,
      1,
    );
    expect(marked.positions).toHaveLength(1);
    expect(marked.trades).toHaveLength(0);
    const equity = equityOf(marked, midsFromBook(marked, { EURUSD: 1.02 }));
    expect(equity).toBeLessThan(50_000);
  });
});
