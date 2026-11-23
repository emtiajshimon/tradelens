// TradeLens server actions.
//
// Market data: Yahoo Finance public chart API, fetched SERVER-SIDE only
// (the endpoint sends no CORS header, so browsers cannot call it directly).
// All indicator math lives in ./_lib/indicators.ts and is shared by the signal
// generator, confluence, analyzers and backtest so every view agrees.
//
// Accounts are LOCAL demo accounts: salted SHA-256 password hashes in the
// artifact DB, opaque session tokens, no external auth service, no billing.
// TradeLens never connects to a broker and never executes trades.

import { z } from "zod";
import {
  and,
  createCtx,
  desc,
  ensureDb,
  eq,
  type AccountRow,
  type Ctx,
  type ManagementSheetRow,
} from "./_lib/db";

// Local stand-in for the Hatch SDK's defineAction: identity, but typed so
// handler (ctx, args) get the same contextual types as in the original
// (ctx: Ctx, args inferred from the zod request schema).
type ActionDefinition<Req extends z.ZodType = z.ZodType, Res extends z.ZodType = z.ZodType> = {
  description: string;
  request: Req;
  response: Res;
  handler: (ctx: Ctx, args: z.infer<Req>) => Promise<z.infer<Res>>;
};

function defineAction<Req extends z.ZodType, Res extends z.ZodType>(action: {
  description: string;
  request: Req;
  response: Res;
  handler: (ctx: Ctx, args: z.infer<Req>) => Promise<z.infer<Res>>;
}): ActionDefinition<Req, Res> {
  return action;
}
import {
bollingerAt,
computeSignal,
indicatorHistory,
latestIndicator,
macdSeries,
runBacktest,
simulatedCandles,
stochasticAt,
type Candle,
} from "./_lib/indicators";

// ---------- constants ----------

export const PAIRS: Record<string, string> = {
  "AUD/NZD": "AUDNZD=X",
  "AUD/USD": "AUDUSD=X",
  "CAD/JPY": "CADJPY=X",
  "CHF/JPY": "CHFJPY=X",
  "EUR/AUD": "EURAUD=X",
  "EUR/CAD": "EURCAD=X",
  "EUR/GBP": "EURGBP=X",
  "EUR/JPY": "EURJPY=X",
  "EUR/NZD": "EURNZD=X",
  "EUR/USD": "EURUSD=X",
  "GBP/AUD": "GBPAUD=X",
  "GBP/CAD": "GBPCAD=X",
  "GBP/JPY": "GBPJPY=X",
  "GBP/USD": "GBPUSD=X",
  "NZD/CAD": "NZDCAD=X",
  "NZD/USD": "NZDUSD=X",
  "USD/CAD": "USDCAD=X",
  "USD/CHF": "USDCHF=X",
  "USD/JPY": "USDJPY=X",
  "USD/MXN": "USDMXN=X",
  "USD/SGD": "USDSGD=X",
};

export const TIMEFRAMES = ["1M", "5M", "15M", "30M", "1H", "4H", "1D"] as const;
export type Timeframe = (typeof TIMEFRAMES)[number];

const TF_PARAMS: Record<Timeframe, { range: string; interval: string; seconds: number }> = {
  "1M": { range: "1d", interval: "1m", seconds: 60 },
  "5M": { range: "5d", interval: "5m", seconds: 300 },
  "15M": { range: "1mo", interval: "15m", seconds: 900 },
  "30M": { range: "1mo", interval: "30m", seconds: 1800 },
  "1H": { range: "3mo", interval: "1h", seconds: 3600 },
  "4H": { range: "3mo", interval: "1h", seconds: 14400 },
  "1D": { range: "1y", interval: "1d", seconds: 86400 },
};

export const TIER_LIMITS: Record<string, number | null> = {
  Free: 3,
  Basic: 25,
  Standard: 75,
  Premium: 200,
  Admin: null, // unlimited
};

const pairEnum = z.enum(Object.keys(PAIRS) as [string, ...string[]]);
const tfEnum = z.enum(TIMEFRAMES);
const dayRe = /^\d{4}-\d{2}-\d{2}$/;

// ---------- Yahoo Finance fetch (server-side proxy) ----------

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

interface FeedData {
  candles: Candle[];
  price: number;
  prevClose: number;
  dayHigh: number;
  dayLow: number;
}

const feedCache = new Map<string, { at: number; data: FeedData }>();
const CACHE_MS = 30_000;

function aggregate4h(hourly: Candle[]): Candle[] {
  const out: Candle[] = [];
  let bucket: Candle | null = null;
  let bucketStart = -1;
  for (const c of hourly) {
    const start = Math.floor(c.time / 14400) * 14400;
    if (!bucket || start !== bucketStart) {
      if (bucket) out.push(bucket);
      bucket = { ...c, time: start };
      bucketStart = start;
    } else {
      bucket.high = Math.max(bucket.high, c.high);
      bucket.low = Math.min(bucket.low, c.low);
      bucket.close = c.close;
    }
  }
  if (bucket) out.push(bucket);
  return out;
}

async function fetchFeed(pair: string, tf: Timeframe): Promise<FeedData> {
  const symbol = PAIRS[pair];
  if (!symbol) throw new Error(`Unknown pair ${pair}`);
  const cacheKey = `${symbol}|${tf}`;
  const hit = feedCache.get(cacheKey);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.data;

  const params = TF_PARAMS[tf];
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${params.range}&interval=${params.interval}`;
  let json: unknown;
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": UA, Accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    json = await res.json();
  } catch {
    throw new Error("Live market data is unavailable right now. Check your connection and retry, or switch to the simulated demo feed.");
  }
  const root = json as {
    chart?: {
      result?: Array<{
        meta?: Record<string, unknown>;
        timestamp?: number[];
        indicators?: { quote?: Array<Record<string, Array<number | null>>> };
      }>;
      error?: unknown;
    };
  };
  const result = root.chart?.result?.[0];
  const timestamps = result?.timestamp ?? [];
  const quote = result?.indicators?.quote?.[0];
  if (!result || !quote || timestamps.length === 0) {
    throw new Error("Live market data is unavailable right now. Check your connection and retry, or switch to the simulated demo feed.");
  }
  let candles: Candle[] = [];
  for (let i = 0; i < timestamps.length; i++) {
    const o = quote.open?.[i];
    const h = quote.high?.[i];
    const l = quote.low?.[i];
    const c = quote.close?.[i];
    const t = timestamps[i];
    if (o == null || h == null || l == null || c == null || t == null) continue;
    candles.push({ time: t, open: o, high: h, low: l, close: c });
  }
  if (tf === "4H") candles = aggregate4h(candles);
  if (candles.length < 50) {
    throw new Error("Not enough live candles returned for this timeframe. Retry, or switch to the simulated demo feed.");
  }
  const meta = result.meta ?? {};
  const num = (v: unknown, fallback: number) => (typeof v === "number" && Number.isFinite(v) ? v : fallback);
  const last = candles[candles.length - 1];
  const data: FeedData = {
    candles,
    price: num(meta.regularMarketPrice, last?.close ?? 0),
    prevClose: num(meta.chartPreviousClose, candles[0]?.open ?? 0),
    dayHigh: num(meta.regularMarketDayHigh, Math.max(...candles.slice(-96).map((c) => c.high))),
    dayLow: num(meta.regularMarketDayLow, Math.min(...candles.slice(-96).map((c) => c.low))),
  };
  feedCache.set(cacheKey, { at: Date.now(), data });
  return data;
}

function simulatedFeed(pair: string, tf: Timeframe): FeedData {
  const params = TF_PARAMS[tf];
  const count = tf === "1D" ? 260 : tf === "1M" ? 420 : 320;
  const candles = simulatedCandles(`${pair}|${tf}`, count, params.seconds);
  const last = candles[candles.length - 1];
  const daySlice = candles.slice(-96);
  return {
    candles,
    price: last?.close ?? 0,
    prevClose: candles[0]?.open ?? 0,
    dayHigh: Math.max(...daySlice.map((c) => c.high)),
    dayLow: Math.min(...daySlice.map((c) => c.low)),
  };
}

async function getFeed(pair: string, tf: Timeframe, simulated: boolean): Promise<{ feed: FeedData; source: "live" | "simulated" }> {
  if (simulated) return { feed: simulatedFeed(pair, tf), source: "simulated" };
  return { feed: await fetchFeed(pair, tf), source: "live" };
}

// ---------- accounts ----------

async function hashPassword(password: string, salt: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${salt}:${password}`));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// AccountRow / ManagementSheetRow come from ./_lib/db.

async function accountByToken(ctx: Ctx, token: string): Promise<AccountRow | null> {
  if (!token) return null;
  const db = ctx.db();
  const rows = await db.select().from("settings").where(eq("key", `session:${token}`)).limit(1);
  const id = rows[0]?.value;
  if (!id) return null;
  const accts = await db.select().from("accounts").where(eq("id", Number(id))).limit(1);
  return accts[0] ?? null;
}

async function usageToday(ctx: Ctx, accountId: number, day: string): Promise<number> {
  const db = ctx.db();
  const rows = await db
    .select()
    .from("usage_daily")
    .where(and(eq("accountId", accountId), eq("day", day)))
    .limit(1);
  return rows[0]?.signalsUsed ?? 0;
}

async function createSession(ctx: Ctx, accountId: number): Promise<string> {
  const db = ctx.db();
  const token = crypto.randomUUID();
  await db.insert("settings").values({ key: `session:${token}`, value: String(accountId) });
  return token;
}

// ---------- signal production (shared by generator, live, future) ----------

// Identity key for signal history / sheets: account when signed in, else the
// browser's stable guest id, so both persist across sessions.
function ownerKeyFor(account: AccountRow | null, guestId: string): string {
  return account ? `acct:${account.id}` : `guest:${guestId || "anon"}`;
}

// Increments today's usage counter (account row or guest settings key) and
// returns the new count. Usage is counted and reported, never hard-blocked:
// this is a free alternative with no paywall.
async function bumpUsage(
  ctx: Ctx,
  account: AccountRow | null,
  guestId: string,
  day: string,
  by = 1,
): Promise<number> {
  const db = ctx.db();
  if (account) {
    const used = await usageToday(ctx, account.id, day);
    const existing = await db
      .select()
      .from("usage_daily")
      .where(and(eq("accountId", account.id), eq("day", day)))
      .limit(1);
    if (existing[0]) {
      await db.update("usage_daily").set({ signalsUsed: used + by }).where(eq("id", existing[0].id));
    } else {
      await db.insert("usage_daily").values({ accountId: account.id, day: day, signalsUsed: by });
    }
    return used + by;
  }
  const gkey = `guest-usage:${guestId || "anon"}:${day}`;
  const rows = await db.select().from("settings").where(eq("key", gkey)).limit(1);
  const used = rows[0] ? Number(rows[0].value) || 0 : 0;
  if (rows[0]) {
    await db.update("settings").set({ value: String(used + by) }).where(eq("key", gkey));
  } else {
    await db.insert("settings").values({ key: gkey, value: String(by) });
  }
  return used + by;
}

async function guestUsage(ctx: Ctx, guestId: string, day: string): Promise<number> {
  const db = ctx.db();
  const gkey = `guest-usage:${guestId || "anon"}:${day}`;
  const rows = await db.select().from("settings").where(eq("key", gkey)).limit(1);
  return rows[0] ? Number(rows[0].value) || 0 : 0;
}

// ---------- ForexFactory weekly calendar (free public XML, no key) ----------

interface CalendarEvent {
  title: string;
  country: string;
  date: string;
  time: string;
  impact: string;
  forecast: string;
  previous: string;
}

let calendarCache: { at: number; events: CalendarEvent[] } | null = null;

function xmlTag(block: string, tag: string): string {
  const m = block.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
  if (!m || m[1] === undefined) return "";
  return m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").trim();
}

function eventSortKey(e: CalendarEvent): number {
  const dm = e.date.match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/);
  if (!dm) return Number.MAX_SAFE_INTEGER;
  const [, mm = "1", dd = "1", yyyy = "1970"] = dm;
  let hour = 0;
  let min = 0;
  const tm = e.time.match(/^(\d{1,2}):(\d{2})\s*(am|pm)$/i);
  if (tm) {
    hour = Number(tm[1]) % 12;
    if ((tm[3] ?? "").toLowerCase() === "pm") hour += 12;
    min = Number(tm[2]);
  }
  return Date.UTC(Number(yyyy), Number(mm) - 1, Number(dd), hour, min);
}

async function fetchCalendar(): Promise<CalendarEvent[]> {
  if (calendarCache && Date.now() - calendarCache.at < 10 * 60_000) return calendarCache.events;
  const res = await fetch("https://nfs.faireconomy.media/ff_calendar_thisweek.xml", {
    headers: { "User-Agent": UA, Accept: "application/xml, text/xml" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Calendar HTTP ${res.status}`);
  const xml = await res.text();
  const blocks = xml.split("<event>").slice(1);
  const events: CalendarEvent[] = [];
  for (const b of blocks) {
    const title = xmlTag(b, "title");
    const country = xmlTag(b, "country");
    if (!title || !country) continue;
    events.push({
      title,
      country,
      date: xmlTag(b, "date"),
      time: xmlTag(b, "time") || "—",
      impact: xmlTag(b, "impact") || "Low",
      forecast: xmlTag(b, "forecast"),
      previous: xmlTag(b, "previous"),
    });
  }
  if (events.length === 0) throw new Error("Calendar feed returned no events");
  events.sort((a, b) => eventSortKey(a) - eventSortKey(b));
  const cutoff = Date.now() - 12 * 3600 * 1000;
  const upcoming = events.filter((e) => eventSortKey(e) >= cutoff).slice(0, 120);
  calendarCache = { at: Date.now(), events: upcoming.length > 0 ? upcoming : events.slice(0, 120) };
  return calendarCache.events;
}

// ---------- management sheet math (exact formulae from the spec) ----------

const round2 = (v: number) => Math.round(v * 100) / 100;

export interface SheetRow {
  n: number;
  stake: number;
  winAmount: number;
  balance: number;
  martingaleStake: number | null;
}

export interface SheetMath {
  perTrade: number;
  perWin: number;
  targetAmount: number;
  tradesToTarget: number;
  martingaleStake: number | null;
  rows: SheetRow[];
}

export function computeSheetRows(
  capital: number,
  payout: number,
  targetPct: number,
  riskPct: number,
  martingale: boolean,
): SheetMath {
  const perTrade = round2((capital * riskPct) / 100);
  const perWin = round2((perTrade * payout) / 100);
  const targetAmount = round2((capital * targetPct) / 100);
  if (!(perWin > 0)) throw new Error("Per-win amount is zero — raise the capital, payout, or risk values.");
  const tradesToTarget = Math.ceil(targetAmount / perWin);
  if (tradesToTarget > 5000) {
    throw new Error("This plan needs more than 5,000 winning trades to reach its target — raise the risk per trade or lower the target.");
  }
  const martingaleStake = martingale ? round2(perTrade / (payout / 100)) : null;
  const rows: SheetRow[] = [];
  for (let i = 1; i <= tradesToTarget; i++) {
    rows.push({
      n: i,
      stake: perTrade,
      winAmount: perWin,
      balance: round2(capital + i * perWin),
      martingaleStake,
    });
  }
  return { perTrade, perWin, targetAmount, tradesToTarget, martingaleStake, rows };
}

type SheetDbRow = ManagementSheetRow;

function sheetOut(row: SheetDbRow) {
  const math = computeSheetRows(row.capital, row.payout, row.targetPct, row.riskPct, row.martingale === 1);
  let rows: SheetRow[] = [];
  try {
    const parsed: unknown = JSON.parse(row.rowsJson);
    if (Array.isArray(parsed)) rows = parsed as SheetRow[];
  } catch {
    rows = math.rows;
  }
  return {
    id: row.id,
    capital: row.capital,
    payout: row.payout,
    targetPct: row.targetPct,
    riskPct: row.riskPct,
    martingale: row.martingale === 1,
    perTrade: math.perTrade,
    perWin: math.perWin,
    targetAmount: math.targetAmount,
    tradesToTarget: math.tradesToTarget,
    martingaleStake: math.martingaleStake,
    rows,
    createdAt: row.createdAt.toISOString(),
  };
}

// ---------- deterministic multi-pair backtest (runBacktest) ----------
//
// Design goals (from the brief): no preview/record drift (each signal is
// computed exactly once, directly into the trade record), no settlement on
// unfinalized candles (the forming candle is excluded — only candles whose
// full 5 minutes have elapsed are used), no target-candle ambiguity (entry
// is always candle i+1 open, settlement always candle i+1 close), no
// unattributed parallel batches (pairs are processed sequentially, every
// trade carries its pair), and a sample far larger than a 1-hour live run.
// The action is read-only: it writes nothing to any table, and it never
// substitutes simulated data — if Yahoo returns less history than asked
// for, the actual window used is reported per pair.

export const BACKTEST_DEFAULT_PAIRS = [
  "EUR/USD", "GBP/USD", "USD/JPY", "USD/CAD", "EUR/AUD",
  "AUD/USD", "NZD/USD", "EUR/GBP", "EUR/JPY", "GBP/JPY",
] as const;

// Breakeven win rate at a 90% payout: 1 / (1 + 0.9) = 52.6%.
const BREAKEVEN_90 = 52.6;

interface BacktestTrade {
  pair: string;
  signalTime: number; // epoch seconds of candle i (the signal candle)
  direction: "CALL" | "PUT";
  confidence: number;
  entryPrice: number; // candle i+1 open
  exitPrice: number; // candle i+1 close
  outcome: "WIN" | "LOSS" | "TIE";
}

function summarizeTrades(list: BacktestTrade[]) {
  let wins = 0;
  let losses = 0;
  let ties = 0;
  for (const t of list) {
    if (t.outcome === "WIN") wins++;
    else if (t.outcome === "LOSS") losses++;
    else ties++;
  }
  const decided = wins + losses;
  // Ties are excluded from the win-rate denominator: a tie neither wins
  // nor loses, exactly like a refunded paper trade.
  const winRate = decided > 0 ? Math.round((wins / decided) * 1000) / 10 : 0;
  return {
    total: list.length,
    wins,
    losses,
    ties,
    winRate,
    beatsBreakeven: decided > 0 && winRate > BREAKEVEN_90,
  };
}

// Full 1-month 5-minute series for one pair from the same Yahoo Finance
// server-side proxy the rest of the app uses, with the still-forming
// candle (and any candle whose 5 minutes have not fully elapsed) removed.
// Cached briefly per symbol; windowing to the requested days happens in
// the handler so repeat runs at different day counts reuse the fetch.
const btCache = new Map<string, { at: number; candles: Candle[] }>();

async function fetchClosed5m(pair: string): Promise<Candle[]> {
  const symbol = PAIRS[pair];
  if (!symbol) throw new Error(`Unknown pair ${pair}`);
  const hit = btCache.get(symbol);
  if (hit && Date.now() - hit.at < 60_000) return hit.candles;
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1mo&interval=5m`;
  let json: unknown;
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": UA, Accept: "application/json" },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    json = await res.json();
  } catch {
    throw new Error("Live market data is unavailable right now. The backtest uses the live Yahoo Finance feed only and never substitutes simulated data — retry when the feed is reachable.");
  }
  const root = json as {
    chart?: {
      result?: Array<{
        timestamp?: number[];
        indicators?: { quote?: Array<Record<string, Array<number | null>>> };
      }>;
    };
  };
  const result = root.chart?.result?.[0];
  const timestamps = result?.timestamp ?? [];
  const quote = result?.indicators?.quote?.[0];
  if (!result || !quote || timestamps.length === 0) {
    throw new Error("Live market data is unavailable right now. The backtest uses the live Yahoo Finance feed only and never substitutes simulated data — retry when the feed is reachable.");
  }
  const nowSec = Math.floor(Date.now() / 1000);
  const candles: Candle[] = [];
  for (let i = 0; i < timestamps.length; i++) {
    const o = quote.open?.[i];
    const h = quote.high?.[i];
    const l = quote.low?.[i];
    const c = quote.close?.[i];
    const t = timestamps[i];
    if (o == null || h == null || l == null || c == null || t == null) continue;
    // Finalized candles only: a 5-minute candle starting at t is fully
    // closed at t + 300. Anything later is still forming and is excluded.
    if (t + 300 > nowSec) continue;
    candles.push({ time: t, open: o, high: h, low: l, close: c });
  }
  candles.sort((a, b) => a.time - b.time);
  btCache.set(symbol, { at: Date.now(), candles });
  return candles;
}

interface ProducedSignal {
  ref: string;
  takeAtEpoch: number; // epoch seconds of the next candle open for the timeframe
  signal: NonNullable<ReturnType<typeof computeSignal>>;
}

// Fetches the feed, computes the 4-indicator signal, assigns the next
// reference number, and (optionally) records the signal in history.
async function produceSignal(
  ctx: Ctx,
  args: {
    pair: string;
    timeframe: Timeframe;
    simulated: boolean;
    record: boolean;
    ownerKey: string;
    pairLabel: string;
  },
): Promise<ProducedSignal> {
  const { feed } = await getFeed(args.pair, args.timeframe, args.simulated);
  const signal = computeSignal(feed.candles);
  if (!signal) throw new Error("Not enough candle history to compute a signal for this timeframe yet.");
  const ref = await nextRef(ctx);
  const last = feed.candles[feed.candles.length - 1];
  const takeAtEpoch = (last?.time ?? Math.floor(Date.now() / 1000)) + TF_PARAMS[args.timeframe].seconds;
  if (args.record) {
    const db = ctx.db();
    await db.insert("signal_history").values({
      ownerKey: args.ownerKey,
      ref,
      pairLabel: args.pairLabel,
      basePair: args.pair,
      timeframe: args.timeframe,
      direction: signal.direction,
      confidence: signal.confidence,
      outcome: "PENDING",
    });
  }
  return { ref, takeAtEpoch, signal };
}

const accountShape = z.object({
  id: z.number(),
  name: z.string(),
  email: z.string(),
  tier: z.string(),
});

const authResponse = z.object({
  ok: z.boolean(),
  message: z.string(),
  token: z.string().nullable(),
  account: accountShape.nullable(),
});

function publicAccount(a: AccountRow) {
  return { id: a.id, name: a.name, email: a.email, tier: a.tier };
}

// ---------- shared response shapes ----------

const candleShape = z.object({
  time: z.number(),
  open: z.number(),
  high: z.number(),
  low: z.number(),
  close: z.number(),
});

const indicatorShape = z.object({
  id: z.string(),
  name: z.string(),
  value: z.number(),
  vote: z.enum(["CALL", "PUT", "NEUTRAL"]),
  strength: z.number(),
  reading: z.string(),
});

const signalShape = z.object({
  direction: z.enum(["CALL", "PUT"]),
  confidence: z.number(),
  agreement: z.number(),
  risk: z.enum(["LOW", "MEDIUM", "HIGH"]),
  callVotes: z.number(),
  putVotes: z.number(),
  indicators: z.array(indicatorShape),
  // Honest labelling: observed backtest win rate for this confidence band
  // (frozen calibration, see CALIBRATION_BANDS in indicators.ts), null when
  // the band has fewer than 100 decided trades.
  calibratedWinRate: z.number().nullable(),
  calibrationSample: z.number(),
});

const btStatsShape = z.object({
  total: z.number(),
  wins: z.number(),
  losses: z.number(),
  ties: z.number(),
  winRate: z.number(),
  beatsBreakeven: z.boolean(),
});

const btWindowShape = z.object({
  pair: z.string(),
  candles: z.number(),
  firstTime: z.number(),
  lastTime: z.number(),
  daysUsed: z.number(),
  error: z.string().nullable(),
});

const btTradeShape = z.object({
  pair: z.string(),
  signalTime: z.number(),
  direction: z.enum(["CALL", "PUT"]),
  confidence: z.number(),
  entryPrice: z.number(),
  exitPrice: z.number(),
  outcome: z.enum(["WIN", "LOSS", "TIE"]),
});

const sheetShape = z.object({
  id: z.number(),
  capital: z.number(),
  payout: z.number(),
  targetPct: z.number(),
  riskPct: z.number(),
  martingale: z.boolean(),
  perTrade: z.number(),
  perWin: z.number(),
  targetAmount: z.number(),
  tradesToTarget: z.number(),
  martingaleStake: z.number().nullable(),
  rows: z.array(
    z.object({
      n: z.number(),
      stake: z.number(),
      winAmount: z.number(),
      balance: z.number(),
      martingaleStake: z.number().nullable(),
    }),
  ),
  createdAt: z.string(),
});

// ---------- actions ----------

export const Actions = {
  getCandles: defineAction({
    description: "Fetches candles and price context for one pair/timeframe from the live Yahoo Finance feed (server-side proxy), or the labelled simulated feed when requested.",
    request: z.object({
      pair: pairEnum,
      timeframe: tfEnum,
      simulated: z.boolean().default(false),
    }),
    response: z.object({
      source: z.enum(["live", "simulated"]),
      candles: z.array(candleShape),
      price: z.number(),
      prevClose: z.number(),
      changePct: z.number(),
      dayHigh: z.number(),
      dayLow: z.number(),
      dayPosition: z.number(),
    }),
    async handler(_ctx, args) {
      const { feed, source } = await getFeed(args.pair, args.timeframe, args.simulated);
      const changePct = feed.prevClose > 0 ? ((feed.price - feed.prevClose) / feed.prevClose) * 100 : 0;
      const span = feed.dayHigh - feed.dayLow;
      const dayPosition = span > 0 ? Math.min(100, Math.max(0, ((feed.price - feed.dayLow) / span) * 100)) : 50;
      return {
        source,
        // Cap the payload: the chart only needs the most recent bars.
        candles: feed.candles.slice(-500),
        price: feed.price,
        prevClose: feed.prevClose,
        changePct: Math.round(changePct * 1000) / 1000,
        dayHigh: feed.dayHigh,
        dayLow: feed.dayLow,
        dayPosition: Math.round(dayPosition * 10) / 10,
      };
    },
  }),

  getAnalyzer: defineAction({
    description: "Returns one indicator's current reading, recent value history, and detail numbers (bands / MACD lines / stochastic %K %D) for the analyzer views.",
    request: z.object({
      pair: pairEnum,
      timeframe: tfEnum,
      indicator: z.enum(["rsi", "bollinger", "macd", "stochastic"]),
      simulated: z.boolean().default(false),
    }),
    response: z.object({
      source: z.enum(["live", "simulated"]),
      reading: indicatorShape.nullable(),
      history: z.array(z.object({ time: z.number(), value: z.number() })),
      bandUpper: z.number().nullable(),
      bandMiddle: z.number().nullable(),
      bandLower: z.number().nullable(),
      macdLine: z.number().nullable(),
      macdSignal: z.number().nullable(),
      macdHist: z.number().nullable(),
      stochK: z.number().nullable(),
      stochD: z.number().nullable(),
    }),
    async handler(_ctx, args) {
      const { feed, source } = await getFeed(args.pair, args.timeframe, args.simulated);
      const candles = feed.candles;
      const end = candles.length - 1;
      const closes = candles.map((c) => c.close);
      const reading = latestIndicator(candles, args.indicator);
      const bb = args.indicator === "bollinger" ? bollingerAt(closes, end) : null;
      const macd = args.indicator === "macd" ? macdSeries(closes)[end] : undefined;
      const stoch = args.indicator === "stochastic" ? stochasticAt(candles, end) : null;
      return {
        source,
        reading,
        history: indicatorHistory(candles, args.indicator, 60),
        bandUpper: bb?.upper ?? null,
        bandMiddle: bb?.middle ?? null,
        bandLower: bb?.lower ?? null,
        macdLine: macd?.macd ?? null,
        macdSignal: macd?.signal ?? null,
        macdHist: macd?.histogram ?? null,
        stochK: stoch?.k ?? null,
        stochD: stoch?.d ?? null,
      };
    },
  }),

  generateSignal: defineAction({
    description: "Generates one 4-indicator voting signal for a pair/timeframe and records it in signal history. Counts toward the transparent daily quota (Free = 3/day) but is never hard-blocked: past the quota it still generates and flags quotaReached.",
    request: z.object({
      pair: pairEnum,
      timeframe: tfEnum,
      simulated: z.boolean().default(false),
      token: z.string().default(""),
      guestId: z.string().default(""),
      day: z.string().regex(dayRe),
      // Display label for history, e.g. "EUR/USD-OTC" for an OTC market.
      pairLabel: z.string().trim().max(24).default(""),
      record: z.boolean().default(true),
    }),
    response: z.object({
      ok: z.boolean(),
      reason: z.string().nullable(),
      ref: z.string().nullable(),
      takeAtEpoch: z.number().nullable(),
      mode: z.enum(["REAL", "SIMULATED"]),
      source: z.enum(["live", "simulated"]),
      usedToday: z.number(),
      limit: z.number().nullable(),
      tier: z.string(),
      quotaReached: z.boolean(),
      signal: signalShape.nullable(),
    }),
    async handler(ctx, args) {
      const account = args.token ? await accountByToken(ctx, args.token) : null;
      const tier = account ? account.tier : "Free";
      const limit: number | null = TIER_LIMITS[tier] ?? 3;
      const usedBefore = account
        ? await usageToday(ctx, account.id, args.day)
        : await guestUsage(ctx, args.guestId, args.day);
      const quotaReached = limit !== null && usedBefore >= limit;
      const produced = await produceSignal(ctx, {
        pair: args.pair,
        timeframe: args.timeframe,
        simulated: args.simulated,
        record: args.record,
        ownerKey: ownerKeyFor(account, args.guestId),
        pairLabel: args.pairLabel || args.pair,
      });
      const usedToday = await bumpUsage(ctx, account, args.guestId, args.day, 1);
      ctx.invalidateQueries();
      return {
        ok: true,
        reason: quotaReached
          ? `Daily free quota reached (${usedBefore}/${limit}). This free alternative never paywalls generation — the signal below was still generated and counted.`
          : null,
        ref: produced.ref,
        takeAtEpoch: produced.takeAtEpoch,
        mode: args.simulated ? ("SIMULATED" as const) : ("REAL" as const),
        source: args.simulated ? ("simulated" as const) : ("live" as const),
        usedToday,
        limit,
        tier,
        quotaReached,
        signal: produced.signal,
      };
    },
  }),

  generateBatch: defineAction({
    description: "Future Signals: generates one M5 signal per selected OTC market, capped at the requested count (first N in selection order). Each signal is recorded in history and counted toward the daily quota, never hard-blocked.",
    request: z.object({
      pairs: z.array(pairEnum).min(1).max(21),
      count: z.number().int().min(1).max(15),
      simulated: z.boolean().default(false),
      token: z.string().default(""),
      guestId: z.string().default(""),
      day: z.string().regex(dayRe),
    }),
    response: z.object({
      results: z.array(
        z.object({
          pairLabel: z.string(),
          basePair: z.string(),
          ref: z.string().nullable(),
          takeAtEpoch: z.number().nullable(),
          signal: signalShape.nullable(),
          error: z.string().nullable(),
        }),
      ),
      usedToday: z.number(),
      limit: z.number().nullable(),
      quotaReached: z.boolean(),
    }),
    async handler(ctx, args) {
      const account = args.token ? await accountByToken(ctx, args.token) : null;
      const tier = account ? account.tier : "Free";
      const limit: number | null = TIER_LIMITS[tier] ?? 3;
      const usedBefore = account
        ? await usageToday(ctx, account.id, args.day)
        : await guestUsage(ctx, args.guestId, args.day);
      const ownerKey = ownerKeyFor(account, args.guestId);
      const chosen = args.pairs.slice(0, args.count);
      const results: Array<{
        pairLabel: string;
        basePair: string;
        ref: string | null;
        takeAtEpoch: number | null;
        signal: z.infer<typeof signalShape> | null;
        error: string | null;
      }> = [];
      let generated = 0;
      for (const pair of chosen) {
        const pairLabel = `${pair}-OTC`;
        try {
          const produced = await produceSignal(ctx, {
            pair,
            timeframe: "5M",
            simulated: args.simulated,
            record: true,
            ownerKey,
            pairLabel,
          });
          generated++;
          results.push({ pairLabel, basePair: pair, ref: produced.ref, takeAtEpoch: produced.takeAtEpoch, signal: produced.signal, error: null });
        } catch (e) {
          results.push({
            pairLabel,
            basePair: pair,
            ref: null,
            takeAtEpoch: null,
            signal: null,
            error: e instanceof Error ? e.message : "Feed unavailable",
          });
        }
      }
      const usedToday = generated > 0 ? await bumpUsage(ctx, account, args.guestId, args.day, generated) : usedBefore;
      ctx.invalidateQueries();
      return { results, usedToday, limit, quotaReached: limit !== null && usedBefore >= limit };
    },
  }),

  listSignalHistory: defineAction({
    description: "Lists the caller's generated-signal history (newest first) with outcomes, plus settled WIN/LOSS counts used for accuracy.",
    request: z.object({
      token: z.string().default(""),
      guestId: z.string().default(""),
    }),
    response: z.object({
      entries: z.array(
        z.object({
          id: z.number(),
          ref: z.string(),
          pairLabel: z.string(),
          basePair: z.string(),
          timeframe: z.string(),
          direction: z.enum(["CALL", "PUT"]),
          confidence: z.number(),
          outcome: z.enum(["PENDING", "WIN", "LOSS"]),
          createdAt: z.string(),
        }),
      ),
      wins: z.number(),
      losses: z.number(),
      pending: z.number(),
    }),
    async handler(ctx, args) {
      const account = args.token ? await accountByToken(ctx, args.token) : null;
      const db = ctx.db();
      const rows = await db
        .select()
        .from("signal_history")
        .where(eq("ownerKey", ownerKeyFor(account, args.guestId)))
        .orderBy(desc("id"))
        .limit(100);
      return {
        entries: rows.map((r) => ({
          id: r.id,
          ref: r.ref,
          pairLabel: r.pairLabel,
          basePair: r.basePair,
          timeframe: r.timeframe,
          direction: r.direction,
          confidence: r.confidence,
          outcome: r.outcome,
          createdAt: r.createdAt.toISOString(),
        })),
        wins: rows.filter((r) => r.outcome === "WIN").length,
        losses: rows.filter((r) => r.outcome === "LOSS").length,
        pending: rows.filter((r) => r.outcome === "PENDING").length,
      };
    },
  }),

  setSignalOutcome: defineAction({
    description: "Marks one of the caller's history signals as WIN, LOSS, or back to PENDING.",
    request: z.object({
      token: z.string().default(""),
      guestId: z.string().default(""),
      id: z.number().int().positive(),
      outcome: z.enum(["PENDING", "WIN", "LOSS"]),
    }),
    response: z.object({ ok: z.literal(true) }),
    async handler(ctx, args): Promise<{ ok: true }> {
      const account = args.token ? await accountByToken(ctx, args.token) : null;
      const db = ctx.db();
      await db
        .update("signal_history")
        .set({ outcome: args.outcome })
        .where(
          and(
            eq("id", args.id),
            eq("ownerKey", ownerKeyFor(account, args.guestId)),
          ),
        );
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),

  getOverviewStats: defineAction({
    description: "Real paper-trade accuracy for the last 30 days, computed from settled journal entries (signed-in accounts) plus settled signal-history outcomes. Returns accuracy null when nothing is settled yet — never a static number.",
    request: z.object({
      token: z.string().default(""),
      guestId: z.string().default(""),
    }),
    response: z.object({
      wins: z.number(),
      losses: z.number(),
      settled: z.number(),
      accuracy: z.number().nullable(),
      journalSettled: z.number(),
      historySettled: z.number(),
    }),
    async handler(ctx, args) {
      const account = args.token ? await accountByToken(ctx, args.token) : null;
      const db = ctx.db();
      const since = new Date(Date.now() - 30 * 24 * 3600 * 1000);
      let wins = 0;
      let losses = 0;
      let journalSettled = 0;
      if (account) {
        const rows = await db
          .select()
          .from("journal_entries")
          .where(eq("accountId", account.id))
          .limit(500);
        for (const r of rows) {
          if (r.createdAt < since || r.outcome === "OPEN") continue;
          journalSettled++;
          if (r.outcome === "WIN") wins++;
          else losses++;
        }
      }
      const hist = await db
        .select()
        .from("signal_history")
        .where(eq("ownerKey", ownerKeyFor(account, args.guestId)))
        .limit(500);
      let historySettled = 0;
      for (const r of hist) {
        if (r.createdAt < since || r.outcome === "PENDING") continue;
        historySettled++;
        if (r.outcome === "WIN") wins++;
        else losses++;
      }
      const settled = wins + losses;
      return {
        wins,
        losses,
        settled,
        accuracy: settled > 0 ? Math.round((wins / settled) * 1000) / 10 : null,
        journalSettled,
        historySettled,
      };
    },
  }),

  getNews: defineAction({
    description: "News Signals data: this week's economic calendar from the free public ForexFactory XML feed (fetched server-side, no key). If the feed is unreachable, falls back to strongest/weakest pairs computed from the live Yahoo feeds and says so.",
    request: z.object({}),
    response: z.object({
      source: z.enum(["calendar", "strength"]),
      note: z.string(),
      events: z.array(
        z.object({
          title: z.string(),
          country: z.string(),
          date: z.string(),
          time: z.string(),
          impact: z.string(),
          forecast: z.string(),
          previous: z.string(),
        }),
      ),
      strengths: z.array(
        z.object({ pair: z.string(), changePct: z.number() }),
      ),
    }),
    async handler(_ctx) {
      try {
        const events = await fetchCalendar();
        return {
          source: "calendar" as const,
          note: "Economic calendar: ForexFactory weekly feed (free public XML, no key). Times are US Eastern as published by the feed. High-impact events are when the trading rules say to stay out of the market.",
          events,
          strengths: [],
        };
      } catch {
        const strengths: { pair: string; changePct: number }[] = [];
        for (const pair of Object.keys(PAIRS)) {
          try {
            const { feed } = await getFeed(pair, "1D", false);
            const changePct = feed.prevClose > 0 ? ((feed.price - feed.prevClose) / feed.prevClose) * 100 : 0;
            strengths.push({ pair, changePct: Math.round(changePct * 1000) / 1000 });
          } catch {
            // skip pairs whose feed fails
          }
        }
        strengths.sort((a, b) => b.changePct - a.changePct);
        return {
          source: "strength" as const,
          note: "The free economic-calendar feed is unavailable right now, so this page is built from live market data instead: pairs ranked by 24h change (strongest first). Retry later for the calendar.",
          events: [],
          strengths,
        };
      }
    },
  }),

  saveSheet: defineAction({
    description: "Generates and saves a money-management sheet from the plan inputs. Rows are computed server-side: per trade = capital × risk%, per win = per trade × payout%, target = capital × target%, trades = ceil(target ÷ per win); martingale adds the 1-step recovery stake (per-trade ÷ payout fraction).",
    request: z.object({
      token: z.string().default(""),
      guestId: z.string().default(""),
      capital: z.number().positive().max(10_000_000),
      payout: z.number().min(1).max(100),
      targetPct: z.number().positive().max(1000),
      riskPct: z.number().positive().max(100),
      martingale: z.boolean().default(false),
    }),
    response: sheetShape,
    async handler(ctx, args) {
      const account = args.token ? await accountByToken(ctx, args.token) : null;
      const math = computeSheetRows(args.capital, args.payout, args.targetPct, args.riskPct, args.martingale);
      const db = ctx.db();
      const inserted = await db
        .insert("management_sheets")
        .values({
          ownerKey: ownerKeyFor(account, args.guestId),
          capital: args.capital,
          payout: args.payout,
          targetPct: args.targetPct,
          riskPct: args.riskPct,
          martingale: args.martingale ? 1 : 0,
          rowsJson: JSON.stringify(math.rows),
        })
        .returning();
      const row = inserted[0];
      if (!row) throw new Error("Could not save the sheet.");
      ctx.invalidateQueries();
      return sheetOut(row);
    },
  }),

  listSheets: defineAction({
    description: "Lists the caller's saved management sheets, newest first, each with its inputs summary and full trade-by-trade rows.",
    request: z.object({
      token: z.string().default(""),
      guestId: z.string().default(""),
    }),
    response: z.object({ sheets: z.array(sheetShape) }),
    async handler(ctx, args) {
      const account = args.token ? await accountByToken(ctx, args.token) : null;
      const db = ctx.db();
      const rows = await db
        .select()
        .from("management_sheets")
        .where(eq("ownerKey", ownerKeyFor(account, args.guestId)))
        .orderBy(desc("id"))
        .limit(50);
      return { sheets: rows.map(sheetOut) };
    },
  }),

  deleteSheet: defineAction({
    description: "Deletes one of the caller's saved management sheets.",
    request: z.object({
      token: z.string().default(""),
      guestId: z.string().default(""),
      id: z.number().int().positive(),
    }),
    response: z.object({ ok: z.literal(true) }),
    async handler(ctx, args): Promise<{ ok: true }> {
      const account = args.token ? await accountByToken(ctx, args.token) : null;
      const db = ctx.db();
      await db
        .delete("management_sheets")
        .where(
          and(
            eq("id", args.id),
            eq("ownerKey", ownerKeyFor(account, args.guestId)),
          ),
        );
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),

  getConfluence: defineAction({
    description: "Computes the 4-indicator signal for one pair on every timeframe at once (multi-timeframe confluence panel). Does not consume signal-generation quota.",
    request: z.object({
      pair: pairEnum,
      simulated: z.boolean().default(false),
    }),
    response: z.object({
      source: z.enum(["live", "simulated"]),
      rows: z.array(
        z.object({
          timeframe: z.string(),
          direction: z.enum(["CALL", "PUT"]).nullable(),
          confidence: z.number().nullable(),
          agreement: z.number().nullable(),
          risk: z.enum(["LOW", "MEDIUM", "HIGH"]).nullable(),
          callVotes: z.number(),
          putVotes: z.number(),
          error: z.string().nullable(),
        }),
      ),
      callCount: z.number(),
      putCount: z.number(),
    }),
    async handler(_ctx, args) {
      const rows: Array<{
        timeframe: string;
        direction: "CALL" | "PUT" | null;
        confidence: number | null;
        agreement: number | null;
        risk: "LOW" | "MEDIUM" | "HIGH" | null;
        callVotes: number;
        putVotes: number;
        error: string | null;
      }> = [];
      let source: "live" | "simulated" = args.simulated ? "simulated" : "live";
      for (const tf of TIMEFRAMES) {
        try {
          const got = await getFeed(args.pair, tf, args.simulated);
          source = got.source;
          const sig = computeSignal(got.feed.candles);
          if (!sig) {
            rows.push({ timeframe: tf, direction: null, confidence: null, agreement: null, risk: null, callVotes: 0, putVotes: 0, error: "Not enough history" });
          } else if (sig.callVotes === 0 && sig.putVotes === 0) {
            // No indicator voted directionally — report no signal rather
            // than an arbitrary tie-break direction.
            rows.push({ timeframe: tf, direction: null, confidence: null, agreement: null, risk: null, callVotes: 0, putVotes: 0, error: null });
          } else {
            rows.push({
              timeframe: tf,
              direction: sig.direction,
              confidence: sig.confidence,
              agreement: sig.agreement,
              risk: sig.risk,
              callVotes: sig.callVotes,
              putVotes: sig.putVotes,
              error: null,
            });
          }
        } catch (e) {
          rows.push({
            timeframe: tf,
            direction: null,
            confidence: null,
            agreement: null,
            risk: null,
            callVotes: 0,
            putVotes: 0,
            error: e instanceof Error ? e.message : "Feed unavailable",
          });
        }
      }
      return {
        source,
        rows,
        callCount: rows.filter((r) => r.direction === "CALL").length,
        putCount: rows.filter((r) => r.direction === "PUT").length,
      };
    },
  }),

  runBacktestAction: defineAction({
    description: "Runs the honest walk-forward backtest of the 4-indicator signal rule on a pair/timeframe and returns win rate, profit factor, max drawdown and the breakeven comparison for the chosen payout.",
    request: z.object({
      pair: pairEnum,
      timeframe: tfEnum,
      expiryBars: z.number().int().min(1).max(20).default(5),
      payout: z.number().min(0.5).max(0.99).default(0.9),
      simulated: z.boolean().default(false),
    }),
    response: z.object({
      source: z.enum(["live", "simulated"]),
      candlesUsed: z.number(),
      totalTrades: z.number(),
      wins: z.number(),
      losses: z.number(),
      winRate: z.number(),
      profitFactor: z.number(),
      maxDrawdown: z.number(),
      netUnits: z.number(),
      payout: z.number(),
      breakeven: z.number(),
      beatsBreakeven: z.boolean(),
      equity: z.array(z.object({ time: z.number(), value: z.number() })),
    }),
    async handler(_ctx, args) {
      const { feed, source } = await getFeed(args.pair, args.timeframe, args.simulated);
      const bt = runBacktest(feed.candles, args.expiryBars, args.payout);
      // Sample the equity curve to at most ~160 points for the chart payload.
      const step = Math.max(1, Math.floor(bt.equity.length / 160));
      const equity = bt.equity.filter((_, i) => i % step === 0 || i === bt.equity.length - 1);
      return { source, candlesUsed: feed.candles.length, ...bt, equity };
    },
  }),

  runBacktest: defineAction({
    description: "Deterministic, read-only backtest of the 4-indicator signal engine over finalized historical 5-minute Yahoo Finance candles: each signal is computed once from candles up to the signal candle only, entry is the next candle's open, settlement the next candle's close. Returns overall and min-confidence stats vs the 52.6% breakeven, per-pair and confidence-bucket breakdowns, the actual data window per pair, and the full trade list. Writes nothing.",
    request: z.object({
      pairs: z.array(pairEnum).min(1).max(21).default([...BACKTEST_DEFAULT_PAIRS]),
      timeframe: z.enum(["5M"]).default("5M"),
      days: z.number().int().min(1).max(30).default(14),
      minConfidence: z.number().int().min(0).max(100).default(60),
    }),
    response: z.object({
      timeframe: z.string(),
      daysRequested: z.number(),
      minConfidence: z.number(),
      breakeven: z.number(),
      payout: z.number(),
      overall: btStatsShape,
      subset: btStatsShape,
      perPair: z.array(
        z.object({
          pair: z.string(),
          trades: z.number(),
          wins: z.number(),
          losses: z.number(),
          ties: z.number(),
          winRate: z.number(),
          candles: z.number(),
          firstTime: z.number(),
          lastTime: z.number(),
          daysUsed: z.number(),
          error: z.string().nullable(),
        }),
      ),
      buckets: z.array(
        z.object({
          label: z.string(),
          min: z.number(),
          max: z.number().nullable(),
          trades: z.number(),
          wins: z.number(),
          losses: z.number(),
          ties: z.number(),
          winRate: z.number(),
        }),
      ),
      windows: z.array(btWindowShape),
      totalCandles: z.number(),
      trades: z.array(btTradeShape),
    }),
    async handler(_ctx, args) {
      // Sequential per pair, in request order — no parallel batches, and
      // every trade record carries its pair, so attribution is exact.
      const pairs = [...new Set(args.pairs)];
      const trades: BacktestTrade[] = [];
      const windows: z.infer<typeof btWindowShape>[] = [];
      const perPair: Array<z.infer<typeof btWindowShape> & { trades: number; wins: number; losses: number; ties: number; winRate: number }> = [];

      for (const pair of pairs) {
        let candles: Candle[] = [];
        let error: string | null = null;
        try {
          const all = await fetchClosed5m(pair);
          const lastAll = all[all.length - 1];
          if (!lastAll) throw new Error("No finalized candles returned for this pair.");
          // Longest available window up to the requested days: if Yahoo
          // returned less history than requested, whatever exists is
          // used and reported as-is in the window below.
          const cutoff = lastAll.time - args.days * 86400;
          candles = all.filter((c) => c.time >= cutoff);
          if (candles.length < 62) {
            error = `Only ${candles.length} finalized candles available for this pair in the requested window — not enough to run the engine.`;
            candles = candles.length > 0 ? candles : [];
          }
        } catch (e) {
          error = e instanceof Error ? e.message : "Feed unavailable for this pair.";
          candles = [];
        }
        const first = candles[0];
        const lastC = candles[candles.length - 1];
        const win = {
          pair,
          candles: candles.length,
          firstTime: first?.time ?? 0,
          lastTime: lastC?.time ?? 0,
          daysUsed: first && lastC ? Math.round(((lastC.time - first.time) / 86400) * 10) / 10 : 0,
          error,
        };
        windows.push(win);

        const pairTrades: BacktestTrade[] = [];
        if (!error) {
          // Warmup covers the slowest indicators (MACD 26 + signal,
          // Stochastic smoothing) with margin, matching the warmup the
          // existing walk-forward backtest uses.
          const warmup = 60;
          for (let i = warmup; i < candles.length - 1; i++) {
            // Zero lookahead, computed ONCE: the existing shared engine
            // sees only candles up to and including candle i, and the
            // confidence/direction it returns are written straight into
            // this trade record — they are never recomputed.
            const sig = computeSignal(candles.slice(0, i + 1));
            if (!sig) continue;
            const signalCandle = candles[i];
            const next = candles[i + 1];
            if (!signalCandle || !next) continue;
            const entryPrice = next.open;
            const exitPrice = next.close;
            let outcome: BacktestTrade["outcome"] = "TIE";
            if (exitPrice > entryPrice) outcome = sig.direction === "CALL" ? "WIN" : "LOSS";
            else if (exitPrice < entryPrice) outcome = sig.direction === "PUT" ? "WIN" : "LOSS";
            pairTrades.push({
              pair,
              signalTime: signalCandle.time,
              direction: sig.direction,
              confidence: sig.confidence,
              entryPrice,
              exitPrice,
              outcome,
            });
          }
        }
        trades.push(...pairTrades);
        const s = summarizeTrades(pairTrades);
        perPair.push({ ...win, trades: s.total, wins: s.wins, losses: s.losses, ties: s.ties, winRate: s.winRate });
      }

      if (windows.length > 0 && windows.every((w) => w.error !== null) && trades.length === 0) {
        throw new Error("Live market data is unavailable right now. The backtest uses the live Yahoo Finance feed only and never substitutes simulated data — check your connection and retry.");
      }

      const overall = summarizeTrades(trades);
      const subset = summarizeTrades(trades.filter((t) => t.confidence >= args.minConfidence));
      const bucketDefs: { label: string; min: number; max: number | null }[] = [
        { label: "60–69", min: 60, max: 69 },
        { label: "70–79", min: 70, max: 79 },
        { label: "80+", min: 80, max: null },
      ];
      const buckets = bucketDefs.map((d) => {
        const s = summarizeTrades(
          trades.filter((t) => t.confidence >= d.min && (d.max === null || t.confidence <= d.max)),
        );
        return { label: d.label, min: d.min, max: d.max, trades: s.total, wins: s.wins, losses: s.losses, ties: s.ties, winRate: s.winRate };
      });

      return {
        timeframe: "5M",
        daysRequested: args.days,
        minConfidence: args.minConfidence,
        breakeven: BREAKEVEN_90,
        payout: 0.9,
        overall,
        subset,
        perPair,
        buckets,
        windows,
        totalCandles: windows.reduce((s, w) => s + w.candles, 0),
        trades,
      };
    },
  }),

  signUp: defineAction({
    description: "Creates a local demo account (full name, email, password) starting on the Free tier. Local only — no external auth service, no billing.",
    request: z.object({
      name: z.string().trim().min(2).max(80),
      email: z.string().trim().max(120).regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/, "Enter a valid email address"),
      password: z.string().min(6).max(72),
    }),
    response: authResponse,
    async handler(ctx, args): Promise<z.infer<typeof authResponse>> {
      const db = ctx.db();
      const email = args.email.toLowerCase();
      const existing = await db.select().from("accounts").where(eq("email", email)).limit(1);
      if (existing[0]) {
        return { ok: false, message: "An account with this email already exists. Sign in instead.", token: null, account: null };
      }
      const salt = crypto.randomUUID();
      const passwordHash = await hashPassword(args.password, salt);
      const inserted = await db
        .insert("accounts")
        .values({ name: args.name, email, passwordHash, salt, tier: "Free" })
        .returning();
      const acct = inserted[0];
      if (!acct) throw new Error("Could not create the account. Please retry.");
      const token = await createSession(ctx, acct.id);
      ctx.invalidateQueries();
      return { ok: true, message: "Account created. You are on the Free tier.", token, account: publicAccount(acct) };
    },
  }),

  signIn: defineAction({
    description: "Signs in to a local demo account with email and password.",
    request: z.object({
      email: z.string().trim().max(120),
      password: z.string().min(1).max(72),
    }),
    response: authResponse,
    async handler(ctx, args): Promise<z.infer<typeof authResponse>> {
      const db = ctx.db();
      const rows = await db.select().from("accounts").where(eq("email", args.email.toLowerCase())).limit(1);
      const acct = rows[0];
      if (!acct) return { ok: false, message: "No account found for this email.", token: null, account: null };
      const hash = await hashPassword(args.password, acct.salt);
      if (hash !== acct.passwordHash) return { ok: false, message: "Incorrect password.", token: null, account: null };
      const token = await createSession(ctx, acct.id);
      return { ok: true, message: `Welcome back, ${acct.name}.`, token, account: publicAccount(acct) };
    },
  }),

  getSession: defineAction({
    description: "Returns the signed-in account and today's signal usage for a session token, or a null account for guests.",
    request: z.object({
      token: z.string().default(""),
      guestId: z.string().default(""),
      day: z.string().regex(dayRe),
    }),
    response: z.object({
      account: accountShape.nullable(),
      tier: z.string(),
      limit: z.number().nullable(),
      usedToday: z.number(),
    }),
    async handler(ctx, args) {
      const db = ctx.db();
      const account = args.token ? await accountByToken(ctx, args.token) : null;
      if (account) {
        const used = await usageToday(ctx, account.id, args.day);
        return { account: publicAccount(account), tier: account.tier, limit: TIER_LIMITS[account.tier] ?? null, usedToday: used };
      }
      const gkey = `guest-usage:${args.guestId || "anon"}:${args.day}`;
      const rows = await db.select().from("settings").where(eq("key", gkey)).limit(1);
      return { account: null, tier: "Free", limit: TIER_LIMITS.Free ?? 5, usedToday: rows[0] ? Number(rows[0].value) || 0 : 0 };
    },
  }),

  setTier: defineAction({
    description: "Changes the signed-in account's subscription tier (demo setting — no billing, nothing is charged).",
    request: z.object({
      token: z.string().min(1),
      tier: z.enum(["Free", "Basic", "Standard", "Premium", "Admin"]),
    }),
    response: z.object({ ok: z.boolean(), tier: z.string(), limit: z.number().nullable() }),
    async handler(ctx, args) {
      const account = await accountByToken(ctx, args.token);
      if (!account) throw new Error("Please sign in first.");
      const db = ctx.db();
      await db.update("accounts").set({ tier: args.tier }).where(eq("id", account.id));
      ctx.invalidateQueries();
      return { ok: true, tier: args.tier, limit: TIER_LIMITS[args.tier] ?? null };
    },
  }),

  listJournal: defineAction({
    description: "Lists the signed-in account's paper-trading journal entries, newest first, with running totals.",
    request: z.object({ token: z.string().min(1) }),
    response: z.object({
      entries: z.array(
        z.object({
          id: z.number(),
          pair: z.string(),
          timeframe: z.string(),
          direction: z.enum(["CALL", "PUT"]),
          entryPrice: z.number(),
          exitPrice: z.number().nullable(),
          stake: z.number(),
          expiry: z.string(),
          outcome: z.enum(["OPEN", "WIN", "LOSS"]),
          pnl: z.number(),
          mode: z.enum(["REAL", "SIMULATED"]),
          createdAt: z.string(),
        }),
      ),
      totalPnl: z.number(),
      wins: z.number(),
      losses: z.number(),
      open: z.number(),
    }),
    async handler(ctx, args) {
      const account = await accountByToken(ctx, args.token);
      if (!account) throw new Error("Please sign in to use the paper-trading journal.");
      const db = ctx.db();
      const rows = await db
        .select()
        .from("journal_entries")
        .where(eq("accountId", account.id))
        .orderBy(desc("id"))
        .limit(200);
      const entries = rows.map((r) => ({
        id: r.id,
        pair: r.pair,
        timeframe: r.timeframe,
        direction: r.direction,
        entryPrice: r.entryPrice,
        exitPrice: r.exitPrice,
        stake: r.stake,
        expiry: r.expiry,
        outcome: r.outcome,
        pnl: r.pnl,
        mode: r.mode,
        createdAt: r.createdAt.toISOString(),
      }));
      return {
        entries,
        totalPnl: Math.round(rows.reduce((s, r) => s + r.pnl, 0) * 100) / 100,
        wins: rows.filter((r) => r.outcome === "WIN").length,
        losses: rows.filter((r) => r.outcome === "LOSS").length,
        open: rows.filter((r) => r.outcome === "OPEN").length,
      };
    },
  }),

  addJournalEntry: defineAction({
    description: "Logs a paper trade (demo units only — no real money, no broker) to the signed-in account's journal.",
    request: z.object({
      token: z.string().min(1),
      pair: pairEnum,
      timeframe: tfEnum,
      direction: z.enum(["CALL", "PUT"]),
      entryPrice: z.number().positive().max(100000),
      stake: z.number().positive().max(100000).default(10),
      expiry: z.string().trim().min(1).max(20).default("5 min"),
      mode: z.enum(["REAL", "SIMULATED"]).default("REAL"),
    }),
    response: z.object({ id: z.number() }),
    async handler(ctx, args) {
      const account = await accountByToken(ctx, args.token);
      if (!account) throw new Error("Please sign in to use the paper-trading journal.");
      const db = ctx.db();
      const inserted = await db
        .insert("journal_entries")
        .values({
          accountId: account.id,
          pair: args.pair,
          timeframe: args.timeframe,
          direction: args.direction,
          entryPrice: args.entryPrice,
          stake: args.stake,
          expiry: args.expiry,
          mode: args.mode,
          outcome: "OPEN",
          pnl: 0,
        })
        .returning({ id: "id" });
      const row = inserted[0];
      if (!row) throw new Error("Could not save the journal entry.");
      ctx.invalidateQueries();
      return { id: row.id };
    },
  }),

  settleJournalEntry: defineAction({
    description: "Settles an open paper trade as WIN or LOSS at a given exit price; P&L uses the standard 90% demo payout (win = +0.9 × stake, loss = −stake).",
    request: z.object({
      token: z.string().min(1),
      id: z.number().int().positive(),
      outcome: z.enum(["WIN", "LOSS"]),
      exitPrice: z.number().positive().max(100000),
    }),
    response: z.object({ ok: z.literal(true), pnl: z.number() }),
    async handler(ctx, args): Promise<{ ok: true; pnl: number }> {
      const account = await accountByToken(ctx, args.token);
      if (!account) throw new Error("Please sign in to use the paper-trading journal.");
      const db = ctx.db();
      const rows = await db
        .select()
        .from("journal_entries")
        .where(and(eq("id", args.id), eq("accountId", account.id)))
        .limit(1);
      const entry = rows[0];
      if (!entry) throw new Error("Journal entry not found.");
      if (entry.outcome !== "OPEN") throw new Error("This entry is already settled.");
      const pnl = args.outcome === "WIN" ? Math.round(entry.stake * 0.9 * 100) / 100 : -entry.stake;
      await db
        .update("journal_entries")
        .set({ outcome: args.outcome, exitPrice: args.exitPrice, pnl })
        .where(eq("id", entry.id));
      ctx.invalidateQueries();
      return { ok: true, pnl };
    },
  }),

  deleteJournalEntry: defineAction({
    description: "Deletes one of the signed-in account's journal entries.",
    request: z.object({ token: z.string().min(1), id: z.number().int().positive() }),
    response: z.object({ ok: z.literal(true) }),
    async handler(ctx, args): Promise<{ ok: true }> {
      const account = await accountByToken(ctx, args.token);
      if (!account) throw new Error("Please sign in to use the paper-trading journal.");
      const db = ctx.db();
      await db
        .delete("journal_entries")
        .where(and(eq("id", args.id), eq("accountId", account.id)));
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),
};

async function nextRef(ctx: Ctx): Promise<string> {
  const db = ctx.db();
  const key = "signal_counter";
  const rows = await db.select().from("settings").where(eq("key", key)).limit(1);
  const current = rows[0] ? Number(rows[0].value) || 2048 : 2048;
  const next = current + 1;
  if (rows[0]) {
    await db.update("settings").set({ value: String(next) }).where(eq("key", key));
  } else {
    await db.insert("settings").values({ key, value: String(next) });
  }
  return `#TL-${next}`;
}

// ---------- Vercel dispatch (replaces the Hatch action runtime) ----------
//
// Wire contract (same as the Hatch client in the built bundle): the client
// POSTs { action, args, actionCallId } JSON to ./actions (rewritten to
// /api/actions by vercel.json). Success -> { data }, failure -> { error }.
// Unknown actions and zod validation failures are action errors, not 500s.

type ActionDef = {
  description: string;
  request: z.ZodType;
  response: z.ZodType;
  handler: (ctx: Ctx, args: never) => Promise<unknown>;
};

export async function dispatchAction(
  body: unknown,
): Promise<{ data?: unknown; error?: string }> {
  try {
    if (!body || typeof body !== "object") {
      throw new Error("Expected a JSON body {action, args}.");
    }
    const { action, args } = body as { action?: unknown; args?: unknown };
    if (typeof action !== "string" || !(action in Actions)) {
      throw new Error(`Unknown action: ${String(action)}`);
    }
    const def = Actions[action as keyof typeof Actions] as unknown as ActionDef;
    const parsedArgs = def.request.parse(args ?? {});
    await ensureDb();
    const ctx = createCtx();
    const result = await def.handler(ctx, parsedArgs as never);
    const data = def.response.parse(result);
    return { data };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Action failed." };
  }
}

interface VercelReq {
  method?: string;
  body?: unknown;
}

interface VercelRes {
  status: (code: number) => VercelRes;
  json: (body: unknown) => void;
}

async function readJsonBody(req: VercelReq): Promise<unknown> {
  if (req.body !== undefined) return req.body;
  // Fallback: raw stream (Vercel usually pre-parses JSON bodies).
  const chunks: Buffer[] = [];
  for await (const chunk of req as unknown as AsyncIterable<Buffer>) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as unknown as string));
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? (JSON.parse(text) as unknown) : {};
}

export default async function handler(req: VercelReq, res: VercelRes): Promise<void> {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed." });
    return;
  }
  try {
    const body = await readJsonBody(req);
    res.status(200).json(await dispatchAction(body));
  } catch (e) {
    res.status(200).json({ error: e instanceof Error ? e.message : "Request failed." });
  }
}
