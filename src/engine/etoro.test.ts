import { describe, expect, it } from "vitest";
import {
  buildCloseBody,
  buildOpenOrder,
  decideRoute,
  etoroPaths,
  etoroRequest,
  parseInstrumentSearch,
  parsePortfolio,
  searchQuery,
} from "./etoro";

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

describe("eToro adapter", () => {
  it("uses demo and real paths from the public API, including the real portfolio exception", () => {
    const demo = etoroPaths("demo");
    const real = etoroPaths("real");
    expect(demo.portfolio).toBe("/api/v1/trading/info/demo/portfolio");
    expect(demo.pnl).toBe("/api/v1/trading/info/demo/pnl");
    expect(demo.orders).toBe("/api/v2/trading/execution/demo/orders");
    expect(demo.closePosition("55")).toBe(
      "/api/v1/trading/execution/demo/market-close-orders/positions/55",
    );
    expect(real.portfolio).toBe("/api/v1/trading/info/portfolio");
    expect(real.pnl).toBe("/api/v1/trading/info/real/pnl");
    expect(real.orders).toBe("/api/v2/trading/execution/orders");
    expect(searchQuery("EURUSD")).toContain("internalSymbolFull=EURUSD");
  });

  it("always sends leverage 1 and uses sellShort for shorts", () => {
    const order = buildOpenOrder({
      instrumentId: 101,
      side: "short",
      orderType: "limit",
      units: 2500,
      limitPrice: 1.105,
      stopLoss: 1.112,
      takeProfit: 1.09,
    });
    expect(order.leverage).toBe(1);
    expect(order.transaction).toBe("sellShort");
    expect(order.orderType).toBe("mit");
    expect(order.triggerRate).toBe(1.105);
    expect(order.stopLossType).toBe("fixed");
    expect(order).not.toHaveProperty("symbol");
    expect(buildCloseBody(101)).toEqual({ InstrumentID: 101 });
  });

  it("sends both keys and reuses one request id while backing off on 429", async () => {
    const seen: { id: string; api: string; user: string }[] = [];
    let calls = 0;
    const sleeps: number[] = [];
    const result = await etoroRequest({
      baseUrl: "https://public-api.etoro.com",
      apiKey: "pub",
      userKey: "usr",
      path: "/api/v1/trading/info/demo/portfolio",
      method: "GET",
      jitter: () => 0,
      maxAttempts: 4,
      fetchImpl: async (_url, init) => {
        calls += 1;
        const headers = init?.headers as Record<string, string>;
        seen.push({
          id: headers["x-request-id"],
          api: headers["x-api-key"],
          user: headers["x-user-key"],
        });
        if (calls < 3) return jsonResponse(429, { message: "slow" }, { "retry-after": "1" });
        return jsonResponse(200, { credit: 1000 });
      },
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    expect(result.status).toBe(200);
    expect(result.attempts).toBe(3);
    expect(seen).toHaveLength(3);
    expect(new Set(seen.map((row) => row.id)).size).toBe(1);
    expect(seen[0].api).toBe("pub");
    expect(seen[0].user).toBe("usr");
    expect(sleeps).toEqual([1000, 1000]);
  });

  it("does not retry a normal error", async () => {
    let calls = 0;
    const result = await etoroRequest({
      baseUrl: "https://public-api.etoro.com",
      apiKey: "pub",
      userKey: "usr",
      path: "/api/v2/trading/execution/demo/orders",
      method: "POST",
      body: { leverage: 1 },
      fetchImpl: async () => {
        calls += 1;
        return jsonResponse(400, { message: "bad" });
      },
      sleep: async () => {
        throw new Error("should not sleep");
      },
    });
    expect(result.status).toBe(400);
    expect(calls).toBe(1);
  });

  it("parses an instrument search and a demo portfolio", () => {
    const found = parseInstrumentSearch(
      {
        items: [
          { instrumentId: 42, internalSymbolFull: "EUR/USD", displayname: "EUR/USD" },
        ],
      },
      "EURUSD",
    );
    expect(found?.instrumentId).toBe(42);
    const portfolio = parsePortfolio({
      clientPortfolio: {
        credit: 12500.5,
        equity: 13000,
        positions: [
          {
            positionID: 9,
            instrumentID: 42,
            isBuy: false,
            units: 1000,
            openRate: 1.1,
            stopLossRate: 1.12,
            takeProfitRate: 1.05,
            amount: 500,
            leverage: 1,
            pnl: -3.2,
          },
        ],
      },
    });
    expect(portfolio.equity).toBe(13000);
    expect(portfolio.credit).toBe(12500.5);
    expect(portfolio.positions[0]).toMatchObject({
      positionId: "9",
      instrumentId: 42,
      isBuy: false,
      units: 1000,
      openRate: 1.1,
      stopLoss: 1.12,
      pnl: -3.2,
    });
  });

  it("keeps real orders locked until the desk confirmation is on", () => {
    expect(
      decideRoute({
        venue: "paper",
        etoroMode: "demo",
        keysConfigured: false,
        realMoneyConfirmed: false,
      }).route,
    ).toBe("paper");
    expect(
      decideRoute({
        venue: "etoro",
        etoroMode: "demo",
        keysConfigured: false,
        realMoneyConfirmed: false,
      }).route,
    ).toBe("paper");
    expect(
      decideRoute({
        venue: "etoro",
        etoroMode: "demo",
        keysConfigured: true,
        realMoneyConfirmed: false,
      }).route,
    ).toBe("etoro-demo");
    expect(
      decideRoute({
        venue: "etoro",
        etoroMode: "real",
        keysConfigured: true,
        realMoneyConfirmed: false,
      }).route,
    ).toBe("blocked");
    expect(
      decideRoute({
        venue: "etoro",
        etoroMode: "real",
        keysConfigured: true,
        realMoneyConfirmed: true,
      }).route,
    ).toBe("etoro-real");
  });
});
