"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { BacktestPanel } from "@/components/desk/backtest-panel";
import { SettingsPanel } from "@/components/desk/settings-panel";
import { money, price, signedMoney, signedPct, tone } from "@/engine/format";
import { previewTicket } from "@/engine/preview";
import { formatDubai } from "@/engine/time";
import type { Side } from "@/engine/types";
import type { DeskSnapshot } from "@/engine/view";

const CandleChart = dynamic(() => import("@/components/desk/candle-chart").then((mod) => mod.CandleChart), {
  ssr: false,
  loading: () => <div className="h-[340px] animate-pulse rounded-md bg-muted/40 md:h-[420px]" />,
});

type Draft = {
  side: Side;
  type: "market" | "limit";
  units: string;
  sizeFromRisk: boolean;
  stop: string;
  take: string;
  limit: string;
};

const emptyDraft: Draft = {
  side: "long",
  type: "market",
  units: "",
  sizeFromRisk: true,
  stop: "",
  take: "",
  limit: "",
};

export function DeskApp() {
  const [snapshot, setSnapshot] = useState<DeskSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [symbol, setSymbol] = useState<string | null>(null);
  const [timeframe, setTimeframe] = useState<15 | 60>(15);
  const [tab, setTab] = useState("desk");
  const [banner, setBanner] = useState<string | null>(null);
  const [clock, setClock] = useState("");
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [orderError, setOrderError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const activeSymbol = symbol ?? snapshot?.chart.symbol ?? "EURUSD";

  const load = useCallback(async () => {
    try {
      const response = await fetch(`/api/desk?symbol=${encodeURIComponent(activeSymbol)}&timeframe=${timeframe}`, {
        cache: "no-store",
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "Desk failed to load.");
      setSnapshot(payload as DeskSnapshot);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Desk failed to load.");
    } finally {
      setLoading(false);
    }
  }, [activeSymbol, timeframe]);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 8000);
    return () => clearInterval(timer);
  }, [load]);

  useEffect(() => {
    const tick = () => setClock(formatDubai(new Date()));
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, []);

  async function post(url: string, body: unknown) {
    setSubmitting(true);
    setOrderError(null);
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = await response.json();
      if (!response.ok || payload.ok === false) {
        setOrderError(payload.error ?? "Order rejected.");
        return;
      }
      setBanner(payload.message);
      await load();
    } catch {
      setOrderError("The desk could not reach its own server.");
    } finally {
      setSubmitting(false);
    }
  }

  if (loading && !snapshot) {
    return (
      <main className="mx-auto flex min-h-screen max-w-3xl flex-col justify-center px-6">
        <p className="text-xs tracking-[0.22em] text-primary uppercase">Mina</p>
        <h1 className="mt-2 text-3xl font-medium">Reading the Dubai FX book</h1>
        <p className="mt-3 max-w-xl text-sm leading-6 text-muted-foreground">
          Pulling public prices and the local paper ledger. No eToro keys are required for this.
        </p>
      </main>
    );
  }

  if (!snapshot) {
    return (
      <main className="mx-auto flex min-h-screen max-w-xl flex-col justify-center px-6">
        <h1 className="text-2xl font-medium">The desk did not load</h1>
        <p className="mt-2 text-sm text-muted-foreground">{error}</p>
        <Button className="mt-4 w-fit" onClick={() => void load()}>
          Try again
        </Button>
      </main>
    );
  }

  const selected = snapshot.watchlist.find((row) => row.symbol === snapshot.chart.symbol) ?? snapshot.watchlist[0];

  return (
    <main className="mx-auto min-h-screen max-w-[1440px] px-3 py-3 md:px-5 md:py-4">
      <header className="flex flex-wrap items-end justify-between gap-3 border-b pb-3">
        <div>
          <div className="flex items-center gap-2">
            <span className="text-xs tracking-[0.22em] text-primary uppercase">Mina</span>
            <Badge variant="outline">FX · not crypto</Badge>
            <Badge variant={snapshot.route.name === "etoro-real" ? "destructive" : "secondary"}>
              {routeLabel(snapshot)}
            </Badge>
          </div>
          <h1 className="mt-1 text-2xl font-medium tracking-tight">Paper desk for Aayush</h1>
          <p className="text-sm text-muted-foreground">Asia/Dubai · spot majors and gold · 1:1 until the config says otherwise</p>
        </div>
        <div className="text-right">
          <div className="num text-lg">{clock || snapshot.dubaiLabel}</div>
          <div className="text-xs text-muted-foreground">
            {snapshot.marketOpen ? "FX week open" : "FX week closed"} ·{" "}
            {snapshot.sessions
              .filter((session) => session.open)
              .map((session) => session.name)
              .join(" · ") || "no cash session"}
          </div>
        </div>
      </header>

      <div className="mt-3 space-y-2">
        {error ? <Note tone="bad">{error}</Note> : null}
        {banner ? <Note>{banner}</Note> : null}
        {!snapshot.marketOpen ? (
          <Note>The FX week is closed from Friday 22:00 UTC to Sunday 22:00 UTC. New orders and stops wait for the reopen, Monday 02:00 in Dubai.</Note>
        ) : null}
        {snapshot.priceFeed !== "yahoo" ? (
          <Note>
            {snapshot.priceFeed === "recorded"
              ? "Public Yahoo prices are unavailable. The desk is marking a deterministic recorded path so paper mode still runs."
              : "Some symbols fell back to the recorded path. Live Yahoo prices are mixed in where they answered."}
          </Note>
        ) : null}
        {snapshot.route.warning ? <Note tone={snapshot.route.name === "etoro-real" ? "bad" : "plain"}>{snapshot.route.warning}</Note> : null}
        {snapshot.etoroError ? <Note tone="bad">{snapshot.etoroError}</Note> : null}
        {snapshot.kill.daily ? <Note tone="bad">Daily loss kill switch is on. New risk is blocked until the next Dubai day.</Note> : null}
        {snapshot.kill.drawdown ? <Note tone="bad">Drawdown kill switch is on. Reset it from Settings if you mean to trade again.</Note> : null}
      </div>

      <Tabs value={tab} onValueChange={setTab} className="mt-4">
        <TabsList>
          <TabsTrigger value="desk">Desk</TabsTrigger>
          <TabsTrigger value="backtest">Backtest</TabsTrigger>
          <TabsTrigger value="tape">Trade log</TabsTrigger>
          <TabsTrigger value="settings">Risk</TabsTrigger>
        </TabsList>

        <TabsContent value="desk" className="mt-3 space-y-3">
          <section className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border bg-border md:grid-cols-3 xl:grid-cols-6">
            <Stat label="Equity" value={money(snapshot.account.equity)} detail={snapshot.account.source === "etoro" ? "eToro" : "local paper"} />
            <Stat label="Day P&L" value={signedMoney(snapshot.account.dayPnl)} detail={signedPct(snapshot.account.dayPnlPct)} tone={tone(snapshot.account.dayPnl)} />
            <Stat label="Drawdown" value={signedPct(snapshot.account.drawdownPct)} detail={`kill ${signedPct(snapshot.kill.maxDrawdownKillPct, 0)}`} tone="down" />
            <Stat
              label="Day vs 2–3%"
              value={bandLabel(snapshot.account.dayBand)}
              detail={signedPct(snapshot.account.dayPnlPct)}
              tone={snapshot.account.dayBand === "below" ? "down" : "up"}
            />
            <Stat
              label="Month"
              value={signedPct(snapshot.account.monthPnlPct)}
              detail={`${snapshot.account.monthTradingDays} Dubai weekdays`}
              tone={tone(snapshot.account.monthPnlPct)}
            />
            <Stat
              label="Exposure"
              value={money(snapshot.account.exposureUsd)}
              detail={`cap ${money(snapshot.account.exposureCapUsd)}`}
            />
          </section>

          <p className="text-sm leading-6 text-muted-foreground">
            The 2–3% day is a benchmark this desk measures, not a rate it promises. If every weekday so far this month had
            made 2%, the book would be {signedPct(snapshot.account.monthIfLow)}. At 3% a day it would be{" "}
            {signedPct(snapshot.account.monthIfHigh)}. Actual month-to-date is {signedPct(snapshot.account.monthPnlPct)}. A 2%
            day, compounded, is a different business from unlevered spot FX.
          </p>

          <div className="grid gap-3 lg:grid-cols-12">
            <section className="rounded-lg border bg-card lg:col-span-3">
              <div className="flex items-center justify-between px-3 py-2">
                <h2 className="text-sm font-medium">Watchlist</h2>
                <span className="text-[11px] text-muted-foreground">vol × momentum</span>
              </div>
              <Separator />
              <ScrollArea className="h-[280px] lg:h-[460px]">
                <ul>
                  {snapshot.watchlist.map((row) => (
                    <li key={row.symbol}>
                      <button
                        type="button"
                        onClick={() => setSymbol(row.symbol)}
                        className={`flex w-full items-center justify-between gap-2 px-3 py-2 text-left hover:bg-muted/60 ${
                          row.symbol === snapshot.chart.symbol ? "bg-muted" : ""
                        }`}
                      >
                        <span>
                          <span className="num text-[11px] text-muted-foreground">{row.rank}</span>{" "}
                          <span className="num text-sm">{row.symbol}</span>
                          <span className={`num ml-2 text-sm ${tone(row.changePct)}`}>{price(row.mid, row.decimals)}</span>
                        </span>
                        <span className={`num text-xs ${tone(row.changePct)}`}>{signedPct(row.changePct)}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </ScrollArea>
            </section>

            <section className="rounded-lg border bg-card p-3 lg:col-span-6">
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h2 className="text-sm font-medium">
                    {snapshot.chart.symbol} <span className="font-normal text-muted-foreground">{snapshot.chart.name}</span>
                  </h2>
                  <p className="text-xs text-muted-foreground">
                    {snapshot.chart.source === "yahoo" ? "Yahoo public candles" : "Recorded path"} · times in Asia/Dubai
                    {snapshot.chart.proxy ? " · gold uses the GC=F future as a public stand-in for XAUUSD" : ""}
                  </p>
                </div>
                <div className="flex gap-1">
                  <Button type="button" size="sm" variant={timeframe === 15 ? "default" : "outline"} onClick={() => setTimeframe(15)}>
                    15m
                  </Button>
                  <Button type="button" size="sm" variant={timeframe === 60 ? "default" : "outline"} onClick={() => setTimeframe(60)}>
                    1h
                  </Button>
                </div>
              </div>
              {snapshot.chart.candles.length > 1 ? (
                <CandleChart candles={snapshot.chart.candles} decimals={snapshot.chart.decimals} />
              ) : (
                <p className="py-16 text-center text-sm text-muted-foreground">No candles for this symbol yet.</p>
              )}
              <div className="mt-3">
                <Spark points={snapshot.equityCurve.map((point) => point.equity)} />
                <p className="mt-1 text-[11px] text-muted-foreground">Paper equity, marked when the desk refreshes.</p>
              </div>
            </section>

            <Ticket
              snapshot={snapshot}
              quote={selected}
              draft={draft}
              setDraft={setDraft}
              submitting={submitting}
              orderError={orderError}
              onSubmit={(body) => void post("/api/orders", body)}
              onStage={(signal) => {
                if (signal.action !== "enter" || !signal.side || signal.stopLoss == null) return;
                setDraft({
                  side: signal.side,
                  type: "market",
                  units: "",
                  sizeFromRisk: true,
                  stop: String(signal.stopLoss),
                  take: signal.takeProfit == null ? "" : String(signal.takeProfit),
                  limit: "",
                });
                setOrderError(null);
              }}
            />
          </div>

          <section className="overflow-x-auto rounded-lg border">
            <div className="px-3 py-2 text-sm font-medium">Open positions</div>
            <table className="w-full min-w-[760px] text-left text-sm">
              <thead className="text-[11px] tracking-wide text-muted-foreground uppercase">
                <tr>
                  <th className="px-3 py-2 font-medium">Symbol</th>
                  <th className="px-3 py-2 font-medium">Side</th>
                  <th className="px-3 py-2 font-medium">Units</th>
                  <th className="px-3 py-2 font-medium">Entry</th>
                  <th className="px-3 py-2 font-medium">Mark</th>
                  <th className="px-3 py-2 font-medium">P&L</th>
                  <th className="px-3 py-2 font-medium">Stop</th>
                  <th className="px-3 py-2 font-medium">Target</th>
                  <th className="px-3 py-2 font-medium"></th>
                </tr>
              </thead>
              <tbody>
                {snapshot.positions.length === 0 ? (
                  <tr>
                    <td colSpan={9} className="px-3 py-6 text-muted-foreground">
                      Flat. No open risk.
                    </td>
                  </tr>
                ) : (
                  snapshot.positions.map((position) => (
                    <tr key={position.id} className="border-t">
                      <td className="num px-3 py-2">{position.symbol}</td>
                      <td className="px-3 py-2">{position.side}</td>
                      <td className="num px-3 py-2">{position.units.toLocaleString("en-US")}</td>
                      <td className="num px-3 py-2">{price(position.entryPrice, position.decimals)}</td>
                      <td className="num px-3 py-2">{price(position.mark, position.decimals)}</td>
                      <td className={`num px-3 py-2 ${tone(position.unrealizedPnl)}`}>{signedMoney(position.unrealizedPnl)}</td>
                      <td className="num px-3 py-2">{position.stopLoss == null ? "—" : price(position.stopLoss, position.decimals)}</td>
                      <td className="num px-3 py-2">{position.takeProfit == null ? "—" : price(position.takeProfit, position.decimals)}</td>
                      <td className="px-3 py-2 text-right">
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={submitting}
                          onClick={() =>
                            void post("/api/positions/close", { id: position.id, instrumentId: position.instrumentId })
                          }
                        >
                          Close
                        </Button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </section>

          {snapshot.orders.length > 0 ? (
            <section className="overflow-x-auto rounded-lg border">
              <div className="px-3 py-2 text-sm font-medium">Working limits</div>
              <ul>
                {snapshot.orders.map((order) => (
                  <li key={order.id} className="flex items-center justify-between gap-3 border-t px-3 py-2 text-sm">
                    <span className="num">
                      {order.side} {order.units.toLocaleString("en-US")} {order.symbol} @ {price(order.limitPrice, order.decimals)}
                    </span>
                    <Button size="sm" variant="ghost" onClick={() => void post("/api/orders/cancel", { id: order.id })}>
                      Cancel
                    </Button>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </TabsContent>

        <TabsContent value="backtest" className="mt-3">
          <BacktestPanel
            symbols={snapshot.settings.watchlist}
            strategies={snapshot.strategies}
          />
        </TabsContent>

        <TabsContent value="tape" className="mt-3">
          <TradeTable trades={snapshot.trades} />
        </TabsContent>

        <TabsContent value="settings" className="mt-3">
          <SettingsPanel
            snapshot={snapshot}
            onChanged={(message) => {
              setBanner(message);
              void load();
            }}
          />
        </TabsContent>
      </Tabs>
    </main>
  );
}

function Ticket({
  snapshot,
  quote,
  draft,
  setDraft,
  submitting,
  orderError,
  onSubmit,
  onStage,
}: {
  snapshot: DeskSnapshot;
  quote: DeskSnapshot["watchlist"][number] | undefined;
  draft: Draft;
  setDraft: (draft: Draft) => void;
  submitting: boolean;
  orderError: string | null;
  onSubmit: (body: unknown) => void;
  onStage: (signal: DeskSnapshot["signals"][number]) => void;
}) {
  const preview = useMemo(() => {
    if (!quote) return null;
    return previewTicket({
      equity: snapshot.account.equity,
      cash: snapshot.account.cash,
      dayStartEquity: snapshot.account.equity - snapshot.account.dayPnl,
      peakEquity: snapshot.account.peakEquity,
      openNotionalUsd: snapshot.account.exposureUsd,
      kill: { daily: snapshot.kill.daily, drawdown: snapshot.kill.drawdown },
      settings: snapshot.settings,
      leverageCap: snapshot.route.leverageCap,
      symbol: quote.symbol,
      side: draft.side,
      type: draft.type,
      units: draft.units === "" ? null : Number(draft.units),
      sizeFromRisk: draft.sizeFromRisk,
      mid: quote.mid,
      stopLoss: draft.stop === "" ? null : Number(draft.stop),
      takeProfit: draft.take === "" ? null : Number(draft.take),
      limitPrice: draft.limit === "" ? null : Number(draft.limit),
      now: new Date(snapshot.now),
    });
  }, [snapshot, quote, draft]);

  return (
    <section className="space-y-3 rounded-lg border bg-card p-3 lg:col-span-3">
      <h2 className="text-sm font-medium">Order</h2>
      <div className="grid grid-cols-2 gap-2">
        <Button type="button" variant={draft.side === "long" ? "default" : "outline"} onClick={() => setDraft({ ...draft, side: "long" })}>
          Buy
        </Button>
        <Button type="button" variant={draft.side === "short" ? "destructive" : "outline"} onClick={() => setDraft({ ...draft, side: "short" })}>
          Sell
        </Button>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <Button type="button" size="sm" variant={draft.type === "market" ? "secondary" : "outline"} onClick={() => setDraft({ ...draft, type: "market" })}>
          Market
        </Button>
        <Button type="button" size="sm" variant={draft.type === "limit" ? "secondary" : "outline"} onClick={() => setDraft({ ...draft, type: "limit" })}>
          Limit
        </Button>
      </div>
      <label className="flex items-center justify-between gap-3 text-sm">
        <span>Size from {signedPct(snapshot.settings.perTradeRiskPct, 2)} risk</span>
        <Switch checked={draft.sizeFromRisk} onCheckedChange={(checked) => setDraft({ ...draft, sizeFromRisk: Boolean(checked) })} />
      </label>
      {!draft.sizeFromRisk ? (
        <Field label="Units" value={draft.units} onChange={(units) => setDraft({ ...draft, units })} />
      ) : null}
      {draft.type === "limit" ? (
        <Field label="Limit price" value={draft.limit} onChange={(limit) => setDraft({ ...draft, limit })} />
      ) : null}
      <Field label="Stop-loss" value={draft.stop} onChange={(stop) => setDraft({ ...draft, stop })} />
      <Field label="Take-profit" value={draft.take} onChange={(take) => setDraft({ ...draft, take })} />
      {quote ? (
        <p className="num text-xs text-muted-foreground">
          Bid {price(quote.bid, quote.decimals)} · Ask {price(quote.ask, quote.decimals)}
        </p>
      ) : null}
      {preview ? (
        <p className="text-xs leading-5 text-muted-foreground">
          {preview.allowed
            ? `${preview.units.toLocaleString("en-US")} units · risk ${money(preview.riskUsd)} of ${money(preview.riskBudgetUsd)} · notional ${money(preview.notionalUsd)}${preview.cappedBy.length ? ` · capped by ${preview.cappedBy.join(", ")}` : ""}`
            : preview.reasons[0] ?? "The risk engine will reject this."}
        </p>
      ) : null}
      {orderError ? <p className="text-sm text-destructive">{orderError}</p> : null}
      <Button
        className="w-full"
        disabled={submitting || snapshot.route.name === "blocked"}
        onClick={() =>
          onSubmit({
            symbol: quote?.symbol ?? snapshot.chart.symbol,
            side: draft.side,
            type: draft.type,
            units: draft.units === "" ? null : Number(draft.units),
            sizeFromRisk: draft.sizeFromRisk,
            limitPrice: draft.limit === "" ? null : Number(draft.limit),
            stopLoss: draft.stop === "" ? null : Number(draft.stop),
            takeProfit: draft.take === "" ? null : Number(draft.take),
          })
        }
      >
        {submitting ? "Sending…" : snapshot.route.name === "paper" ? "Send paper order" : "Send to eToro"}
      </Button>
      <Separator />
      <div className="space-y-2">
        <h3 className="text-sm font-medium">Signals</h3>
        {snapshot.signals.map((signal) => (
          <div key={signal.id} className="rounded-md border px-2 py-2">
            <div className="text-xs font-medium">{signal.name}</div>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">{signal.text}</p>
            {signal.action === "enter" ? (
              <Button className="mt-2" size="sm" variant="outline" type="button" onClick={() => onStage(signal)}>
                Stage as paper order
              </Button>
            ) : null}
          </div>
        ))}
        <p className="text-[11px] leading-5 text-muted-foreground">
          Signals do not send themselves. Staging fills the ticket. The server still runs the risk checks.
        </p>
      </div>
    </section>
  );
}

function Field({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  const id = label.replace(/\s+/g, "-").toLowerCase();
  return (
    <div>
      <Label htmlFor={id}>{label}</Label>
      <Input id={id} className="mt-1" value={value} inputMode="decimal" onChange={(event) => onChange(event.target.value)} />
    </div>
  );
}

function Stat({
  label,
  value,
  detail,
  tone: color = "flat",
}: {
  label: string;
  value: string;
  detail?: string;
  tone?: "up" | "down" | "flat";
}) {
  return (
    <div className="bg-card px-3 py-3">
      <div className="text-[11px] tracking-wide text-muted-foreground uppercase">{label}</div>
      <div className={`num mt-1 text-lg ${color}`}>{value}</div>
      {detail ? <div className="num text-xs text-muted-foreground">{detail}</div> : null}
    </div>
  );
}

function Note({ children, tone: color = "plain" }: { children: React.ReactNode; tone?: "plain" | "bad" }) {
  return (
    <p className={`rounded-lg border px-3 py-2 text-sm leading-6 ${color === "bad" ? "border-destructive/40 bg-destructive/10 text-destructive" : "bg-card text-muted-foreground"}`}>
      {children}
    </p>
  );
}

function Spark({ points }: { points: number[] }) {
  if (points.length < 2) return null;
  const min = Math.min(...points);
  const max = Math.max(...points);
  const width = 560;
  const height = 56;
  const path = points
    .map((value, index) => {
      const x = (index / (points.length - 1)) * width;
      const y = max === min ? height / 2 : height - ((value - min) / (max - min)) * (height - 8) - 4;
      return `${index === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  const up = points[points.length - 1] >= points[0];
  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="h-14 w-full">
      <path d={path} fill="none" stroke={up ? "#3cbe86" : "#e36d64"} strokeWidth="1.6" />
    </svg>
  );
}

function TradeTable({ trades }: { trades: DeskSnapshot["trades"] }) {
  return (
    <div className="overflow-x-auto rounded-lg border">
      <table className="w-full min-w-[860px] text-left text-sm">
        <thead className="bg-muted/50 text-[11px] tracking-wide text-muted-foreground uppercase">
          <tr>
            <th className="px-3 py-2 font-medium">Closed</th>
            <th className="px-3 py-2 font-medium">Symbol</th>
            <th className="px-3 py-2 font-medium">Side</th>
            <th className="px-3 py-2 font-medium">Entry</th>
            <th className="px-3 py-2 font-medium">Exit</th>
            <th className="px-3 py-2 font-medium">P&L</th>
            <th className="px-3 py-2 font-medium">Reason</th>
          </tr>
        </thead>
        <tbody>
          {trades.length === 0 ? (
            <tr>
              <td colSpan={7} className="px-3 py-6 text-muted-foreground">
                No fills yet. A paper order, or a stop on a position you open, shows up here. Backtests keep their own log.
              </td>
            </tr>
          ) : (
            trades.map((trade) => (
              <tr key={trade.id} className="border-t">
                <td className="num px-3 py-2">
                  {new Intl.DateTimeFormat("en-GB", {
                    timeZone: "Asia/Dubai",
                    month: "short",
                    day: "2-digit",
                    hour: "2-digit",
                    minute: "2-digit",
                    hourCycle: "h23",
                  }).format(new Date(trade.closedAt * 1000))}
                </td>
                <td className="num px-3 py-2">{trade.symbol}</td>
                <td className="px-3 py-2">{trade.side}</td>
                <td className="num px-3 py-2">{trade.entryPrice}</td>
                <td className="num px-3 py-2">{trade.exitPrice}</td>
                <td className={`num px-3 py-2 ${tone(trade.pnlUsd)}`}>{signedMoney(trade.pnlUsd)}</td>
                <td className="px-3 py-2">{trade.reason}</td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

function routeLabel(snapshot: DeskSnapshot): string {
  if (snapshot.route.name === "etoro-real") return "eToro real";
  if (snapshot.route.name === "etoro-demo") return "eToro demo";
  if (snapshot.route.name === "blocked") return "Real locked";
  return "Local paper · $50k";
}

function bandLabel(band: DeskSnapshot["account"]["dayBand"]): string {
  if (band === "inside") return "Inside band";
  if (band === "above") return "Above 3%";
  return "Below 2%";
}
