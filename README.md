# Mina

Paper FX desk for one user in Asia/Dubai. It tracks a $50,000 simulated book, ranks the major pairs plus gold, and can route orders to eToro when keys are present. Real money stays off until the process environment and a typed confirmation in the UI both say so.

The 2–3% daily figure is a benchmark the desk measures. It is not a forecast and not a promise. Backtests report how often that band was actually hit.

This book is spot FX and gold. It is separate from any crypto terminal.

## Run locally, no keys

```bash
npm install
npm test
npm run dev
```

Open [http://127.0.0.1:4317](http://127.0.0.1:4317).

With no environment variables the desk:

- starts a local paper account at $50,000
- loads candles from Yahoo’s public chart endpoint (`EURUSD=X` and the other majors; gold uses the `GC=F` future because Yahoo has no `XAUUSD=X`)
- falls back to a deterministic recorded path if that feed is down
- simulates market and limit fills, including spread and the weekend close
- refuses new risk when the daily-loss or drawdown kill switch is on

`npm test` covers the risk engine, the paper fill model, the backtester (including the daily target hit rate), and the eToro request layer (auth headers, leverage fixed at 1, 429 backoff, demo versus real paths).

## eToro keys

A verified eToro account (KYC complete) is required. If API Key Management is missing, finish verification first.

1. Log in at [etoro.com](https://www.etoro.com).
2. Open **Settings → Trading → API Key Management** ([etoro.com/settings/trade](https://www.etoro.com/settings/trade)).
3. Choose the **Demo** environment.
4. Create a key with **Read + Write** permissions.
5. Optionally set an IP allowlist and an expiry.
6. Copy the public API key and the user key into a local `.env` (never commit it):

```bash
cp .env.example .env
```

```env
TRADING_VENUE=paper
ETORO_TRADING_MODE=demo
ETORO_API_KEY=
ETORO_USER_KEY=
```

Keys are read only from the environment (`ETORO_API_KEY`, `ETORO_USER_KEY`). They are not written to the repo, the paper ledger, or the browser payload.

Leave `TRADING_VENUE=paper` while you get used to the desk. Orders stay on the simulator even if the keys are filled in.

To send orders to the **demo** account:

```env
TRADING_VENUE=etoro
ETORO_TRADING_MODE=demo
```

To send orders to the **real** account, both of these are required:

- `TRADING_VENUE=etoro` and `ETORO_TRADING_MODE=real` in the environment
- the Risk tab confirmation, typing `ENABLE REAL MONEY`

Until that confirmation is stored, real mode blocks orders. It does not quietly simulate them instead. Disarm from the same screen.

Docs: [api-portal.etoro.com](https://api-portal.etoro.com) and [builders.etoro.com/get-started](https://builders.etoro.com/get-started).

### What the adapter calls

Every request sends `x-api-key`, `x-user-key`, and a fresh `x-request-id` UUID. A 429 waits for `Retry-After` when present, otherwise exponential backoff, and reuses the same request id so a retried write stays idempotent.

| | Demo | Real |
| --- | --- | --- |
| Portfolio | `GET /api/v1/trading/info/demo/portfolio` | `GET /api/v1/trading/info/portfolio` |
| PnL | `GET /api/v1/trading/info/demo/pnl` | `GET /api/v1/trading/info/real/pnl` |
| Open order | `POST /api/v2/trading/execution/demo/orders` | `POST /api/v2/trading/execution/orders` |
| Close | `POST /api/v1/trading/execution/demo/market-close-orders/positions/{id}` | `POST /api/v1/trading/execution/market-close-orders/positions/{id}` |

Real routes follow the published API. Portfolio does not use a `/real/` segment. Execution drops `demo` rather than inserting `real`. FX pairs are resolved to an eToro `instrumentId` through `GET /api/v1/market-data/search` and cached in `data/desk.json`. Every open order sends `leverage: 1`. Shorts use `sellShort`. Limits use `orderType: "mit"` and `triggerRate`.

Another broker implements `BrokerAdapter` in `src/engine/broker.ts`. eToro is the only remote adapter shipped here.

## Risk defaults

| Control | Default |
| --- | --- |
| Starting cash | $50,000 (`PAPER_STARTING_BALANCE`) |
| Leverage cap | 1 (`LEVERAGE_CAP`, and eToro payloads stay at 1) |
| Per-trade risk | 0.5% of equity, sized from the stop |
| Max position | 100% of equity in one name |
| Daily loss kill | 2% from the Dubai-day open, blocks new risk until the next Dubai day |
| Max drawdown kill | 10% from peak, stays on until you reset it |
| Stop | Required, at least 5 pips, on the correct side of the fill |
| Weekend | No entries, exits, or stop fills from Friday 22:00 UTC to Sunday 22:00 UTC |

Spreads are a fixed pip schedule (about 1.2 pips on EURUSD, $0.35 on gold), not the live eToro spread. Longs buy the ask and sell the bid.

## Strategies and the backtest

Two short-timeframe examples live in `src/engine/strategies.ts`:

- **London session breakout** — Asia range 00:00–07:00 UTC, first break after London opens, stop on the far side, 1.5R target, flat after 16:00 UTC.
- **EMA momentum** — 8/21 EMA cross, 1.5 ATR stop, 2.5 ATR target.

The Backtest tab runs the momentum sample on a recorded EURUSD path as soon as you open it. Metrics: total return, max drawdown, Sharpe (daily returns, √252), win rate, and the share of Dubai sessions that reached 2% and 3%. The same risk engine sizes those trades.

## Layout

- `src/engine` — instruments, risk, paper book, strategies, backtest, eToro HTTP. No Node filesystem imports, so the tests and the browser can share it.
- `src/server` — env config, JSON ledger, Yahoo/recorded prices, eToro adapter, desk routes.
- `src/app` — the desk UI and route handlers.
- `data/desk.json` — local paper state. Gitignored.

## Limitations

- One user, one JSON file, no login.
- Polling, not the eToro websocket.
- Yahoo is an unofficial public chart feed. Gold is the COMEX future, not spot XAUUSD. eToro instrument ids are looked up live and are not hardcoded.
- Fixed spreads. Stops that gap fill at the worse open. A bar that touches both stop and target is booked as a stop.
- The daily kill switch uses the Dubai calendar day, not the broker’s rollover.
- On eToro, a HTTP 200 means the order was accepted, not that it filled. Confirm on the next portfolio read.
- v2 create-order currently opens positions (`buy` / `sellShort`). Closes use the v1 close-by-units route.
- Raising `LEVERAGE_CAP` changes the local exposure cap only. The eToro body still sends leverage 1.
- Nothing here is advice, and the sample strategies are not sized to manufacture a 2% day.
