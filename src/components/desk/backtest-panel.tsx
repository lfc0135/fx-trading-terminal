"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { money, signedMoney, signedPct, tone } from "@/engine/format";
import type { BacktestResult } from "@/engine/backtest";

const field =
  "h-8 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50";

export function BacktestPanel({
  symbols,
  strategies,
}: {
  symbols: string[];
  strategies: { id: string; name: string; description: string }[];
}) {
  const [symbol, setSymbol] = useState(symbols.includes("EURUSD") ? "EURUSD" : symbols[0]);
  const [strategy, setStrategy] = useState("momentum");
  const [source, setSource] = useState<"recorded" | "live">("recorded");
  const [timeframe, setTimeframe] = useState<15 | 60>(15);
  const [result, setResult] = useState<BacktestResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  async function run(next?: { symbol: string; strategy: string; source: "recorded" | "live"; timeframe: 15 | 60 }) {
    const body = next ?? { symbol, strategy, source, timeframe };
    setRunning(true);
    setError(null);
    try {
      const response = await fetch("/api/backtest", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          symbol: body.symbol,
          strategy: body.strategy,
          source: body.source,
          timeframeMinutes: body.timeframe,
          bars: 800,
        }),
      });
      const payload = await response.json();
      if (!response.ok) {
        setResult(null);
        setError(payload.error ?? "Backtest failed.");
      } else {
        setResult(payload as BacktestResult);
      }
    } catch {
      setError("Backtest request failed.");
    } finally {
      setRunning(false);
    }
  }

  useEffect(() => {
    void run({ symbol: "EURUSD", strategy: "momentum", source: "recorded", timeframe: 15 });
    // The sample is deterministic. Run it once so the page is not an empty form.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const selected = strategies.find((item) => item.id === strategy);

  return (
    <div className="grid gap-4 lg:grid-cols-[280px_1fr]">
      <form
        className="space-y-3 rounded-lg border bg-card p-3"
        onSubmit={(event) => {
          event.preventDefault();
          void run();
        }}
      >
        <div>
          <Label htmlFor="bt-symbol">Symbol</Label>
          <select id="bt-symbol" className={`${field} mt-1`} value={symbol} onChange={(event) => setSymbol(event.target.value)}>
            {symbols.map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </select>
        </div>
        <div>
          <Label htmlFor="bt-strategy">Strategy</Label>
          <select id="bt-strategy" className={`${field} mt-1`} value={strategy} onChange={(event) => setStrategy(event.target.value)}>
            {strategies.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <Label htmlFor="bt-source">Price history</Label>
          <select
            id="bt-source"
            className={`${field} mt-1`}
            value={source}
            onChange={(event) => setSource(event.target.value as "recorded" | "live")}
          >
            <option value="recorded">Recorded sample (no network)</option>
            <option value="live">Public history, Yahoo if reachable</option>
          </select>
        </div>
        <div>
          <Label htmlFor="bt-tf">Bar size</Label>
          <select
            id="bt-tf"
            className={`${field} mt-1`}
            value={timeframe}
            onChange={(event) => setTimeframe(Number(event.target.value) === 60 ? 60 : 15)}
          >
            <option value={15}>15 minutes</option>
            <option value={60}>1 hour</option>
          </select>
        </div>
        <Button type="submit" disabled={running} className="w-full">
          {running ? "Running…" : "Run backtest"}
        </Button>
        {selected ? <p className="text-xs leading-5 text-muted-foreground">{selected.description}</p> : null}
      </form>

      <div className="space-y-3">
        {error ? <p className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">{error}</p> : null}
        {!result && !error ? <p className="text-sm text-muted-foreground">Running the recorded EURUSD momentum sample…</p> : null}
        {result ? <BacktestResultView result={result} /> : null}
      </div>
    </div>
  );
}

function BacktestResultView({ result }: { result: BacktestResult }) {
  const stats = [
    ["Return", signedPct(result.totalReturn), tone(result.totalReturn)],
    ["Max drawdown", signedPct(-result.maxDrawdown), "down"],
    ["Sharpe", result.sharpe == null ? "—" : result.sharpe.toFixed(2), result.sharpe != null && result.sharpe >= 0 ? "up" : "down"],
    ["Win rate", result.winRate == null ? "—" : signedPct(result.winRate, 1), "flat"],
    ["Trades", String(result.trades), "flat"],
    ["Ending equity", money(result.endingEquity), tone(result.endingEquity - result.startingEquity)],
  ] as const;
  const hit = result.dailyTarget;
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border bg-border md:grid-cols-3">
        {stats.map(([label, value, color]) => (
          <div key={label} className="bg-card p-3">
            <div className="text-[11px] tracking-wide text-muted-foreground uppercase">{label}</div>
            <div className={`num mt-1 text-lg ${color}`}>{value}</div>
          </div>
        ))}
      </div>
      <div className="rounded-lg border bg-card p-3">
        <div className="flex flex-wrap items-end justify-between gap-2">
          <div>
            <div className="text-[11px] tracking-wide text-muted-foreground uppercase">Daily target hit rate</div>
            <div className="num mt-1 text-lg">
              {hit.lowHitRate == null ? "—" : signedPct(hit.lowHitRate, 1)} at 2%
              <span className="ml-3 text-base text-muted-foreground">
                {hit.highHitRate == null ? "—" : signedPct(hit.highHitRate, 1)} at 3%
              </span>
            </div>
          </div>
          <div className="text-xs text-muted-foreground">
            {hit.daysAtOrAboveLow} of {hit.days} Dubai sessions cleared 2%. {hit.daysAtOrAboveHigh} cleared 3%.
          </div>
        </div>
        <p className="mt-3 text-sm leading-6 text-muted-foreground">{result.note}</p>
        <p className="mt-2 text-xs text-muted-foreground">
          {result.strategyName} · {result.symbol} · {result.timeframeMinutes}m · source {result.source} · average trade{" "}
          {result.averagePnl == null ? "—" : signedMoney(result.averagePnl)} · profit factor{" "}
          {result.profitFactor == null ? "—" : result.profitFactor.toFixed(2)}
        </p>
      </div>
      <div className="rounded-lg border bg-card p-3">
        <div className="mb-2 text-[11px] tracking-wide text-muted-foreground uppercase">Equity</div>
        <Spark points={result.equityCurve.map((point) => point.equity)} />
      </div>
      <div className="overflow-x-auto rounded-lg border">
        <table className="w-full min-w-[640px] text-left text-sm">
          <thead className="bg-muted/60 text-[11px] tracking-wide text-muted-foreground uppercase">
            <tr>
              <th className="px-3 py-2 font-medium">Dubai day</th>
              <th className="px-3 py-2 font-medium">Return</th>
              <th className="px-3 py-2 font-medium">2% band</th>
              <th className="px-3 py-2 font-medium">3% line</th>
            </tr>
          </thead>
          <tbody>
            {hit.returns.length === 0 ? (
              <tr>
                <td colSpan={4} className="px-3 py-4 text-muted-foreground">
                  No sessions in this sample.
                </td>
              </tr>
            ) : (
              hit.returns.map((row) => (
                <tr key={row.day} className="border-t">
                  <td className="num px-3 py-2">{row.day}</td>
                  <td className={`num px-3 py-2 ${tone(row.ret)}`}>{signedPct(row.ret)}</td>
                  <td className="px-3 py-2">{row.hitLow ? "Hit" : "Miss"}</td>
                  <td className="px-3 py-2">{row.hitHigh ? "Hit" : "Miss"}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      {result.skips.length > 0 ? (
        <p className="text-xs text-muted-foreground">
          Skipped signals: {result.skips.map((skip) => `${skip.count}× ${skip.reason}`).join(" · ")}
        </p>
      ) : null}
    </div>
  );
}

function Spark({ points }: { points: number[] }) {
  if (points.length < 2) return <p className="text-sm text-muted-foreground">Not enough equity points.</p>;
  const min = Math.min(...points);
  const max = Math.max(...points);
  const width = 640;
  const height = 120;
  const path = points
    .map((value, index) => {
      const x = (index / (points.length - 1)) * width;
      const y = max === min ? height / 2 : height - ((value - min) / (max - min)) * (height - 8) - 4;
      return `${index === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  const up = points[points.length - 1] >= points[0];
  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="h-28 w-full">
      <path d={path} fill="none" stroke={up ? "#3cbe86" : "#e36d64"} strokeWidth="2" />
    </svg>
  );
}
