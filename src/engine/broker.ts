import type { Side } from "./types";

/**
 * Pluggable broker. The desk ships two adapters:
 * - paper: local simulator, the default when keys are absent
 * - etoro: eToro public API (demo or real)
 *
 * A new venue implements this interface and is selected from TRADING_VENUE.
 * OANDA is not bundled. Add it as another adapter; do not special-case eToro
 * call sites.
 */
export type BrokerOrderRequest = {
  symbol: string;
  side: Side;
  type: "market" | "limit";
  units: number;
  limitPrice: number | null;
  stopLoss: number | null;
  takeProfit: number | null;
  instrumentId?: number | null;
};

export type BrokerFill = {
  broker: string;
  orderId: string | null;
  positionId: string | null;
  status: "filled" | "accepted" | "rejected" | "cancelled";
  message: string;
};

export interface BrokerAdapter {
  readonly id: string;
  readonly displayName: string;
  placeOrder(request: BrokerOrderRequest): Promise<BrokerFill>;
  closePosition(positionId: string, instrumentId: number | null): Promise<BrokerFill>;
  cancelOrder(orderId: string): Promise<BrokerFill>;
}
