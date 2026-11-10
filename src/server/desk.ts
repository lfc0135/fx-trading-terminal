import { recordedSample, runBacktest } from "@/engine/backtest";
import { instrument, mustInstrument } from "@/engine/instruments";
import { rankStats } from "@/engine/rank";
import {
  cancelOrder,
  closePosition,
  createBook,
  equityOf,
  markQuotes,
  midsFromBook,
  openNotional,
  placeOrder,
  resetDrawdown,
  unrealizedPnl,
  type OrderInput,
} from "@/engine/paper";
import { entryFill, exitFill, notionalUsd, pnlUsd } from "@/engine/pricing";
import { configFromSettings, killStatus, planOrder } from "@/engine/risk";
import { sanitizeSettings } from "@/engine/settings";
import { getStrategy, STRATEGIES, type StrategySignal } from "@/engine/strategies";
import { dubaiTradingDaysElapsed, formatDubai, fxSessions, isFxMarketOpen, zonedParts } from "@/engine/time";
import { DAILY_TARGET_HIGH, DAILY_TARGET_LOW, type Candle, type Side } from "@/engine/types";
import { decideRoute, type EtoroPortfolioView } from "@/engine/etoro";
import type { ActionResult, DeskSnapshot } from "@/engine/view";
import { readConfig } from "./config";
import { EtoroBroker } from "./etoro-broker";
import { getSeries, type Series } from "./market";
import { readDesk, withDesk, type EtoroMarks, type FileState } from "./store";

type Quote = { symbol: string; mid: number; time: number };

function band(pct: number): "below" | "inside" | "above" {
  if (pct > DAILY_TARGET_HIGH) return "above";
  if (pct >= DAILY_TARGET_LOW) return "inside";
  return "below";
}

function changePct(candles: Candle[]): number {
  if (candles.length < 2) return 0;
  const last = candles[candles.length - 1];
  const target = last.time - 86_400;
  let ref = candles[0].close;
  for (const candle of candles) {
    if (candle.time <= target) ref = candle.close;
  }
  return ref ? (last.close - ref) / ref : 0;
}

function signalText(signal: StrategySignal, decimals: number): string {
  if (signal.action === "hold") return "No fresh entry. The strategy is standing aside.";
  if (signal.action === "exit") return `Exit · ${signal.reason}`;
  const target = signal.takeProfit == null ? "open target" : signal.takeProfit.toFixed(decimals);
  return `${signal.side === "long" ? "Long" : "Short"} · ${signal.reason}. Stop ${signal.stopLoss.toFixed(decimals)}, target ${target}.`;
}

function rollMarks(
  prev: EtoroMarks | null,
  equity: number,
  now: Date,
  settings: FileState["book"]["settings"],
  leverageCap: number,
): EtoroMarks {
  const zone = zonedParts(now);
  const sameDay = prev?.dayKey === zone.dayKey;
  const sameMonth = prev?.monthKey === zone.monthKey;
  const dayStartEquity = sameDay && prev ? prev.dayStartEquity : equity;
  const monthStartEquity = sameMonth && prev ? prev.monthStartEquity : equity;
  const peakEquity = Math.max(prev && prev.peakEquity > 0 ? prev.peakEquity : equity, equity);
  const kill = {
    daily: sameDay && prev ? prev.kill.daily : false,
    drawdown: prev?.kill.drawdown ?? false,
  };
  const status = killStatus(
    { equity, dayStartEquity, peakEquity },
    configFromSettings(settings, leverageCap),
  );
  if (status.dailyLossTripped) kill.daily = true;
  if (status.drawdownTripped) kill.drawdown = true;
  return {
    dayKey: zone.dayKey,
    monthKey: zone.monthKey,
    dayStartEquity,
    monthStartEquity,
    peakEquity: Math.max(peakEquity, equity),
    kill,
  };
}

function symbolForId(ids: Record<string, number>, id: number): string | null {
  const found = Object.entries(ids).find((entry) => entry[1] === id);
  return found ? found[0] : null;
}

function brokerFor(state: FileState): EtoroBroker {
  const config = readConfig();
  return new EtoroBroker({
    mode: config.etoroMode,
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    userKey: config.userKey,
    instrumentIds: state.instrumentIds,
    leverageCap: config.leverageCap,
  });
}

function buildSnapshot(args: {
  state: FileState;
  symbol: string;
  timeframe: number;
  series: Map<string, Series>;
  chart: Series;
  quotes: Quote[];
  etoro: (EtoroPortfolioView & { error: string | null }) | null;
}): DeskSnapshot {
  const config = readConfig();
  const now = new Date();
  const book = args.state.book;
  const mids = midsFromBook(
    book,
    Object.fromEntries(args.quotes.map((quote) => [quote.symbol, quote.mid])),
  );
  const route = decideRoute({
    venue: config.venue,
    etoroMode: config.etoroMode,
    keysConfigured: config.keysConfigured,
    realMoneyConfirmed: book.settings.realMoneyConfirmed,
  });
  const useEtoro = route.route === "etoro-demo" || route.route === "etoro-real";
  const etoroEquity = args.etoro?.equity ?? args.etoro?.credit ?? null;
  const paperEquity = equityOf(book, mids);
  const paperDayPct = book.dayStartEquity > 0 ? (paperEquity - book.dayStartEquity) / book.dayStartEquity : 0;
  const paperMonthPct =
    book.monthStartEquity > 0 ? (paperEquity - book.monthStartEquity) / book.monthStartEquity : 0;
  const paperDd = book.peakEquity > 0 ? (book.peakEquity - paperEquity) / book.peakEquity : 0;
  const paperExposure = openNotional(book, mids);
  const marks = args.state.etoroMarks;
  const etoroDayPct =
    marks && marks.dayStartEquity > 0 && etoroEquity != null
      ? (etoroEquity - marks.dayStartEquity) / marks.dayStartEquity
      : 0;
  const etoroMonthPct =
    marks && marks.monthStartEquity > 0 && etoroEquity != null
      ? (etoroEquity - marks.monthStartEquity) / marks.monthStartEquity
      : 0;
  const etoroDd =
    marks && marks.peakEquity > 0 && etoroEquity != null ? (marks.peakEquity - etoroEquity) / marks.peakEquity : 0;
  const etoroExposure =
    args.etoro?.positions.reduce((sum, position) => sum + (position.amount ?? 0) * (position.leverage ?? 1), 0) ?? 0;
  const showingEtoro = useEtoro && etoroEquity != null;
  const equity = showingEtoro ? (etoroEquity as number) : paperEquity;
  const dayPct = showingEtoro ? etoroDayPct : paperDayPct;
  const drawdownPct = showingEtoro ? etoroDd : paperDd;
  const exposure = showingEtoro ? etoroExposure : paperExposure;
  const monthDays = dubaiTradingDaysElapsed(now);
  const kill = showingEtoro && marks ? marks.kill : book.kill;
  const status = killStatus(
    {
      equity,
      dayStartEquity: showingEtoro && marks ? marks.dayStartEquity : book.dayStartEquity,
      peakEquity: showingEtoro && marks ? marks.peakEquity : book.peakEquity,
    },
    book.settings,
  );

  const rows = args.state.book.settings.watchlist.map((symbol) => {
    const series = args.series.get(symbol);
    const inst = mustInstrument(symbol);
    const mid = series?.candles.at(-1)?.close ?? inst.anchor;
    const stats = rankStats(series?.candles ?? []);
    return {
      symbol,
      name: inst.name,
      bid: exitFill(inst, "long", mid),
      ask: entryFill(inst, "long", mid),
      mid,
      decimals: inst.decimals,
      changePct: changePct(series?.candles ?? []),
      vol: stats.vol,
      momentum: stats.momentum,
      score: stats.score,
      rank: 0,
      source: series?.source ?? "recorded",
      proxy: inst.yahooProxy,
      instrumentId: args.state.instrumentIds[symbol] ?? null,
    };
  });
  rows.sort((a, b) => b.score - a.score || a.symbol.localeCompare(b.symbol));
  rows.forEach((row, index) => {
    row.rank = index + 1;
  });

  const chartInst = mustInstrument(args.symbol);
  const chartCandles = args.chart.candles;
  const signalCandles = args.series.get(args.symbol)?.candles ?? chartCandles;
  const signals = STRATEGIES.map((strategy) => {
    const signal = strategy.onBar({
      candles: signalCandles,
      instrument: chartInst,
      position: null,
    });
    return {
      id: strategy.id,
      name: strategy.name,
      action: signal.action,
      side: signal.action === "enter" ? signal.side : null,
      stopLoss: signal.action === "enter" ? signal.stopLoss : null,
      takeProfit: signal.action === "enter" ? signal.takeProfit : null,
      reason: signal.action === "hold" ? null : signal.reason,
      text: signalText(signal, chartInst.decimals),
    };
  });

  const quoteBySymbol = new Map(args.quotes.map((quote) => [quote.symbol, quote.mid]));
  const positions = showingEtoro
    ? (args.etoro?.positions ?? []).map((position) => {
        const symbol = symbolForId(args.state.instrumentIds, position.instrumentId) ?? `#${position.instrumentId}`;
        const inst = instrument(symbol);
        const mid = quoteBySymbol.get(symbol) ?? position.openRate ?? 0;
        const side: Side = position.isBuy ? "long" : "short";
        const unrealized =
          position.pnl ??
          (inst && position.openRate
            ? pnlUsd(inst, side, position.units, position.openRate, exitFill(inst, side, mid || position.openRate))
            : 0);
        return {
          id: position.positionId,
          symbol,
          side,
          units: position.units,
          entryPrice: position.openRate ?? mid,
          mark: mid || position.openRate || 0,
          stopLoss: position.stopLoss,
          takeProfit: position.takeProfit,
          unrealizedPnl: unrealized,
          notionalUsd: position.amount != null ? position.amount * (position.leverage ?? 1) : inst ? notionalUsd(inst, position.units, mid || position.openRate || 0) : 0,
          source: "etoro" as const,
          instrumentId: position.instrumentId,
          decimals: inst?.decimals ?? 5,
        };
      })
    : book.positions.map((position) => {
        const inst = mustInstrument(position.symbol);
        const mid = mids[position.symbol] ?? position.entryPrice;
        const mark = exitFill(inst, position.side, mid);
        return {
          id: position.id,
          symbol: position.symbol,
          side: position.side,
          units: position.units,
          entryPrice: position.entryPrice,
          mark,
          stopLoss: position.stopLoss,
          takeProfit: position.takeProfit,
          unrealizedPnl: pnlUsd(inst, position.side, position.units, position.entryPrice, mark),
          notionalUsd: notionalUsd(inst, position.units, mid),
          source: "paper" as const,
          instrumentId: args.state.instrumentIds[position.symbol] ?? null,
          decimals: inst.decimals,
        };
      });

  const sources = new Set(rows.map((row) => row.source));
  const priceFeed = sources.size > 1 ? "mixed" : sources.has("yahoo") ? "yahoo" : "recorded";

  return {
    now: now.toISOString(),
    dubaiLabel: formatDubai(now),
    dubaiDayKey: zonedParts(now).dayKey,
    marketOpen: isFxMarketOpen(now),
    sessions: fxSessions(now),
    route: {
      name: route.route,
      warning: route.warning,
      keysConfigured: config.keysConfigured,
      venue: config.venue,
      etoroMode: config.etoroMode,
      realMoneyConfirmed: book.settings.realMoneyConfirmed,
      leverageCap: config.leverageCap,
      startingBalance: config.startingBalance,
    },
    account: {
      equity,
      cash: showingEtoro ? (args.etoro?.credit ?? equity) : book.cash,
      startEquity: showingEtoro ? equity : book.startEquity,
      unrealizedPnl: showingEtoro
        ? positions.reduce((sum, position) => sum + position.unrealizedPnl, 0)
        : unrealizedPnl(book, mids),
      realizedPnl: book.trades.reduce((sum, trade) => sum + trade.pnlUsd, 0),
      dayPnl: showingEtoro && marks ? equity - marks.dayStartEquity : paperEquity - book.dayStartEquity,
      dayPnlPct: dayPct,
      monthPnlPct: showingEtoro ? etoroMonthPct : paperMonthPct,
      drawdownPct,
      peakEquity: showingEtoro && marks ? marks.peakEquity : book.peakEquity,
      exposureUsd: exposure,
      exposureCapUsd: equity * config.leverageCap,
      dayBand: band(dayPct),
      monthTradingDays: monthDays,
      monthIfLow: monthDays > 0 ? (1 + DAILY_TARGET_LOW) ** monthDays - 1 : 0,
      monthIfHigh: monthDays > 0 ? (1 + DAILY_TARGET_HIGH) ** monthDays - 1 : 0,
      source: showingEtoro ? "etoro" : "paper",
    },
    kill: {
      daily: kill.daily || status.dailyLossTripped,
      drawdown: kill.drawdown || status.drawdownTripped,
      dailyLossKillPct: book.settings.dailyLossKillPct,
      maxDrawdownKillPct: book.settings.maxDrawdownKillPct,
      dailyPnlPct: status.dailyPnlPct,
      drawdownPct: status.drawdownPct,
    },
    settings: book.settings,
    watchlist: rows,
    chart: {
      symbol: args.symbol,
      name: chartInst.name,
      timeframeMinutes: args.timeframe,
      candles: chartCandles,
      source: args.chart.source,
      proxy: chartInst.yahooProxy,
      decimals: chartInst.decimals,
    },
    strategies: STRATEGIES.map((strategy) => ({
      id: strategy.id,
      name: strategy.name,
      description: strategy.description,
    })),
    signals,
    positions,
    orders:
      route.route === "paper"
        ? book.orders.map((order) => ({
            id: order.id,
            symbol: order.symbol,
            side: order.side,
            units: order.units,
            limitPrice: order.limitPrice,
            stopLoss: order.stopLoss,
            takeProfit: order.takeProfit,
            decimals: mustInstrument(order.symbol).decimals,
          }))
        : [],
    trades: [...book.trades].reverse().slice(0, 80),
    notices: [...book.notices].reverse().slice(0, 8),
    equityCurve: book.equityCurve.slice(-240),
    priceFeed,
    etoroError: args.etoro?.error ?? null,
  };
}

async function loadMarket(watchlist: string[], symbol: string | undefined, timeframe: number) {
  const seriesList = await Promise.all(watchlist.map((item) => getSeries(item, 15, 220)));
  const series = new Map(seriesList.map((item) => [item.symbol, item]));
  const ranked = [...watchlist].sort((a, b) => {
    const scoreA = rankStats(series.get(a)?.candles ?? []).score;
    const scoreB = rankStats(series.get(b)?.candles ?? []).score;
    return scoreB - scoreA || a.localeCompare(b);
  });
  const chosen =
    symbol && watchlist.includes(symbol.toUpperCase()) ? symbol.toUpperCase() : (ranked[0] ?? watchlist[0]);
  const chart = timeframe === 15 ? (series.get(chosen) as Series) : await getSeries(chosen, timeframe, 220);
  const quotes: Quote[] = watchlist.map((item) => {
    const last = series.get(item)?.candles.at(-1);
    return { symbol: item, mid: last?.close ?? mustInstrument(item).anchor, time: last?.time ?? Math.floor(Date.now() / 1000) };
  });
  return { series, chart, quotes, symbol: chosen };
}

export async function getDesk(query: { symbol?: string; timeframe?: number } = {}): Promise<DeskSnapshot> {
  const peeked = readDesk();
  const config = readConfig();
  const timeframe = query.timeframe === 60 ? 60 : 15;
  const market = await loadMarket(peeked.book.settings.watchlist, query.symbol, timeframe);
  const route = decideRoute({
    venue: config.venue,
    etoroMode: config.etoroMode,
    keysConfigured: config.keysConfigured,
    realMoneyConfirmed: peeked.book.settings.realMoneyConfirmed,
  });
  let etoro: (EtoroPortfolioView & { error: string | null }) | null = null;
  if (route.route === "etoro-demo" || route.route === "etoro-real") {
    try {
      etoro = await brokerFor(peeked).portfolio();
    } catch (error) {
      etoro = {
        equity: null,
        credit: null,
        positions: [],
        error: error instanceof Error ? error.message : "eToro portfolio read failed",
      };
    }
  }
  const now = new Date();
  return withDesk<DeskSnapshot>((state) => {
    const book = markQuotes(state.book, market.quotes, now, config.leverageCap);
    let etoroMarks = state.etoroMarks;
    const equity = etoro?.equity ?? etoro?.credit ?? null;
    if (etoro && etoro.error == null && equity != null) {
      etoroMarks = rollMarks(etoroMarks, equity, now, book.settings, config.leverageCap);
    }
    const next = { ...state, book, etoroMarks };
    return {
      state: next,
      result: buildSnapshot({
        state: next,
        symbol: market.symbol,
        timeframe,
        series: market.series,
        chart: market.chart,
        quotes: market.quotes,
        etoro,
      }),
    };
  });
}

function parseFinite(value: unknown): number | null {
  if (value == null || value === "") return null;
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : null;
}

export async function submitOrder(body: unknown): Promise<ActionResult> {
  const raw = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const symbol = String(raw.symbol ?? "").toUpperCase();
  const side = raw.side === "short" ? "short" : raw.side === "long" ? "long" : null;
  const type = raw.type === "limit" ? "limit" : raw.type === "market" ? "market" : null;
  if (!instrument(symbol) || !side || !type) {
    return { ok: false, error: "Symbol, side, and order type are required." };
  }
  const input: OrderInput = {
    symbol,
    side,
    type,
    units: parseFinite(raw.units),
    sizeFromRisk: raw.sizeFromRisk !== false,
    limitPrice: parseFinite(raw.limitPrice),
    stopLoss: parseFinite(raw.stopLoss),
    takeProfit: parseFinite(raw.takeProfit),
    reason: "manual",
  };
  const series = await getSeries(symbol, 15, 30);
  const mid = series.candles.at(-1)?.close;
  if (mid == null) return { ok: false, error: "No price for that symbol." };
  const config = readConfig();
  return withDesk<ActionResult>(async (state) => {
    const route = decideRoute({
      venue: config.venue,
      etoroMode: config.etoroMode,
      keysConfigured: config.keysConfigured,
      realMoneyConfirmed: state.book.settings.realMoneyConfirmed,
    });
    if (route.route === "blocked") {
      return { state, result: { ok: false, error: route.warning ?? "Real routing is locked." } };
    }
    const now = new Date();
    if (route.route === "paper") {
      const placed = placeOrder(state.book, input, { [symbol]: mid }, now, config.leverageCap);
      if (placed.error || !placed.decision) {
        return { state: { ...state, book: placed.book }, result: { ok: false, error: placed.error ?? "Order rejected." } };
      }
      const verb = side === "long" ? "Buy" : "Sell";
      const where = type === "limit" ? "limit working" : "filled";
      const cap = placed.decision.cappedBy.length ? ` Size was cut by the ${placed.decision.cappedBy.join(" and ")}.` : "";
      return {
        state: { ...state, book: placed.book },
        result: {
          ok: true,
          message: `${verb} ${placed.decision.units.toLocaleString("en-US")} ${symbol} ${where} at ${placed.decision.entryFill.toFixed(mustInstrument(symbol).decimals)}. Risk ${placed.decision.riskUsd.toFixed(2)} USD.${cap}`,
        },
      };
    }
    const broker = brokerFor(state);
    const portfolio = await broker.portfolio();
    const equity = portfolio.equity ?? portfolio.credit;
    if (portfolio.error || equity == null) {
      return {
        state,
        result: { ok: false, error: portfolio.error ?? "Risk engine needs an eToro equity figure before it can release an order." },
      };
    }
    const etoroMarks = rollMarks(state.etoroMarks, equity, now, state.book.settings, config.leverageCap);
    const exposure = portfolio.positions.reduce((sum, position) => sum + (position.amount ?? 0) * (position.leverage ?? 1), 0);
    const inst = mustInstrument(symbol);
    const decision = planOrder(
      {
        equity,
        cash: portfolio.credit ?? Math.max(0, equity - exposure),
        dayStartEquity: etoroMarks.dayStartEquity,
        peakEquity: etoroMarks.peakEquity,
        openNotionalUsd: exposure,
        kill: etoroMarks.kill,
        config: configFromSettings(state.book.settings, config.leverageCap),
      },
      {
        side,
        units: input.units,
        sizeFromRisk: input.sizeFromRisk,
        mid: type === "limit" && input.limitPrice ? input.limitPrice : mid,
        entryFillOverride: type === "limit" && input.limitPrice ? input.limitPrice : undefined,
        stopLoss: input.stopLoss,
        takeProfit: input.takeProfit,
        now,
        instrument: inst,
      },
    );
    if (!decision.allowed) {
      return { state: { ...state, etoroMarks }, result: { ok: false, error: decision.reasons.join(" ") } };
    }
    const fill = await broker.placeOrder({
      symbol,
      side,
      type,
      units: decision.units,
      limitPrice: input.limitPrice ?? null,
      stopLoss: input.stopLoss,
      takeProfit: input.takeProfit,
    });
    const next = { ...state, etoroMarks, instrumentIds: state.instrumentIds };
    if (fill.status === "rejected") return { state: next, result: { ok: false, error: fill.message } };
    return { state: next, result: { ok: true, message: fill.message } };
  });
}

export async function submitClose(body: unknown): Promise<ActionResult> {
  const raw = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const id = String(raw.id ?? "");
  const instrumentId = parseFinite(raw.instrumentId);
  if (!id) return { ok: false, error: "Position id is required." };
  const config = readConfig();
  return withDesk<ActionResult>(async (state) => {
    const route = decideRoute({
      venue: config.venue,
      etoroMode: config.etoroMode,
      keysConfigured: config.keysConfigured,
      realMoneyConfirmed: state.book.settings.realMoneyConfirmed,
    });
    if (route.route === "blocked") return { state, result: { ok: false, error: route.warning ?? "Real routing is locked." } };
    if (route.route === "paper") {
      const position = state.book.positions.find((item) => item.id === id);
      if (!position) return { state, result: { ok: false, error: "Position not found on the paper book." } };
      const series = await getSeries(position.symbol, 15, 5);
      const mid = series.candles.at(-1)?.close ?? position.entryPrice;
      const closed = closePosition(state.book, id, { [position.symbol]: mid }, new Date(), config.leverageCap, "manual");
      if (closed.error) return { state: { ...state, book: closed.book }, result: { ok: false, error: closed.error } };
      const trade = closed.book.trades.at(-1);
      return {
        state: { ...state, book: closed.book },
        result: {
          ok: true,
          message: `Closed ${position.symbol} ${position.side}. P&L ${trade ? trade.pnlUsd.toFixed(2) : "0.00"} USD.`,
        },
      };
    }
    const fill = await brokerFor(state).closePosition(id, instrumentId);
    if (fill.status === "rejected") return { state, result: { ok: false, error: fill.message } };
    return { state, result: { ok: true, message: fill.message } };
  });
}

export async function submitCancel(body: unknown): Promise<ActionResult> {
  const raw = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const id = String(raw.id ?? "");
  if (!id) return { ok: false, error: "Order id is required." };
  const config = readConfig();
  return withDesk<ActionResult>(async (state) => {
    const route = decideRoute({
      venue: config.venue,
      etoroMode: config.etoroMode,
      keysConfigured: config.keysConfigured,
      realMoneyConfirmed: state.book.settings.realMoneyConfirmed,
    });
    if (route.route === "paper" || route.route === "blocked") {
      const cancelled = cancelOrder(state.book, id);
      if (cancelled.error) return { state, result: { ok: false, error: cancelled.error } };
      return { state: { ...state, book: cancelled.book }, result: { ok: true, message: "Working order cancelled." } };
    }
    const fill = await brokerFor(state).cancelOrder(id);
    if (fill.status === "rejected") return { state, result: { ok: false, error: fill.message } };
    return { state, result: { ok: true, message: fill.message } };
  });
}

export async function updateSettings(body: unknown): Promise<ActionResult> {
  const raw = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  return withDesk<ActionResult>((state) => {
    const cleaned = sanitizeSettings(
      {
        perTradeRiskPct: parseFinite(raw.perTradeRiskPct) ?? undefined,
        maxPositionNotionalPct: parseFinite(raw.maxPositionNotionalPct) ?? undefined,
        dailyLossKillPct: parseFinite(raw.dailyLossKillPct) ?? undefined,
        maxDrawdownKillPct: parseFinite(raw.maxDrawdownKillPct) ?? undefined,
        minStopPips: parseFinite(raw.minStopPips) ?? undefined,
        watchlist: Array.isArray(raw.watchlist) ? raw.watchlist.map((item) => String(item)) : undefined,
      },
      state.book.settings,
    );
    if (cleaned.error) return { state, result: { ok: false, error: cleaned.error } };
    return {
      state: { ...state, book: { ...state.book, settings: cleaned.settings } },
      result: { ok: true, message: "Risk settings saved on this desk." },
    };
  });
}

export async function confirmReal(body: unknown): Promise<ActionResult> {
  const raw = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const disarm = raw.disarm === true;
  return withDesk<ActionResult>((state) => {
    if (disarm) {
      return {
        state: { ...state, book: { ...state.book, settings: { ...state.book.settings, realMoneyConfirmed: false } } },
        result: { ok: true, message: "Real-money confirmation removed." },
      };
    }
    if (raw.phrase !== "ENABLE REAL MONEY") {
      return { state, result: { ok: false, error: "Type ENABLE REAL MONEY to confirm." } };
    }
    const config = readConfig();
    if (config.venue !== "etoro") {
      return { state, result: { ok: false, error: "Set TRADING_VENUE=etoro before arming a live account." } };
    }
    if (config.etoroMode !== "real") {
      return { state, result: { ok: false, error: "Set ETORO_TRADING_MODE=real. Demo cannot be confirmed into the live account." } };
    }
    if (!config.keysConfigured) {
      return { state, result: { ok: false, error: "ETORO_API_KEY and ETORO_USER_KEY are both required." } };
    }
    return {
      state: { ...state, book: { ...state.book, settings: { ...state.book.settings, realMoneyConfirmed: true } } },
      result: { ok: true, message: "Real-money routing is armed. Orders can reach the live eToro account." },
    };
  });
}

export async function resetPaperBook(body: unknown): Promise<ActionResult> {
  const raw = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  if (raw.phrase !== "RESET PAPER") return { ok: false, error: "Type RESET PAPER to wipe the simulator." };
  const config = readConfig();
  return withDesk<ActionResult>((state) => ({
    state: {
      ...state,
      book: createBook(config.startingBalance, new Date(), state.book.settings),
    },
    result: { ok: true, message: `Paper book reset to ${config.startingBalance.toLocaleString("en-US")} USD.` },
  }));
}

export async function resetDrawdownKill(body: unknown): Promise<ActionResult> {
  const raw = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  if (raw.phrase !== "RESET DRAWDOWN") {
    return { ok: false, error: "Type RESET DRAWDOWN to re-arm the peak." };
  }
  const config = readConfig();
  return withDesk<ActionResult>((state) => {
    const book = resetDrawdown(state.book, new Date(), midsFromBook(state.book), config.leverageCap);
    const etoroMarks = state.etoroMarks
      ? { ...state.etoroMarks, peakEquity: 0, kill: { ...state.etoroMarks.kill, drawdown: false } }
      : null;
    return {
      state: { ...state, book, etoroMarks },
      result: { ok: true, message: "Drawdown kill switch reset. The peak is the current mark." },
    };
  });
}

export async function requestBacktest(body: unknown) {
  const raw = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const symbol = String(raw.symbol ?? "EURUSD").toUpperCase();
  const strategy = getStrategy(String(raw.strategy ?? "momentum"));
  const source = raw.source === "live" ? "live" : "recorded";
  const timeframeMinutes = Number(raw.timeframeMinutes) === 60 ? 60 : 15;
  let bars = Number(raw.bars ?? 800);
  if (!instrument(symbol)) return { error: "Unknown symbol." };
  if (!strategy) return { error: "Unknown strategy." };
  if (!Number.isFinite(bars)) bars = 800;
  bars = Math.max(80, Math.min(1200, Math.floor(bars)));
  const state = readDesk();
  const config = configFromSettings(state.book.settings, readConfig().leverageCap);
  if (source === "recorded") {
    return recordedSample({ symbol, strategy, timeframeMinutes, bars, config, startingEquity: state.book.startEquity });
  }
  const series = await getSeries(symbol, timeframeMinutes, bars);
  return runBacktest({
    symbol,
    candles: series.candles,
    strategy,
    config,
    startingEquity: state.book.startEquity,
    timeframeMinutes,
    source: series.source === "yahoo" ? "yahoo" : "recorded",
  });
}
