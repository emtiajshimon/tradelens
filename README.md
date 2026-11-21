# TradeLens — Vercel port

Independent, educational trading-intelligence app (a functional alternative to
BrainMax, built from scratch — no BrainMax branding, copy, or assets).
Live Yahoo Finance candles + RSI / Bollinger / MACD / Stochastic voting
signals, deterministic backtest, paper-trading journal, money-management
sheets, ForexFactory news calendar.

**Source:** `~/workspace/ts-spaces/tradelens-trading-intelligence`
(Hatch artifact `tradelens-trading-intelligence`). This directory is a
**port, not a fork** — the ts-space source is untouched. If the artifact
changes, re-copy `client/dist` and re-run the transform for `api/actions.ts`.

## Layout

```
vercel-tradelens/
  public/                  Built client, copied from the artifact's client/dist
    index.html
    assets/index-*.js      486 KB bundle (hash router, calls POST ./actions)
    assets/index-*.css
  api/
    actions.ts             All 22 server actions, ported from server/src/actions.ts
                           (Hatch SDK stripped; zod schemas + handler logic identical)
    _lib/
      indicators.ts        Indicator math + backtest engine, copied verbatim
      db.ts                Persistence adapter replacing ctx.db()
                           (kept inside api/ so Vercel compiles it into the
                           function bundle — files outside api/ are not
                           resolvable at runtime)
  vercel.json              Rewrite /actions -> /api/actions
  package.json             deps: zod@4.4.3, @vercel/blob; dev: typescript, @types/node
  tsconfig.json
  test-local.ts            End-to-end test (all 22 actions, live Yahoo, sheet math)
```

## How the port works

**Wire contract (unchanged from the artifact):** the built client POSTs
`{action, args, actionCallId}` JSON to `./actions`. `vercel.json` rewrites
that to `/api/actions`. The handler validates `args` against the action's zod
request schema, runs the handler, validates the result against the response
schema, and returns `{data}` on success or `{error}` on failure (always
HTTP 200 for action errors, 405 for non-POST). Session tokens travel inside
`args.token`, exactly as the client already sends them.

**Persistence (`api/_lib/db.ts`):** a small Drizzle-subset adapter
(`select/insert/update/delete`, `eq/and/desc`, `.returning()`,
`.orderBy()/.limit()`) over six JSON tables
(accounts, journal_entries, usage_daily, settings, signal_history,
management_sheets).

- **On Vercel:** one **private** JSON blob per table at
  `tradelens-db/<table>.json`, via `@vercel/blob`, when the
  `BLOB_READ_WRITE_TOKEN` env var is set. Reads use `head()` + the signed
  `downloadUrl`; writes `put()` with `addRandomSuffix: false` so the same
  pathname is overwritten. Writes are serialised through a queue.
- **Locally / without the token:** plain JSON files in
  `TRADELANSL_DB_DIR` (default `./data`, on Vercel `/tmp/tradelens-db`).
  `createdAt` strings are revived to `Date` on load; ids auto-increment.

## Deploy (dashboard / CLI route — NOT the Vercel API)

The Vercel MCP/API route is **blocked**: the OAuth token has no access to
team `shimon16` (403 on list/create project), and no API workaround was
attempted. The project **`tradelens`** already exists on the dashboard
(`prj_j9wBAbBt7oBs54z7zJCVdv0WgpyV`,
https://vercel.com/shimon16/tradelens).

1. Push this directory to a Git repo (or use `vercel` CLI from this dir while
   logged in as shimon16) and import it into the existing `tradelens`
   project — or deploy from the dashboard via Git import.
2. **Create a Vercel Blob store** for the project and set its
   `BLOB_READ_WRITE_TOKEN` env var (Production + Preview). **This is
   required for real persistence:** without the token the fallback writes to
   `/tmp` on Vercel, which is ephemeral per serverless invocation — accounts,
   journal entries, signal history and sheets would NOT survive between
   requests. With the token, each table is one private JSON blob.
3. Deploy. No other env vars are needed. No build step is required for the
   client (it is prebuilt in `public/`); the serverless function is
   `api/actions.ts`.

## Local test

```sh
bun install
bun run typecheck        # tsc --noEmit
bun run test             # test-local.ts — all 22 actions against the local JSON DB
```

`bun run test` needs network access (live Yahoo Finance + ForexFactory).
It creates `./data/` with test rows; delete it afterwards for a clean deploy.

## Constraints kept from the original

- TradeLens code only; no copied BrainMax branding or taglines.
- No broker integration, no order execution, no real-money trading.
- Educational / research-use disclaimers in-app; backtest results are shown
  against the 52.6% breakeven at 90% payout and never imply an edge.
- Signal generation is a snapshot at Generate press, not a live stream;
  OTC pairs are priced from the equivalent real pair's feed and labelled so.
