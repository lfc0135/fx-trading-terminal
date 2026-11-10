import type { BrokerAdapter, BrokerFill, BrokerOrderRequest } from "@/engine/broker";
import { instrument } from "@/engine/instruments";
import {
  buildCloseBody,
  buildOpenOrder,
  etoroPaths,
  etoroRequest,
  parseInstrumentSearch,
  parsePortfolio,
  searchQuery,
  type EtoroMode,
  type EtoroPortfolioView,
} from "@/engine/etoro";

function detail(body: unknown, fallback: string): string {
  if (body && typeof body === "object") {
    const record = body as Record<string, unknown>;
    for (const key of ["message", "errorMessage", "title", "detail"]) {
      const value = record[key];
      if (typeof value === "string" && value.trim()) return value.trim().slice(0, 300);
    }
  }
  return fallback;
}

function orderIdOf(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const record = body as Record<string, unknown>;
  const direct = record.orderId ?? record.orderID;
  if (typeof direct === "number" || typeof direct === "string") return String(direct);
  const nested = record.orderForClose;
  if (nested && typeof nested === "object") {
    const inner = nested as Record<string, unknown>;
    const id = inner.orderID ?? inner.orderId;
    if (typeof id === "number" || typeof id === "string") return String(id);
  }
  return null;
}

export class EtoroBroker implements BrokerAdapter {
  readonly id = "etoro";
  readonly displayName: string;

  constructor(
    private readonly opts: {
      mode: EtoroMode;
      baseUrl: string;
      apiKey: string;
      userKey: string;
      instrumentIds: Record<string, number>;
    },
  ) {
    this.displayName = opts.mode === "real" ? "eToro real" : "eToro demo";
  }

  private async call(path: string, method: string, body?: unknown) {
    return etoroRequest({
      baseUrl: this.opts.baseUrl,
      apiKey: this.opts.apiKey,
      userKey: this.opts.userKey,
      path,
      method,
      body,
      maxAttempts: 3,
      maxBackoffMs: 5_000,
    });
  }

  async resolveInstrumentId(symbol: string): Promise<number> {
    const cached = this.opts.instrumentIds[symbol];
    if (cached) return cached;
    const known = instrument(symbol);
    const terms = known?.searchTerms ?? [symbol];
    for (const term of terms) {
      const response = await this.call(searchQuery(term), "GET");
      if (response.status === 429) {
        throw new Error("eToro rate limit while resolving the instrument. Backed off and still limited.");
      }
      if (response.status >= 400) continue;
      const found = parseInstrumentSearch(response.body, symbol);
      if (found) {
        this.opts.instrumentIds[symbol] = found.instrumentId;
        return found.instrumentId;
      }
    }
    throw new Error(`No eToro instrument id for ${symbol}. Search terms tried: ${terms.join(", ")}.`);
  }

  async portfolio(): Promise<EtoroPortfolioView & { error: string | null }> {
    const response = await this.call(etoroPaths(this.opts.mode).portfolio, "GET");
    if (response.status === 429) {
      return { equity: null, credit: null, positions: [], error: "eToro rate limit on the portfolio read." };
    }
    if (response.status >= 400) {
      return {
        equity: null,
        credit: null,
        positions: [],
        error: `eToro portfolio ${response.status}: ${detail(response.body, "request failed")}`,
      };
    }
    return { ...parsePortfolio(response.body), error: null };
  }

  async placeOrder(request: BrokerOrderRequest): Promise<BrokerFill> {
    try {
      const instrumentId = request.instrumentId ?? (await this.resolveInstrumentId(request.symbol));
      const body = buildOpenOrder({
        instrumentId,
        side: request.side,
        orderType: request.type,
        units: request.units,
        limitPrice: request.limitPrice,
        stopLoss: request.stopLoss,
        takeProfit: request.takeProfit,
      });
      if (body.leverage !== 1) {
        return {
          broker: this.id,
          orderId: null,
          positionId: null,
          status: "rejected",
          message: "Refusing to send leverage other than 1.",
        };
      }
      const response = await this.call(etoroPaths(this.opts.mode).orders, "POST", body);
      if (response.status >= 400) {
        return {
          broker: this.id,
          orderId: null,
          positionId: null,
          status: "rejected",
          message: `eToro ${response.status}: ${detail(response.body, "order rejected")}`,
        };
      }
      return {
        broker: this.id,
        orderId: orderIdOf(response.body),
        positionId: null,
        status: "accepted",
        message:
          "eToro accepted the order for processing. A 200 is not a fill. Confirm it on the portfolio read.",
      };
    } catch (error) {
      return {
        broker: this.id,
        orderId: null,
        positionId: null,
        status: "rejected",
        message: error instanceof Error ? error.message : "eToro order failed",
      };
    }
  }

  async closePosition(positionId: string, instrumentId: number | null): Promise<BrokerFill> {
    if (instrumentId == null) {
      return {
        broker: this.id,
        orderId: null,
        positionId,
        status: "rejected",
        message: "Closing on eToro needs the instrument id.",
      };
    }
    const response = await this.call(
      etoroPaths(this.opts.mode).closePosition(positionId),
      "POST",
      buildCloseBody(instrumentId),
    );
    if (response.status >= 400) {
      return {
        broker: this.id,
        orderId: null,
        positionId,
        status: "rejected",
        message: `eToro close ${response.status}: ${detail(response.body, "close rejected")}`,
      };
    }
    return {
      broker: this.id,
      orderId: orderIdOf(response.body),
      positionId,
      status: "accepted",
      message: "Close order submitted to eToro.",
    };
  }

  async cancelOrder(orderId: string): Promise<BrokerFill> {
    const response = await this.call(etoroPaths(this.opts.mode).cancelOrder(orderId), "DELETE");
    if (response.status >= 400) {
      return {
        broker: this.id,
        orderId,
        positionId: null,
        status: "rejected",
        message: `eToro cancel ${response.status}: ${detail(response.body, "cancel rejected")}`,
      };
    }
    return {
      broker: this.id,
      orderId,
      positionId: null,
      status: "cancelled",
      message: "Cancel submitted to eToro.",
    };
  }
}
