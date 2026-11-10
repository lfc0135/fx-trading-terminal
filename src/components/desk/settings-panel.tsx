"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { INSTRUMENTS, UNIVERSE } from "@/engine/instruments";
import type { DeskSnapshot } from "@/engine/view";

export function SettingsPanel({
  snapshot,
  onChanged,
}: {
  snapshot: DeskSnapshot;
  onChanged: (message: string) => void;
}) {
  const settings = snapshot.settings;
  const [risk, setRisk] = useState(String(settings.perTradeRiskPct * 100));
  const [position, setPosition] = useState(String(settings.maxPositionNotionalPct * 100));
  const [daily, setDaily] = useState(String(settings.dailyLossKillPct * 100));
  const [drawdown, setDrawdown] = useState(String(settings.maxDrawdownKillPct * 100));
  const [stop, setStop] = useState(String(settings.minStopPips));
  const [watchlist, setWatchlist] = useState(settings.watchlist);
  const [error, setError] = useState<string | null>(null);
  const [realOpen, setRealOpen] = useState(false);
  const [resetOpen, setResetOpen] = useState(false);
  const [ddOpen, setDdOpen] = useState(false);
  const [phrase, setPhrase] = useState("");

  function toggle(symbol: string) {
    setWatchlist((current) => {
      if (current.includes(symbol)) return current.filter((item) => item !== symbol);
      return [...current, symbol];
    });
  }

  async function save() {
    setError(null);
    const response = await fetch("/api/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        perTradeRiskPct: Number(risk) / 100,
        maxPositionNotionalPct: Number(position) / 100,
        dailyLossKillPct: Number(daily) / 100,
        maxDrawdownKillPct: Number(drawdown) / 100,
        minStopPips: Number(stop),
        watchlist,
      }),
    });
    const payload = await response.json();
    if (!response.ok || payload.ok === false) {
      setError(payload.error ?? "Could not save settings.");
      return;
    }
    onChanged(payload.message);
  }

  async function post(url: string, body: unknown) {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const payload = await response.json();
    if (!response.ok || payload.ok === false) {
      setError(payload.error ?? "Request failed.");
      return;
    }
    setPhrase("");
    setRealOpen(false);
    setResetOpen(false);
    setDdOpen(false);
    onChanged(payload.message);
  }

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <section className="space-y-3 rounded-lg border bg-card p-4">
        <h2 className="text-base font-medium">Risk limits</h2>
        <p className="text-sm leading-6 text-muted-foreground">
          These are enforced on the server before a paper fill or an eToro order. The exposure cap is{" "}
          <span className="num">{snapshot.route.leverageCap.toFixed(0)}×</span> equity, from <span className="num">LEVERAGE_CAP</span>,
          and it cannot be set above 2×. Paper sizing and eToro order payloads both use that number. The stop, the 0.5%
          per-trade risk budget, and both kill switches are unchanged.
        </p>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Per-trade risk %" value={risk} onChange={setRisk} />
          <Field label="Max position %" value={position} onChange={setPosition} />
          <Field label="Daily loss kill %" value={daily} onChange={setDaily} />
          <Field label="Max drawdown kill %" value={drawdown} onChange={setDrawdown} />
          <Field label="Minimum stop, pips" value={stop} onChange={setStop} />
        </div>
        <div>
          <div className="mb-2 text-sm font-medium">Watchlist</div>
          <div className="grid grid-cols-2 gap-2">
            {UNIVERSE.map((symbol) => (
              <label key={symbol} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={watchlist.includes(symbol)}
                  onChange={() => toggle(symbol)}
                />
                <span className="num">{symbol}</span>
                <span className="text-muted-foreground">{INSTRUMENTS[symbol].name}</span>
              </label>
            ))}
          </div>
        </div>
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
        <Button type="button" onClick={() => void save()}>
          Save limits
        </Button>
      </section>

      <section className="space-y-4 rounded-lg border bg-card p-4">
        <h2 className="text-base font-medium">Broker</h2>
        <dl className="space-y-2 text-sm">
          <Row term="Venue" value={snapshot.route.venue === "etoro" ? "eToro" : "Local paper"} />
          <Row term="eToro mode" value={snapshot.route.etoroMode} />
          <Row term="Keys" value={snapshot.route.keysConfigured ? "Present in the environment" : "Not set"} />
          <Row term="Real confirmation" value={snapshot.route.realMoneyConfirmed ? "Armed" : "Off"} />
          <Row term="Paper starting balance" value={`$${snapshot.route.startingBalance.toLocaleString("en-US")}`} />
        </dl>
        <p className="text-sm leading-6 text-muted-foreground">
          Real money needs both <span className="num">ETORO_TRADING_MODE=real</span> and the confirmation below. Until then
          the desk either simulates locally or, with demo keys, talks only to eToro demo.
        </p>
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="destructive" onClick={() => { setPhrase(""); setRealOpen(true); }}>
            {snapshot.route.realMoneyConfirmed ? "Real money is armed" : "Arm real money"}
          </Button>
          {snapshot.route.realMoneyConfirmed ? (
            <Button type="button" variant="outline" onClick={() => void post("/api/settings/real", { disarm: true })}>
              Disarm
            </Button>
          ) : null}
          <Button type="button" variant="outline" onClick={() => { setPhrase(""); setDdOpen(true); }}>
            Reset drawdown kill
          </Button>
          <Button type="button" variant="outline" onClick={() => { setPhrase(""); setResetOpen(true); }}>
            Reset paper book
          </Button>
        </div>
      </section>

      <PhraseDialog
        open={realOpen}
        onOpenChange={setRealOpen}
        title="Arm real-money routing"
        description="This does not by itself switch the server. TRADING_VENUE must be etoro and ETORO_TRADING_MODE must be real. Type ENABLE REAL MONEY."
        phrase={phrase}
        setPhrase={setPhrase}
        expected="ENABLE REAL MONEY"
        confirmLabel="Arm live routing"
        onConfirm={() => void post("/api/settings/real", { phrase })}
      />
      <PhraseDialog
        open={resetOpen}
        onOpenChange={setResetOpen}
        title="Reset the paper book"
        description="Wipes local positions, working orders, and the trade log. The eToro account is not touched. Type RESET PAPER."
        phrase={phrase}
        setPhrase={setPhrase}
        expected="RESET PAPER"
        confirmLabel="Reset paper book"
        onConfirm={() => void post("/api/book/reset", { phrase })}
      />
      <PhraseDialog
        open={ddOpen}
        onOpenChange={setDdOpen}
        title="Reset the drawdown kill switch"
        description="Sets the peak to the current mark so new risk can be opened again. Type RESET DRAWDOWN."
        phrase={phrase}
        setPhrase={setPhrase}
        expected="RESET DRAWDOWN"
        confirmLabel="Reset kill switch"
        onConfirm={() => void post("/api/kill/reset", { phrase })}
      />
    </div>
  );
}

function Field({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return (
    <label className="block text-sm">
      <span className="mb-1 block text-muted-foreground">{label}</span>
      <Input value={value} onChange={(event) => onChange(event.target.value)} inputMode="decimal" />
    </label>
  );
}

function Row({ term, value }: { term: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-border/70 py-1">
      <dt className="text-muted-foreground">{term}</dt>
      <dd className="num text-right">{value}</dd>
    </div>
  );
}

function PhraseDialog({
  open,
  onOpenChange,
  title,
  description,
  phrase,
  setPhrase,
  expected,
  confirmLabel,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  phrase: string;
  setPhrase: (value: string) => void;
  expected: string;
  confirmLabel: string;
  onConfirm: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <Label htmlFor="phrase">Confirmation</Label>
        <Input id="phrase" value={phrase} onChange={(event) => setPhrase(event.target.value)} autoComplete="off" />
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="button" disabled={phrase !== expected} onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
