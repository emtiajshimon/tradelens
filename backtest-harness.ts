// TradeLens signal-engine backtest harness (research implementation, 23 Nov 2026).
// Run: /opt/hatch-image/bin/bun backtest-harness.ts [--refresh] [--variant baseline|htf|atr|news|session|tf15m|tf1h|combo]
// FROZEN PROTOCOL (no peeking then re-tuning — thresholds were fixed before any variant ran):
//   Windows: W1 = 2026-11-06T00:00Z .. 2026-11-21T00:00Z (standard 14d, 6-20 Nov, in-sample for the
//          original 27,814-trade backtest). W2 = 2026-10-23T00:00Z .. 2026-11-06T00:00Z (unseen walk-forward).
//   Pairs: the 10 BACKTEST_DEFAULT_PAIRS. Baseline replicates the server runBacktest action exactly:
//          warmup 60 bars, computeSignal on candles[0..i], require >=2 agreeing votes,
//          entry = next candle open, exit = next candle close, TIE excluded from win-rate denominator.
//   HTF:   veto unless direction agrees with EMA200 on 15M AND on 1H (closed candles only,
//          >=200 HTF bars of history). CALL needs close > EMA200 on both; PUT needs close < both.
//   ATR:   skip when ATR(14, Wilder) on 5M < SMA(ATR(14), 50).
//   ATRPCT: trade only when ATR(14) is in the 20th-80th percentile of its trailing
//          2,880 5M bars (10 days), min 500 bars history. (Follow-up text also said
//          "skip above 90th" — frozen to the headline rule, 20th-80th band.)
//   ADX:   regime switch on ADX(14) 15M (closed candles). ADX>25: trend only — signal must
//          agree with 15M EMA200 trend. ADX<18: mean-reversion only — signal must carry an
//          RSI or Bollinger extreme vote in its direction (RSI<=30 / %B<=0 for CALL,
//          RSI>=70 / %B>=1 for PUT). 18-25: NO TRADE. ADX unavailable: NO TRADE.
//   HTFSLOPE: 15M EMA(50) vs EMA(200), completed candles only. CALL needs EMA50>EMA200
//          AND EMA50 strictly rising over last 3 completed 15M candles; PUT the mirror.
//   NEWS:  skip when signal time is within +/-30 min of a High-impact event (frozen list in
//          ../tradelens-signal-research/data/news-events.json) for either currency of the pair.
//   SESSION: keep only signals with UTC hour in {13,14,15,16} (London-NY overlap).
//   TF15M/TF1H: identical engine on 15M / 1H candles, entry next-bar open, exit next-bar close.
//   ARM1M (ChatGPT config B): 5m trend confirmation + 1m entry + 5m expiry. 1m signal from
//          computeSignal on 1m candles; kept only if the latest closed 5m bar's signal agrees;
//          entry = next 1m open, exit = close 5 1m-bars later. Window M1 = 13-20 Nov 2026:
//          Yahoo 1m history is capped at ~7d (range=1mo returns nothing), so no W2 exists.
//   DATA LIMIT (honest): Yahoo 5m/15m history is capped at range=1mo (~31d, from 23 Oct);
//          range=2mo returns nothing. W1+W2 already span the full available 5m history —
//          the walk-forward CANNOT be extended further on 5m. 1H goes back 3mo but tested worse.
//   Keep rule: beats 52.6% breakeven on BOTH windows with n>=300 trades; report Wilson 95% CI.

import { computeSignal, type Candle } from "./src/_lib/indicators";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";
const DATA_DIR = join(import.meta.dir, "..", "tradelens-signal-research", "data");
const RESULTS_DIR = join(import.meta.dir, "..", "tradelens-signal-research", "results");
mkdirSync(DATA_DIR, { recursive: true });
mkdirSync(RESULTS_DIR, { recursive: true });

const PAIRS: Record<string, string> = {
  "EUR/USD": "EURUSD=X", "GBP/USD": "GBPUSD=X", "USD/JPY": "USDJPY=X", "USD/CAD": "USDCAD=X",
  "EUR/AUD": "EURAUD=X", "AUD/USD": "AUDUSD=X", "NZD/USD": "NZDUSD=X", "EUR/GBP": "EURGBP=X",
  "EUR/JPY": "EURJPY=X", "GBP/JPY": "GBPJPY=X",
};
const PAIR_CCY: Record<string, [string, string]> = {
  "EUR/USD": ["EUR", "USD"], "GBP/USD": ["GBP", "USD"], "USD/JPY": ["USD", "JPY"],
  "USD/CAD": ["USD", "CAD"], "EUR/AUD": ["EUR", "AUD"], "AUD/USD": ["AUD", "USD"],
  "NZD/USD": ["NZD", "USD"], "EUR/GBP": ["EUR", "GBP"], "EUR/JPY": ["EUR", "JPY"],
  "GBP/JPY": ["GBP", "JPY"],
};

const W1_START = Date.parse("2026-11-06T00:00:00Z") / 1000;
const W1_END = Date.parse("2026-11-21T00:00:00Z") / 1000;
const W2_START = Date.parse("2026-10-23T00:00:00Z") / 1000;
const W2_END = W1_START;

// ---------- Yahoo fetch with disk cache (closed candles only) ----------
async function fetchCandles(symbol: string, range: string, interval: string, intervalSec: number): Promise<Candle[]> {
  const cacheFile = join(DATA_DIR, `${symbol}-${interval}.json`);
  const refresh = process.argv.includes("--refresh");
  if (!refresh && existsSync(cacheFile)) {
    return JSON.parse(readFileSync(cacheFile, "utf8")) as Candle[];
  }
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=${interval}`;
  const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" }, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`Yahoo HTTP ${res.status} for ${symbol} ${interval}`);
  const json = (await res.json()) as any;
  const result = json.chart?.result?.[0];
  const ts: number[] = result?.timestamp ?? [];
  const q = result?.indicators?.quote?.[0] ?? {};
  const nowSec = Math.floor(Date.now() / 1000);
  const candles: Candle[] = [];
  for (let i = 0; i < ts.length; i++) {
    const o = q.open?.[i], h = q.high?.[i], l = q.low?.[i], c = q.close?.[i], t = ts[i];
    if (o == null || h == null || l == null || c == null || t == null) continue;
    if (t + intervalSec > nowSec) continue; // finalized candles only
    candles.push({ time: t, open: o, high: h, low: l, close: c });
  }
  candles.sort((a, b) => a.time - b.time);
  writeFileSync(cacheFile, JSON.stringify(candles));
  return candles;
}

// ---------- indicator helpers (harness-local; production code in indicators.ts) ----------
function emaSeries(values: number[], period: number): number[] {
  const k = 2 / (period + 1);
  const out: number[] = [];
  let prev: number | null = null;
  for (const v of values) {
    prev = prev === null ? v : v * k + prev * (1 - k);
    out.push(prev);
  }
  return out;
}

// ATR(14) Wilder series, indexed by candle index (undefined before bar 13).
function atrArray(candles: Candle[]): (number | undefined)[] {
  const tr: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i]!, p = candles[i - 1]!;
    tr.push(Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close)));
  }
  const atr: (number | undefined)[] = new Array(candles.length).fill(undefined);
  let sum = 0;
  for (let j = 0; j < 14; j++) sum += tr[j] ?? 0;
  atr[13] = sum / 14;
  for (let j = 14; j < tr.length; j++) atr[j] = ((atr[j - 1] ?? 0) * 13 + (tr[j] ?? 0)) / 14;
  return atr;
}

// ATR(14) Wilder + SMA(ATR,50). Returns null when not enough history.
function atrAt(candles: Candle[], end: number): { atr: number; sma50: number } | null {
  if (end < 62) return null;
  const atr = atrArray(candles);
  const aEnd = atr[end - 1];
  if (aEnd === undefined) return null;
  let s = 0;
  for (let j = end - 50; j < end; j++) s += atr[j] ?? 0;
  return { atr: aEnd, sma50: s / 50 };
}

// ADX(14) Wilder series on a candle array, indexed by candle index
// (undefined until enough history: needs 14 + 14 smoothed bars + warmup).
function adxArray(candles: Candle[]): (number | undefined)[] {
  const n = candles.length;
  const tr: number[] = [0];
  const plusDM: number[] = [0];
  const minusDM: number[] = [0];
  for (let i = 1; i < n; i++) {
    const c = candles[i]!, p = candles[i - 1]!;
    tr.push(Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close)));
    const up = c.high - p.high;
    const down = p.low - c.low;
    plusDM.push(up > down && up > 0 ? up : 0);
    minusDM.push(down > up && down > 0 ? down : 0);
  }
  const wilder = (arr: number[], period: number): (number | undefined)[] => {
    const out: (number | undefined)[] = new Array(n).fill(undefined);
    let sum = 0;
    for (let j = 0; j < period; j++) sum += arr[j] ?? 0;
    out[period - 1] = sum / period;
    for (let j = period; j < n; j++) out[j] = ((out[j - 1] ?? 0) * (period - 1) + (arr[j] ?? 0)) / period;
    return out;
  };
  const sTR = wilder(tr, 14);
  const sPlus = wilder(plusDM, 14);
  const sMinus = wilder(minusDM, 14);
  const dx: (number | undefined)[] = new Array(n).fill(undefined);
  for (let i = 13; i < n; i++) {
    const t = sTR[i] ?? 0;
    if (t === 0) continue;
    const diPlus = (100 * (sPlus[i] ?? 0)) / t;
    const diMinus = (100 * (sMinus[i] ?? 0)) / t;
    const sum = diPlus + diMinus;
    dx[i] = sum === 0 ? 0 : (100 * Math.abs(diPlus - diMinus)) / sum;
  }
  // Wilder smoothing of DX must start from the first real DX value, not
  // from zero-filled gaps: ADX only where DX exists.
  const out: (number | undefined)[] = new Array(n).fill(undefined);
  let firstDx = -1;
  for (let i = 0; i < n; i++) { if (dx[i] !== undefined) { firstDx = i; break; } }
  if (firstDx < 0) return out;
  let sum = 0;
  for (let j = firstDx; j < firstDx + 14 && j < n; j++) sum += dx[j] ?? 0;
  const startIdx = firstDx + 13;
  if (startIdx >= n) return out;
  out[startIdx] = sum / 14;
  for (let j = startIdx + 1; j < n; j++) {
    if (dx[j] === undefined) continue;
    out[j] = ((out[j - 1] ?? 0) * 13 + (dx[j] ?? 0)) / 14;
  }
  return out;
}

interface NewsEvent { time: string; currency: string; title: string; impact: string }
const NEWS: { time: number; currency: string; title: string }[] = (
  JSON.parse(readFileSync(join(DATA_DIR, "news-events.json"), "utf8")) as NewsEvent[]
).map((e) => ({ time: Date.parse(e.time) / 1000, currency: e.currency, title: e.title }));

function nearNews(t: number, ccys: [string, string]): string | null {
  for (const e of NEWS) {
    if (e.currency !== ccys[0] && e.currency !== ccys[1]) continue;
    if (Math.abs(t - e.time) <= 1800) return e.title;
  }
  return null;
}

// ---------- trade runner ----------
interface Trade {
  pair: string; signalTime: number; direction: "CALL" | "PUT"; confidence: number;
  outcome: "WIN" | "LOSS" | "TIE"; hourUtc: number; filtered: string | null;
}

function wilson(wins: number, n: number): [number, number] {
  if (n === 0) return [0, 0];
  const z = 1.96;
  const p = wins / n;
  const den = 1 + (z * z) / n;
  const centre = p + (z * z) / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return [
    Math.round(((centre - margin) / den) * 1000) / 10,
    Math.round(((centre + margin) / den) * 1000) / 10,
  ];
}

function summarize(trades: Trade[]) {
  const wins = trades.filter((t) => t.outcome === "WIN").length;
  const losses = trades.filter((t) => t.outcome === "LOSS").length;
  const ties = trades.filter((t) => t.outcome === "TIE").length;
  const decided = wins + losses;
  const winRate = decided > 0 ? Math.round((wins / decided) * 1000) / 10 : 0;
  const [lo, hi] = wilson(wins, decided);
  const byHour: Record<number, { n: number; wr: number }> = {};
  for (let h = 0; h < 24; h++) {
    const ts = trades.filter((t) => t.hourUtc === h);
    const w = ts.filter((t) => t.outcome === "WIN").length;
    const l = ts.filter((t) => t.outcome === "LOSS").length;
    if (w + l > 0) byHour[h] = { n: w + l, wr: Math.round((w / (w + l)) * 1000) / 10 };
  }
  const byPair: Record<string, { n: number; wr: number }> = {};
  for (const t of trades) {
    const b = (byPair[t.pair] ??= { n: 0, wr: 0 });
    if (t.outcome !== "TIE") b.n++;
    if (t.outcome === "WIN") b.wr++;
  }
  for (const k of Object.keys(byPair)) {
    const b = byPair[k]!;
    b.wr = b.n > 0 ? Math.round((b.wr / b.n) * 1000) / 10 : 0;
  }
  return { total: trades.length, wins, losses, ties, decided, winRate, wilsonLo: lo, wilsonHi: hi, byHour, byPair };
}

type Variant = "baseline" | "htf" | "atr" | "atrpct" | "adx" | "htfslope" | "news" | "session" | "tf15m" | "tf1h" | "combo" | "arm1m";

async function runVariant(variant: Variant): Promise<void> {
  const isTf = variant === "tf15m" || variant === "tf1h";
  const tf = variant === "tf15m" ? "15m" : variant === "tf1h" ? "1h" : "5m";
  const range = tf === "1h" ? "3mo" : "1mo";
  const intervalSec = tf === "5m" ? 300 : tf === "15m" ? 900 : 3600;
  const allTrades: Trade[] = [];

  for (const [pair, symbol] of Object.entries(PAIRS)) {
    const candles = await fetchCandles(symbol, range, tf, intervalSec);
    let htf15: { times: number[]; ema200: number[]; ema50: number[]; adx: (number | undefined)[] } | null = null;
    let htf1h: { times: number[]; ema200: number[] } | null = null;
    let atrSeries: (number | undefined)[] | null = null;
    if (variant === "htf" || variant === "combo" || variant === "adx" || variant === "htfslope") {
      const c15 = await fetchCandles(symbol, "1mo", "15m", 900);
      htf15 = {
        times: c15.map((c) => c.time),
        ema200: emaSeries(c15.map((c) => c.close), 200),
        ema50: emaSeries(c15.map((c) => c.close), 50),
        adx: adxArray(c15),
      };
    }
    if (variant === "htf" || variant === "combo") {
      const c1h = await fetchCandles(symbol, "3mo", "1h", 3600);
      htf1h = { times: c1h.map((c) => c.time), ema200: emaSeries(c1h.map((c) => c.close), 200) };
    }
    if (variant === "atrpct") atrSeries = atrArray(candles);
    const ccys = PAIR_CCY[pair]!;

    for (let i = 60; i < candles.length - 1; i++) {
      const sigCandle = candles[i]!;
      const t = sigCandle.time;
      const inW1 = t >= W1_START && t < W1_END;
      const inW2 = t >= W2_START && t < W2_END;
      if (!inW1 && !inW2) continue;
      const window = inW1 ? "W1" : "W2";
      const sig = computeSignal(candles.slice(0, i + 1));
      if (!sig) continue;
      // NOTE: the server runBacktest action takes EVERY signal (no vote gate).
      // The >=2-vote rule lives only in indicators.ts runBacktest (used by the
      // single-pair runBacktestAction). Baseline must replicate the action.

      let filtered: string | null = null;
      if (variant === "htf" || variant === "combo") {
        const idx15 = htf15!.times.findIndex((x) => x === Math.floor(t / 900) * 900 - 900);
        const idx1h = htf1h!.times.findIndex((x) => x === Math.floor(t / 3600) * 3600 - 3600);
        if (idx15 < 199 || idx1h < 199) filtered = "htf-no-history";
        else {
          const e15 = htf15!.ema200[idx15]!;
          const e1h = htf1h!.ema200[idx1h]!;
          const close = sigCandle.close;
          const ok = sig.direction === "CALL" ? close > e15 && close > e1h : close < e15 && close < e1h;
          if (!ok) filtered = "htf-veto";
        }
      }
      if (!filtered && (variant === "atr" || variant === "combo")) {
        const a = atrAt(candles, i);
        if (!a) filtered = "atr-no-history";
        else if (a.atr < a.sma50) filtered = "atr-dead-market";
      }
      if (!filtered && variant === "atrpct") {
        // ATR(14) percentile vs trailing 2,880 5M bars (10 days), min 500 history.
        const cur = atrSeries?.[i - 1];
        if (cur === undefined) filtered = "atrpct-no-history";
        else {
          const lo = Math.max(13, i - 2881);
          const window = atrSeries!.slice(lo, i).filter((v): v is number => v !== undefined);
          if (window.length < 500) filtered = "atrpct-no-history";
          else {
            const rank = (window.filter((v) => v <= cur).length / window.length) * 100;
            if (rank < 20 || rank > 80) filtered = `atrpct-rank-${Math.round(rank)}`;
          }
        }
      }
      if (!filtered && variant === "htfslope") {
        const idx15 = htf15!.times.findIndex((x) => x === Math.floor(t / 900) * 900 - 900);
        if (idx15 < 199) filtered = "htf-no-history";
        else {
          const e50 = htf15!.ema50[idx15]!;
          const e200 = htf15!.ema200[idx15]!;
          const e50m1 = htf15!.ema50[idx15 - 1]!;
          const e50m2 = htf15!.ema50[idx15 - 2]!;
          const rising = e50 > e50m1 && e50m1 > e50m2;
          const falling = e50 < e50m1 && e50m1 < e50m2;
          const ok = sig.direction === "CALL" ? e50 > e200 && rising : e50 < e200 && falling;
          if (!ok) filtered = "htfslope-veto";
        }
      }
      if (!filtered && variant === "adx") {
        const idx15 = htf15!.times.findIndex((x) => x === Math.floor(t / 900) * 900 - 900);
        const adxV = idx15 >= 0 ? htf15!.adx[idx15] : undefined;
        if (adxV === undefined || idx15 < 50) filtered = "adx-no-history";
        else if (adxV > 25) {
          // Trending: signal must agree with the 15M EMA200 trend.
          const e200 = htf15!.ema200[idx15]!;
          const close = sigCandle.close;
          const ok = sig.direction === "CALL" ? close > e200 : close < e200;
          if (!ok) filtered = "adx-trend-veto";
        } else if (adxV < 18) {
          // Ranging: signal must carry an RSI or Bollinger extreme vote.
          const rsi = sig.indicators.find((r) => r.id === "rsi");
          const bb = sig.indicators.find((r) => r.id === "bollinger");
          const extreme =
            sig.direction === "CALL"
              ? (rsi !== undefined && rsi.value <= 30) || (bb !== undefined && bb.value <= 0)
              : (rsi !== undefined && rsi.value >= 70) || (bb !== undefined && bb.value >= 100);
          if (!extreme) filtered = "adx-range-no-extreme";
        } else {
          filtered = "adx-no-trade-zone";
        }
      }
      if (!filtered && variant === "news") {
        const hit = nearNews(t, ccys);
        if (hit) filtered = `news:${hit}`;
      }
      if (!filtered && variant === "session") {
        const h = new Date(t * 1000).getUTCHours();
        if (!(h >= 13 && h < 17)) filtered = "session-outside-overlap";
      }
      if (filtered) continue;

      const next = candles[i + 1]!;
      const entry = next.open;
      const exit = next.close;
      let outcome: Trade["outcome"] = "TIE";
      if (exit > entry) outcome = sig.direction === "CALL" ? "WIN" : "LOSS";
      else if (exit < entry) outcome = sig.direction === "PUT" ? "WIN" : "LOSS";
      allTrades.push({
        pair, signalTime: t, direction: sig.direction, confidence: sig.confidence,
        outcome, hourUtc: new Date(t * 1000).getUTCHours(), filtered,
        ...(window === "W1" ? { w: "W1" as const } : { w: "W2" as const }),
      } as Trade & { w: string });
    }
  }

  const typed = allTrades as (Trade & { w: string })[];
  const out: Record<string, unknown> = { variant, windows: {} };
  for (const w of ["W1", "W2"]) {
    const ts = typed.filter((t) => t.w === w);
    const s = summarize(ts);
    (out.windows as Record<string, unknown>)[w] = s;
    console.log(`\n== ${variant} ${w} == trades=${s.total} (W${s.wins}/L${s.losses}/T${s.ties}) winRate=${s.winRate}% Wilson95=[${s.wilsonLo}, ${s.wilsonHi}] beats52.6=${s.winRate > 52.6 && s.decided >= 300}`);
    console.log(`  byPair: ${Object.entries(s.byPair).map(([p, v]) => `${p} ${v.wr}% (n=${v.n})`).join(" | ")}`);
    console.log(`  byHour: ${Object.entries(s.byHour).map(([h, v]) => `${h}h ${v.wr}% (n=${v.n})`).join(" | ")}`);
  }
  // Confidence buckets (pooled, for calibration): 5pp deciles + the coarse
  // bands the Backtest page already shows. n<100 per bucket = not trusted.
  const bucketDefs: [string, number, number][] = [
    ["<50", 0, 49], ["50-54", 50, 54], ["55-59", 55, 59], ["60-64", 60, 64],
    ["65-69", 65, 69], ["70-74", 70, 74], ["75-79", 75, 79], ["80-84", 80, 84],
    ["85-89", 85, 89], ["90+", 90, 100],
  ];
  const buckets: Record<string, { n: number; wr: number }> = {};
  for (const [label, lo, hi] of bucketDefs) {
    const ts = typed.filter((t) => t.confidence >= lo && t.confidence <= hi);
    const w = ts.filter((t) => t.outcome === "WIN").length;
    const l = ts.filter((t) => t.outcome === "LOSS").length;
    buckets[label] = { n: w + l, wr: w + l > 0 ? Math.round((w / (w + l)) * 1000) / 10 : 0 };
  }
  out.buckets = buckets;
  console.log(`  confidence buckets (pooled W1+W2): ${Object.entries(buckets).map(([k, v]) => `${k}: ${v.wr}% (n=${v.n})`).join(" | ")}`);
  writeFileSync(join(RESULTS_DIR, `${variant}.json`), JSON.stringify(out, null, 2));
  console.log(`  saved results/${variant}.json`);
}

// ---------- 1m arm (ChatGPT Configuration B) ----------
// 5m trend confirmation + 1m entry + 5m expiry. Window M1 = 13-20 Nov 2026:
// Yahoo 1m history is capped at ~7d (range=1mo returns nothing), so no W2 exists.
const M1_START = Date.parse("2026-11-13T00:00:00Z") / 1000;
const M1_END = Date.parse("2026-11-21T00:00:00Z") / 1000;

async function runArm1m(): Promise<void> {
  const allTrades: Trade[] = [];
  for (const [pair, symbol] of Object.entries(PAIRS)) {
    const m1 = await fetchCandles(symbol, "7d", "1m", 60);
    const m5 = await fetchCandles(symbol, "1mo", "5m", 300);
    // Cache of 5m signal direction by 5m bar start time (closed bars only).
    const dir5m = new Map<number, "CALL" | "PUT">();
    const dirAt = (t: number): "CALL" | "PUT" | null => {
      const start = Math.floor(t / 300) * 300 - 300;
      const hit = dir5m.get(start);
      if (hit) return hit;
      const idx = m5.findIndex((c) => c.time === start);
      if (idx < 60) return null;
      const sig = computeSignal(m5.slice(0, idx + 1));
      if (!sig) return null;
      dir5m.set(start, sig.direction);
      return sig.direction;
    };
    for (let i = 60; i < m1.length - 5; i++) {
      const c = m1[i]!;
      const t = c.time;
      if (t < M1_START || t >= M1_END) continue;
      const sig = computeSignal(m1.slice(0, i + 1));
      if (!sig) continue;
      const d5 = dirAt(t);
      if (!d5 || d5 !== sig.direction) continue; // 5m trend confirmation
      const entry = m1[i + 1]!.open;
      const exit = m1[i + 5]!.close;
      let outcome: Trade["outcome"] = "TIE";
      if (exit > entry) outcome = sig.direction === "CALL" ? "WIN" : "LOSS";
      else if (exit < entry) outcome = sig.direction === "PUT" ? "WIN" : "LOSS";
      allTrades.push({
        pair, signalTime: t, direction: sig.direction, confidence: sig.confidence,
        outcome, hourUtc: new Date(t * 1000).getUTCHours(), filtered: null,
      });
    }
  }
  const s = summarize(allTrades);
  console.log(`\n== arm1m M1 (13-20 Nov only; 1m history capped ~7d, no W2) == trades=${s.total} (W${s.wins}/L${s.losses}/T${s.ties}) winRate=${s.winRate}% Wilson95=[${s.wilsonLo}, ${s.wilsonHi}] beats52.6=${s.winRate > 52.6 && s.decided >= 300}`);
  console.log(`  byPair: ${Object.entries(s.byPair).map(([p, v]) => `${p} ${v.wr}% (n=${v.n})`).join(" | ")}`);
  console.log(`  byHour: ${Object.entries(s.byHour).map(([h, v]) => `${h}h ${v.wr}% (n=${v.n})`).join(" | ")}`);
  const buckets: Record<string, { n: number; wr: number }> = {};
  for (const [label, lo, hi] of [["<50", 0, 49], ["50-54", 50, 54], ["55-59", 55, 59], ["60-64", 60, 64], ["65-69", 65, 69], ["70-74", 70, 74], ["75-79", 75, 79], ["80-84", 80, 84], ["85-89", 85, 89], ["90+", 90, 100]] as const) {
    const ts = allTrades.filter((t) => t.confidence >= lo && t.confidence <= hi);
    const w = ts.filter((t) => t.outcome === "WIN").length;
    const l = ts.filter((t) => t.outcome === "LOSS").length;
    buckets[label] = { n: w + l, wr: w + l > 0 ? Math.round((w / (w + l)) * 1000) / 10 : 0 };
  }
  console.log(`  confidence buckets: ${Object.entries(buckets).map(([k, v]) => `${k}: ${v.wr}% (n=${v.n})`).join(" | ")}`);
  writeFileSync(join(RESULTS_DIR, "arm1m.json"), JSON.stringify({ variant: "arm1m", window: "M1 13-20 Nov 2026", ...s, buckets }, null, 2));
  console.log("  saved results/arm1m.json");
}

const variant = (process.argv.find((a) => a.startsWith("--variant="))?.split("=")[1] ?? "baseline") as Variant;
const valid: Variant[] = ["baseline", "htf", "atr", "atrpct", "adx", "htfslope", "news", "session", "tf15m", "tf1h", "combo", "arm1m"];
if (!valid.includes(variant)) {
  console.error(`Unknown variant ${variant}. Valid: ${valid.join(", ")}`);
  process.exit(1);
}
if (variant === "arm1m") await runArm1m();
else await runVariant(variant);
