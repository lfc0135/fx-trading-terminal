import type { Side } from "./types";

export const ETORO_ORIGIN = "https://public-api.etoro.com";

export type EtoroMode = "demo" | "real";

export type EtoroPaths = {
  portfolio: string;
  pnl: string;
  orders: string;
  orderLookup: string;
  closePosition: (positionId: string) => string;
  cancelOrder: (orderId: string) => string;
  search: string;
  rates: (instrumentIds: number[]) => string;
  candles: (instrumentId: number, interval: string, count: number) => string;
};

/**
 * Published eToro paths. Real portfolio lives at `/api/v1/trading/info/portfolio`
 * (there is no `/real/` segment on that route). Real PnL does use `/real/`.
 * Real execution omits the `demo` segment rather than inserting `real`.
 */
export function etoroPaths(mode: EtoroMode): EtoroPaths {
  if (mode === "demo") {
    return {
      portfolio: "/api/v1/trading/info/demo/portfolio",
      pnl: "/api/v1/trading/info/demo/pnl",
      orders: "/api/v2/trading/execution/demo/orders",
      orderLookup: "/api/v2/trading/info/demo/orders:lookup",
      closePosition: (positionId) =>
        `/api/v1/trading/execution/demo/market-close-orders/positions/${positionId}`,
      cancelOrder: (orderId) => `/api/v2/trading/execution/demo/orders/${orderId}`,
      search: "/api/v1/market-data/search",
      rates: (ids) => `/api/v1/market-data/instruments/rates?instrumentIds=${ids.join(",")}`,
      candles: (id, interval, count) =>
        `/api/v1/market-data/instruments/${id}/history/candles/asc/${interval}/${count}`,
    };
  }
  return {
    portfolio: "/api/v1/trading/info/portfolio",
    pnl: "/api/v1/trading/info/real/pnl",
    orders: "/api/v2/trading/execution/orders",
    orderLookup: "/api/v2/trading/info/orders:lookup",
    closePosition: (positionId) =>
      `/api/v1/trading/execution/market-close-orders/positions/${positionId}`,
    cancelOrder: (orderId) => `/api/v2/trading/execution/orders/${orderId}`,
    search: "/api/v1/market-data/search",
    rates: (ids) => `/api/v1/market-data/instruments/rates?instrumentIds=${ids.join(",")}`,
    candles: (id, interval, count) =>
      `/api/v1/market-data/instruments/${id}/history/candles/asc/${interval}/${count}`,
  };
}

export const ETORO_INTERVALS: Record<number, string> = {
  1: "OneMinute",
  5: "FiveMinutes",
  10: "TenMinutes",
  15: "FifteenMinutes",
  30: "ThirtyMinutes",
  60: "OneHour",
  240: "FourHours",
  1440: "OneDay",
};

export function searchQuery(term: string): string {
  const params = new URLSearchParams({
    internalSymbolFull: term,
    fields: "instrumentId,internalSymbolFull,displayname",
    pageSize: "5",
  });
  return `${etoroPaths("demo").search}?${params.toString()}`;
}

export type OpenOrderBody = {
  action: "open";
  transaction: "buy" | "sellShort";
  instrumentId: number;
  orderType: "mkt" | "mit";
  leverage: 1;
  units: number;
  triggerRate?: number;
  stopLossRate?: number;
  takeProfitRate?: number;
  stopLossType?: "fixed";
};

/** eToro leverage is fixed at 1 until the desk is explicitly allowed to raise it. */
export function buildOpenOrder(input: {
  instrumentId: number;
  side: Side;
  orderType: "market" | "limit";
  units: number;
  limitPrice?: number | null;
  stopLoss?: number | null;
  takeProfit?: number | null;
}): OpenOrderBody {
  const body: OpenOrderBody = {
    action: "open",
    transaction: input.side === "long" ? "buy" : "sellShort",
    instrumentId: input.instrumentId,
    orderType: input.orderType === "market" ? "mkt" : "mit",
    leverage: 1,
    units: input.units,
  };
  if (input.orderType === "limit" && input.limitPrice != null) body.triggerRate = input.limitPrice;
  if (input.stopLoss != null) {
    body.stopLossRate = input.stopLoss;
    body.stopLossType = "fixed";
  }
  if (input.takeProfit != null) body.takeProfitRate = input.takeProfit;
  return body;
}

export function buildCloseBody(instrumentId: number, units?: number | null): {
  InstrumentID: number;
  UnitsToDeduct?: number;
} {
  const body: { InstrumentID: number; UnitsToDeduct?: number } = { InstrumentID: instrumentId };
  if (units != null) body.UnitsToDeduct = units;
  return body;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type EtoroResponse = {
  status: number;
  body: unknown;
  requestId: string;
  attempts: number;
};

export async function etoroRequest(opts: {
  baseUrl: string;
  apiKey: string;
  userKey: string;
  path: string;
  method?: string;
  body?: unknown;
  fetchImpl?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  uuid?: () => string;
  jitter?: () => number;
  maxAttempts?: number;
  maxBackoffMs?: number;
}): Promise<EtoroResponse> {
  if (!opts.apiKey || !opts.userKey) {
    throw new Error("eToro keys are not configured");
  }
  const fetchImpl = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const uuid = opts.uuid ?? (() => crypto.randomUUID());
  const jitter = opts.jitter ?? (() => Math.floor(Math.random() * 150));
  const requestId = uuid();
  const maxAttempts = opts.maxAttempts ?? 4;
  const cap = opts.maxBackoffMs ?? 8_000;
  let lastStatus = 0;
  let lastBody: unknown = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const headers: Record<string, string> = {
      "x-api-key": opts.apiKey,
      "x-user-key": opts.userKey,
      "x-request-id": requestId,
      accept: "application/json",
    };
    if (opts.body !== undefined) headers["content-type"] = "application/json";
    const response = await fetchImpl(`${opts.baseUrl}${opts.path}`, {
      method: opts.method ?? (opts.body !== undefined ? "POST" : "GET"),
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
    const text = await response.text();
    let body: unknown = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = { message: text.slice(0, 500) };
      }
    }
    lastStatus = response.status;
    lastBody = body;
    if (response.status !== 429 || attempt === maxAttempts) {
      return { status: response.status, body, requestId, attempts: attempt };
    }
    const retryAfter = Number(response.headers.get("retry-after"));
    const base =
      Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 400 * 2 ** (attempt - 1);
    const wait = Math.min(cap, base + jitter());
    await sleep(wait);
  }
  return { status: lastStatus, body: lastBody, requestId, attempts: maxAttempts };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  return null;
}

function numberAt(record: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  }
  return null;
}

export type ResolvedInstrument = {
  instrumentId: number;
  symbol: string;
  displayName: string;
};

export function parseInstrumentSearch(body: unknown, symbol: string): ResolvedInstrument | null {
  const wanted = symbol.toUpperCase().replace(/[^A-Z0-9]/g, "");
  const buckets: unknown[] = [];
  const root = asRecord(body);
  if (Array.isArray(body)) buckets.push(...body);
  if (root) {
    for (const key of ["items", "results", "instruments", "pageItems", "data"]) {
      const value = root[key];
      if (Array.isArray(value)) buckets.push(...value);
    }
  }
  for (const item of buckets) {
    const row = asRecord(item);
    if (!row) continue;
    const id = numberAt(row, ["instrumentId", "instrumentID", "InstrumentID", "id"]);
    if (id == null) continue;
    const raw = String(
      row.internalSymbolFull ?? row.symbol ?? row.SymbolFull ?? row.displayname ?? "",
    );
    const normalized = raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (normalized && normalized !== wanted && !normalized.includes(wanted)) continue;
    return {
      instrumentId: id,
      symbol: wanted,
      displayName: String(row.displayname ?? row.displayName ?? raw ?? wanted),
    };
  }
  return null;
}

export type EtoroPositionView = {
  positionId: string;
  instrumentId: number;
  isBuy: boolean;
  units: number;
  openRate: number | null;
  stopLoss: number | null;
  takeProfit: number | null;
  amount: number | null;
  leverage: number | null;
  pnl: number | null;
};

export type EtoroPortfolioView = {
  equity: number | null;
  credit: number | null;
  positions: EtoroPositionView[];
};

function collectPositionArrays(value: unknown, found: Record<string, unknown>[][], depth = 0): void {
  if (depth > 6 || value == null) return;
  if (Array.isArray(value)) {
    const rows = value.map(asRecord).filter((row): row is Record<string, unknown> => row != null);
    if (
      rows.length > 0 &&
      rows.some((row) => numberAt(row, ["instrumentId", "instrumentID", "InstrumentID"]) != null)
    ) {
      found.push(rows);
    }
    return;
  }
  const record = asRecord(value);
  if (!record) return;
  for (const nested of Object.values(record)) collectPositionArrays(nested, found, depth + 1);
}

function findLabeledNumber(value: unknown, keys: string[], depth = 0): number | null {
  if (depth > 6 || value == null) return null;
  const record = asRecord(value);
  if (!record) return null;
  const direct = numberAt(record, keys);
  if (direct != null) return direct;
  for (const nested of Object.values(record)) {
    const found = findLabeledNumber(nested, keys, depth + 1);
    if (found != null) return found;
  }
  return null;
}

export function parsePortfolio(body: unknown): EtoroPortfolioView {
  const arrays: Record<string, unknown>[][] = [];
  collectPositionArrays(body, arrays);
  const rows = arrays.sort((a, b) => b.length - a.length)[0] ?? [];
  const positions: EtoroPositionView[] = [];
  for (const row of rows) {
    const instrumentId = numberAt(row, ["instrumentId", "instrumentID", "InstrumentID"]);
    if (instrumentId == null) continue;
    const isBuyValue = row.isBuy ?? row.IsBuy;
    const positionId = row.positionID ?? row.positionId ?? row.PositionID ?? row.id;
    positions.push({
      positionId: positionId == null ? `${instrumentId}` : String(positionId),
      instrumentId,
      isBuy: isBuyValue !== false && isBuyValue !== 0 && isBuyValue !== "false",
      units: numberAt(row, ["units", "Units", "amountInUnits", "lotCount"]) ?? 0,
      openRate: numberAt(row, ["openRate", "OpenRate", "rate", "Rate"]),
      stopLoss: numberAt(row, ["stopLossRate", "StopLossRate"]),
      takeProfit: numberAt(row, ["takeProfitRate", "TakeProfitRate"]),
      amount: numberAt(row, ["amount", "Amount"]),
      leverage: numberAt(row, ["leverage", "Leverage"]),
      pnl: numberAt(row, ["pnl", "pnL", "unrealizedPnL", "profit"]),
    });
  }
  return {
    equity: findLabeledNumber(body, ["equity", "Equity", "accountEquity"]),
    credit: findLabeledNumber(body, ["credit", "Credit", "availableCash", "availableBalance"]),
    positions,
  };
}

export type RouteName = "paper" | "etoro-demo" | "etoro-real" | "blocked";

export function decideRoute(input: {
  venue: "paper" | "etoro";
  etoroMode: EtoroMode;
  keysConfigured: boolean;
  realMoneyConfirmed: boolean;
}): { route: RouteName; warning: string | null } {
  if (input.venue !== "etoro") {
    return {
      route: "paper",
      warning: input.keysConfigured
        ? "Keys are present, but TRADING_VENUE=paper keeps every fill on the local simulator."
        : null,
    };
  }
  if (!input.keysConfigured) {
    return {
      route: "paper",
      warning: "TRADING_VENUE=etoro but ETORO_API_KEY or ETORO_USER_KEY is empty. Staying on the local paper book.",
    };
  }
  if (input.etoroMode === "real" && !input.realMoneyConfirmed) {
    return {
      route: "blocked",
      warning:
        "ETORO_TRADING_MODE=real, and the desk has not been confirmed. Orders are refused. Nothing is sent, and nothing is simulated in their place.",
    };
  }
  if (input.etoroMode === "real") {
    return {
      route: "etoro-real",
      warning: "Real-money routing is on. eToro can fill these orders with cash in the live account.",
    };
  }
  return { route: "etoro-demo", warning: null };
}
