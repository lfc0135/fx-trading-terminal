import { instrument } from "./instruments";
import { exitFill, halfSpread, notionalUsd, pnlUsd, spreadCostUsd } from "./pricing";
import { configFromSettings, killStatus, planOrder, type RiskContext } from "./risk";
import { isFxMarketOpen, zonedParts } from "./time";
import type {
  Candle,
  PaperBook,
  Position,
  RiskDecision,
  Side,
  StoredSettings,
  Trade,
  WorkingOrder,
} from "./types";
import { DEFAULT_SETTINGS } from "./types";

export type OrderInput = {
  symbol: string;
  side: Side;
  type: "market" | "limit";
  units: number | null;
  sizeFromRisk: boolean;
  limitPrice?: number | null;
  stopLoss: number | null;
  takeProfit: number | null;
  entryFillOverride?: number;
  reason?: string;
};

export type OrderResult = {
  book: PaperBook;
  decision: RiskDecision | null;
  error: string | null;
  positionId?: string;
  orderId?: string;
};

function nid(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function clone(book: PaperBook): PaperBook {
  return {
    ...book,
    positions: book.positions.map((position) => ({ ...position })),
    orders: book.orders.map((order) => ({ ...order })),
    trades: book.trades.map((trade) => ({ ...trade })),
    equityCurve: book.equityCurve.slice(),
    kill: { ...book.kill },
    notices: book.notices.slice(),
    settings: { ...book.settings, watchlist: [...book.settings.watchlist] },
  };
}

export function createBook(
  startingEquity: number,
  now: Date,
  settings: StoredSettings = DEFAULT_SETTINGS,
): PaperBook {
  const zone = zonedParts(now);
  return {
    cash: startingEquity,
    startEquity: startingEquity,
    peakEquity: startingEquity,
    dayStartEquity: startingEquity,
    dayKey: zone.dayKey,
    monthStartEquity: startingEquity,
    monthKey: zone.monthKey,
    positions: [],
    orders: [],
    trades: [],
    equityCurve: [{ time: Math.floor(now.getTime() / 1000), equity: startingEquity }],
    kill: { daily: false, drawdown: false },
    notices: [],
    settings: { ...settings, watchlist: [...settings.watchlist] },
  };
}

export function midsFromBook(book: PaperBook, extra: Record<string, number> = {}): Record<string, number> {
  const mids: Record<string, number> = { ...extra };
  for (const position of book.positions) {
    if (mids[position.symbol] == null) mids[position.symbol] = position.entryPrice;
  }
  for (const order of book.orders) {
    if (mids[order.symbol] == null) mids[order.symbol] = order.limitPrice;
  }
  return mids;
}

export function equityOf(book: PaperBook, mids: Record<string, number>): number {
  let margin = 0;
  let upl = 0;
  for (const position of book.positions) {
    margin += position.marginUsd;
    const mid = mids[position.symbol];
    const inst = instrument(position.symbol);
    if (mid == null || !inst) continue;
    upl += pnlUsd(
      inst,
      position.side,
      position.units,
      position.entryPrice,
      exitFill(inst, position.side, mid),
    );
  }
  return book.cash + margin + upl;
}

export function openNotional(book: PaperBook, mids: Record<string, number>): number {
  let total = 0;
  for (const position of book.positions) {
    const inst = instrument(position.symbol);
    const mid = mids[position.symbol] ?? position.entryPrice;
    if (!inst) continue;
    total += notionalUsd(inst, position.units, mid);
  }
  return total;
}

export function unrealizedPnl(book: PaperBook, mids: Record<string, number>): number {
  let upl = 0;
  for (const position of book.positions) {
    const mid = mids[position.symbol];
    const inst = instrument(position.symbol);
    if (mid == null || !inst) continue;
    upl += pnlUsd(
      inst,
      position.side,
      position.units,
      position.entryPrice,
      exitFill(inst, position.side, mid),
    );
  }
  return upl;
}

export function touch(
  book: PaperBook,
  now: Date,
  mids: Record<string, number>,
  leverageCap: number,
): PaperBook {
  const next = clone(book);
  const equity = equityOf(next, mids);
  const zone = zonedParts(now);
  if (zone.dayKey !== next.dayKey) {
    next.dayKey = zone.dayKey;
    next.dayStartEquity = equity;
    next.kill.daily = false;
  }
  if (zone.monthKey !== next.monthKey) {
    next.monthKey = zone.monthKey;
    next.monthStartEquity = equity;
  }
  if (equity > next.peakEquity) next.peakEquity = equity;
  const status = killStatus(
    { equity, dayStartEquity: next.dayStartEquity, peakEquity: next.peakEquity },
    configFromSettings(next.settings, leverageCap),
  );
  if (status.dailyLossTripped) next.kill.daily = true;
  if (status.drawdownTripped) next.kill.drawdown = true;
  const time = Math.floor(now.getTime() / 1000);
  const curve = next.equityCurve.slice(-1499);
  if (curve.length > 0 && curve[curve.length - 1].time === time) {
    curve[curve.length - 1] = { time, equity };
  } else {
    curve.push({ time, equity });
  }
  next.equityCurve = curve;
  return next;
}

function contextFor(book: PaperBook, mids: Record<string, number>, leverageCap: number): RiskContext {
  return {
    equity: equityOf(book, mids),
    cash: book.cash,
    dayStartEquity: book.dayStartEquity,
    peakEquity: book.peakEquity,
    openNotionalUsd: openNotional(book, mids),
    kill: book.kill,
    config: configFromSettings(book.settings, leverageCap),
  };
}

function pushNotice(book: PaperBook, time: number, text: string): void {
  book.notices = [...book.notices, { time, text }].slice(-40);
}

function commitOpen(book: PaperBook, input: OrderInput, decision: RiskDecision, now: Date): PaperBook {
  const next = clone(book);
  const position: Position = {
    id: nid("pos"),
    symbol: input.symbol,
    side: input.side,
    units: decision.units,
    entryPrice: decision.entryFill,
    stopLoss: input.stopLoss as number,
    takeProfit: input.takeProfit ?? null,
    openedAt: Math.floor(now.getTime() / 1000),
    marginUsd: decision.marginUsd,
    riskUsd: decision.riskUsd,
    entryReason: input.reason ?? "manual",
  };
  next.cash -= decision.marginUsd;
  next.positions = [...next.positions, position];
  if (decision.cappedBy.length > 0) {
    pushNotice(
      next,
      position.openedAt,
      `${input.symbol} size was reduced by the ${decision.cappedBy.join(" and ")}.`,
    );
  }
  return next;
}

function realize(
  book: PaperBook,
  position: Position,
  price: number,
  now: Date,
  reason: Trade["reason"],
): PaperBook {
  const inst = instrument(position.symbol);
  if (!inst) return book;
  const next = clone(book);
  const pnl = pnlUsd(inst, position.side, position.units, position.entryPrice, price);
  const trade: Trade = {
    id: nid("trd"),
    symbol: position.symbol,
    side: position.side,
    units: position.units,
    entryPrice: position.entryPrice,
    exitPrice: price,
    openedAt: position.openedAt,
    closedAt: Math.floor(now.getTime() / 1000),
    pnlUsd: pnl,
    riskUsd: position.riskUsd,
    spreadCostUsd: spreadCostUsd(inst, position.units, price),
    reason,
    entryReason: position.entryReason,
  };
  next.cash += position.marginUsd + pnl;
  next.positions = next.positions.filter((item) => item.id !== position.id);
  next.trades = [...next.trades, trade].slice(-500);
  return next;
}

export function placeOrder(
  book: PaperBook,
  input: OrderInput,
  mids: Record<string, number>,
  now: Date,
  leverageCap: number,
): OrderResult {
  const inst = instrument(input.symbol);
  if (!inst) return { book, decision: null, error: `Unknown symbol ${input.symbol}` };
  const known = midsFromBook(book, mids);
  if (known[input.symbol] == null || known[input.symbol] <= 0) {
    return { book, decision: null, error: "No price for that symbol" };
  }
  let next = touch(book, now, known, leverageCap);
  if (input.type === "limit" && (input.limitPrice == null || !Number.isFinite(input.limitPrice) || input.limitPrice <= 0)) {
    return { book: next, decision: null, error: "Limit price is required" };
  }
  const fillOverride =
    input.entryFillOverride ??
    (input.type === "limit" ? (input.limitPrice as number) : undefined);
  const decision = planOrder(contextFor(next, known, leverageCap), {
    side: input.side,
    units: input.units,
    sizeFromRisk: input.sizeFromRisk,
    mid: input.type === "limit" ? (input.limitPrice as number) : known[input.symbol],
    entryFillOverride: fillOverride,
    stopLoss: input.stopLoss,
    takeProfit: input.takeProfit,
    now,
    instrument: inst,
  });
  if (!decision.allowed) {
    return { book: next, decision, error: decision.reasons.join(" ") };
  }
  if (input.type === "limit" && input.entryFillOverride == null) {
    const order: WorkingOrder = {
      id: nid("ord"),
      symbol: input.symbol,
      side: input.side,
      units: decision.units,
      limitPrice: input.limitPrice as number,
      stopLoss: input.stopLoss as number,
      takeProfit: input.takeProfit,
      createdAt: Math.floor(now.getTime() / 1000),
      entryReason: input.reason ?? "manual",
    };
    next = clone(next);
    next.orders = [...next.orders, order];
    return { book: next, decision, error: null, orderId: order.id };
  }
  next = commitOpen(next, input, decision, now);
  const position = next.positions[next.positions.length - 1];
  return {
    book: touch(next, now, known, leverageCap),
    decision,
    error: null,
    positionId: position.id,
  };
}

export function cancelOrder(book: PaperBook, orderId: string): OrderResult {
  if (!book.orders.some((order) => order.id === orderId)) {
    return { book, decision: null, error: "Order not found" };
  }
  const next = clone(book);
  next.orders = next.orders.filter((order) => order.id !== orderId);
  return { book: next, decision: null, error: null, orderId };
}

export function closePosition(
  book: PaperBook,
  positionId: string,
  mids: Record<string, number>,
  now: Date,
  leverageCap: number,
  reason: Trade["reason"] = "manual",
  exitPriceOverride?: number,
): OrderResult {
  const position = book.positions.find((item) => item.id === positionId);
  if (!position) return { book, decision: null, error: "Position not found" };
  const inst = instrument(position.symbol);
  if (!inst) return { book, decision: null, error: "Unknown symbol" };
  const known = midsFromBook(book, mids);
  const mid = known[position.symbol];
  if (mid == null) return { book, decision: null, error: "No price for that symbol" };
  const next = touch(book, now, known, leverageCap);
  if (!isFxMarketOpen(now)) {
    return { book: next, decision: null, error: "FX market is closed" };
  }
  const price = exitPriceOverride ?? exitFill(inst, position.side, mid);
  const closed = realize(next, position, price, now, reason);
  return { book: touch(closed, now, known, leverageCap), decision: null, error: null };
}

function protectiveExit(
  side: Side,
  stop: number,
  takeProfit: number | null,
  bar: Candle,
  half: number,
): { price: number; reason: "stop" | "target" } | null {
  if (side === "long") {
    const bidOpen = bar.open - half;
    const bidHigh = bar.high - half;
    const bidLow = bar.low - half;
    const stopHit = bidLow <= stop;
    const targetHit = takeProfit != null && bidHigh >= takeProfit;
    if (stopHit && targetHit) {
      if (bidOpen <= stop) return { price: bidOpen, reason: "stop" };
      if (takeProfit != null && bidOpen >= takeProfit) return { price: bidOpen, reason: "target" };
      return { price: stop, reason: "stop" };
    }
    if (stopHit) return { price: bidOpen <= stop ? bidOpen : stop, reason: "stop" };
    if (targetHit && takeProfit != null) {
      return { price: bidOpen >= takeProfit ? bidOpen : takeProfit, reason: "target" };
    }
    return null;
  }
  const askOpen = bar.open + half;
  const askHigh = bar.high + half;
  const askLow = bar.low + half;
  const stopHit = askHigh >= stop;
  const targetHit = takeProfit != null && askLow <= takeProfit;
  if (stopHit && targetHit) {
    if (askOpen >= stop) return { price: askOpen, reason: "stop" };
    if (takeProfit != null && askOpen <= takeProfit) return { price: askOpen, reason: "target" };
    return { price: stop, reason: "stop" };
  }
  if (stopHit) return { price: askOpen >= stop ? askOpen : stop, reason: "stop" };
  if (targetHit && takeProfit != null) {
    return { price: askOpen <= takeProfit ? askOpen : takeProfit, reason: "target" };
  }
  return null;
}

/** Apply one candle: working limits first, then protective stops on the same bar. */
export function applyBar(
  book: PaperBook,
  symbol: string,
  bar: Candle,
  now: Date,
  leverageCap: number,
): PaperBook {
  const inst = instrument(symbol);
  if (!inst) return book;
  let next = touch(book, now, midsFromBook(book, { [symbol]: bar.close }), leverageCap);
  if (!isFxMarketOpen(now)) return next;
  const half = halfSpread(inst);
  const kept: WorkingOrder[] = [];
  for (const order of next.orders) {
    if (order.symbol !== symbol) {
      kept.push(order);
      continue;
    }
    let fill: number | null = null;
    if (order.side === "long") {
      const askOpen = bar.open + half;
      const askLow = bar.low + half;
      if (askLow <= order.limitPrice) fill = askOpen <= order.limitPrice ? askOpen : order.limitPrice;
    } else {
      const bidOpen = bar.open - half;
      const bidHigh = bar.high - half;
      if (bidHigh >= order.limitPrice) fill = bidOpen >= order.limitPrice ? bidOpen : order.limitPrice;
    }
    if (fill == null) {
      kept.push(order);
      continue;
    }
    const decision = planOrder(contextFor(next, midsFromBook(next, { [symbol]: fill }), leverageCap), {
      side: order.side,
      units: order.units,
      sizeFromRisk: false,
      mid: fill,
      entryFillOverride: fill,
      stopLoss: order.stopLoss,
      takeProfit: order.takeProfit,
      now,
      instrument: inst,
    });
    if (!decision.allowed) {
      pushNotice(next, bar.time, `${symbol} limit cancelled: ${decision.reasons.join(" ")}`);
      continue;
    }
    next = commitOpen(
      next,
      {
        symbol,
        side: order.side,
        type: "market",
        units: order.units,
        sizeFromRisk: false,
        stopLoss: order.stopLoss,
        takeProfit: order.takeProfit,
        reason: order.entryReason,
      },
      decision,
      now,
    );
  }
  next.orders = kept;

  const exits: { id: string; price: number; reason: "stop" | "target" }[] = [];
  for (const position of next.positions) {
    if (position.symbol !== symbol) continue;
    const hit = protectiveExit(position.side, position.stopLoss, position.takeProfit, bar, half);
    if (hit) exits.push({ id: position.id, price: hit.price, reason: hit.reason });
  }
  for (const exit of exits) {
    const live = next.positions.find((position) => position.id === exit.id);
    if (!live) continue;
    next = realize(next, live, exit.price, now, exit.reason);
  }
  return touch(next, now, midsFromBook(next, { [symbol]: bar.close }), leverageCap);
}

export function markQuotes(
  book: PaperBook,
  quotes: { symbol: string; mid: number; time: number }[],
  now: Date,
  leverageCap: number,
): PaperBook {
  let next = book;
  for (const quote of quotes) {
    const bar: Candle = {
      time: quote.time,
      open: quote.mid,
      high: quote.mid,
      low: quote.mid,
      close: quote.mid,
    };
    next = applyBar(next, quote.symbol, bar, now, leverageCap);
  }
  const mids: Record<string, number> = {};
  for (const quote of quotes) mids[quote.symbol] = quote.mid;
  return touch(next, now, midsFromBook(next, mids), leverageCap);
}

export function resetDrawdown(book: PaperBook, now: Date, mids: Record<string, number>, leverageCap: number): PaperBook {
  const marked = touch(book, now, mids, leverageCap);
  const equity = equityOf(marked, mids);
  const next = clone(marked);
  next.peakEquity = equity;
  next.kill.drawdown = false;
  pushNotice(next, Math.floor(now.getTime() / 1000), "Drawdown kill switch reset. Peak equity was set to the current mark.");
  return next;
}
