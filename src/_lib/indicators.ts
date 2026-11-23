// Pure market-math module shared by the server actions and the client.
// No imports, no I/O: candles in, indicator readings / signals / backtest
// metrics out. Keeping one implementation guarantees the Signal Generator,
// the Confluence panel, the individual Analyzers and the Backtest all agree.

export interface Candle {
  time: number; // epoch seconds (UTC)
  open: number;
  high: number;
  low: number;
  close: number;
}

export type Vote = "CALL" | "PUT" | "NEUTRAL";

export interface IndicatorReading {
  id: "rsi" | "bollinger" | "macd" | "stochastic";
  name: string;
  value: number; // primary numeric reading (RSI value, %B*100, MACD histogram scaled, %K)
  vote: Vote;
  strength: number; // 0..100
  reading: string; // human text, e.g. "Extreme overbought (89)"
}

export interface SignalResult {
  direction: "CALL" | "PUT";
  confidence: number; // 0..100 — indicator-agreement score, NOT a win probability
  agreement: number; // 0..100 share of non-neutral weight behind the verdict
  risk: "LOW" | "MEDIUM" | "HIGH";
  callVotes: number;
  putVotes: number;
  indicators: IndicatorReading[];
  // Honest labelling: what this confidence band actually won in backtest.
  calibratedWinRate: number | null; // observed win rate % for this confidence band, or null when n < 100
  calibrationSample: number; // decided trades behind calibratedWinRate
}

// ---------- confidence calibration (measured, not assumed) ----------
//
// Frozen calibration map, measured 23 Nov 2026 from the deterministic
// backtest harness (~/workspace/tradelens-signal-research/results/baseline.json):
// 5M forex, 10 pairs, two 14-day windows (23 Oct–5 Nov and 6–20 Nov 2026),
// 57,772 trades, 52,871 decided. Bands with fewer than 100 decided trades
// are reported as "not enough data" instead of a rate.
//
// The curve is nearly flat: no band beats the 52.6% breakeven @ 90% payout,
// and the 80+ band is WORSE than the 60-69 band — so the confidence number
// is an agreement score, not a ranking of trade quality. Re-derive this map
// (same harness, same windows) if the engine ever changes; do not hand-tune it.
export interface CalibrationBand {
  min: number; // inclusive lower bound of the confidence score
  max: number; // inclusive upper bound
  observedWinRate: number | null; // null = fewer than 100 decided trades in this band
  sampleSize: number; // decided trades in this band
}

export const CALIBRATION_BANDS: CalibrationBand[] = [
  { min: 0, max: 49, observedWinRate: 50.2, sampleSize: 33906 },
  { min: 50, max: 54, observedWinRate: 49.6, sampleSize: 3116 },
  { min: 55, max: 59, observedWinRate: 50.1, sampleSize: 3590 },
  { min: 60, max: 64, observedWinRate: 52.3, sampleSize: 4254 },
  { min: 65, max: 69, observedWinRate: 51.4, sampleSize: 4536 },
  { min: 70, max: 74, observedWinRate: 51.2, sampleSize: 2257 },
  { min: 75, max: 79, observedWinRate: 52.0, sampleSize: 898 },
  { min: 80, max: 84, observedWinRate: 50.0, sampleSize: 256 },
  { min: 85, max: 100, observedWinRate: null, sampleSize: 58 }, // n < 100: not enough data
];

export function calibrateConfidence(confidence: number): { observedWinRate: number | null; sampleSize: number } {
  const band = CALIBRATION_BANDS.find((b) => confidence >= b.min && confidence <= b.max);
  if (!band) return { observedWinRate: null, sampleSize: 0 };
  return { observedWinRate: band.observedWinRate, sampleSize: band.sampleSize };
}

// ---------- helpers ----------

function sma(values: number[], period: number, end: number): number | null {
  if (end < period - 1) return null;
  let sum = 0;
  for (let i = end - period + 1; i <= end; i++) sum += values[i] ?? 0;
  return sum / period;
}

function stdev(values: number[], period: number, end: number, mean: number): number {
  let acc = 0;
  for (let i = end - period + 1; i <= end; i++) {
    const d = (values[i] ?? 0) - mean;
    acc += d * d;
  }
  return Math.sqrt(acc / period);
}

function emaSeries(values: number[], period: number): number[] {
  const k = 2 / (period + 1);
  const out: number[] = [];
  let prev: number | null = null;
  for (let i = 0; i < values.length; i++) {
    const v = values[i] ?? 0;
    prev = prev === null ? v : v * k + prev * (1 - k);
    out.push(prev);
  }
  return out;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

// ---------- RSI(14) ----------

export function rsiAt(closes: number[], end: number, period = 14): number | null {
  if (end < period) return null;
  let gains = 0;
  let losses = 0;
  for (let i = end - period + 1; i <= end; i++) {
    const diff = (closes[i] ?? 0) - (closes[i - 1] ?? 0);
    if (diff > 0) gains += diff;
    else losses -= diff;
  }
  if (losses === 0) return gains === 0 ? 50 : 100;
  const rs = gains / period / (losses / period);
  return 100 - 100 / (1 + rs);
}

function rsiReading(closes: number[], end: number): IndicatorReading | null {
  const v = rsiAt(closes, end);
  if (v === null) return null;
  const r = Math.round(v);
  let vote: Vote = "NEUTRAL";
  let strength = 0;
  let reading: string;
  if (v >= 70) {
    vote = "PUT";
    strength = clamp(Math.round(((v - 70) / 30) * 100), 5, 100);
    reading = v >= 80 ? `Extreme overbought (${r})` : `Overbought (${r})`;
  } else if (v <= 30) {
    vote = "CALL";
    strength = clamp(Math.round(((30 - v) / 30) * 100), 5, 100);
    reading = v <= 20 ? `Extreme oversold (${r})` : `Oversold (${r})`;
  } else if (v > 55) {
    reading = `Bullish momentum (${r})`;
    strength = Math.round(((v - 55) / 15) * 40);
  } else if (v < 45) {
    reading = `Bearish momentum (${r})`;
    strength = Math.round(((45 - v) / 15) * 40);
  } else {
    reading = `Neutral zone (${r})`;
    strength = 10;
  }
  return { id: "rsi", name: "RSI (14)", value: v, vote, strength, reading };
}

// ---------- Bollinger Bands(20, 2) ----------

export interface BollingerPoint {
  upper: number;
  middle: number;
  lower: number;
  percentB: number; // 0 = at lower band, 1 = at upper band (can exceed)
}

export function bollingerAt(closes: number[], end: number, period = 20, mult = 2): BollingerPoint | null {
  const mid = sma(closes, period, end);
  if (mid === null) return null;
  const sd = stdev(closes, period, end, mid);
  const upper = mid + mult * sd;
  const lower = mid - mult * sd;
  const width = upper - lower;
  const price = closes[end] ?? 0;
  const percentB = width > 0 ? (price - lower) / width : 0.5;
  return { upper, middle: mid, lower, percentB };
}

function bollingerReading(closes: number[], end: number): IndicatorReading | null {
  const bb = bollingerAt(closes, end);
  if (bb === null) return null;
  const pct = Math.round(bb.percentB * 100);
  let vote: Vote = "NEUTRAL";
  let strength = 0;
  let reading: string;
  if (bb.percentB >= 1) {
    vote = "PUT";
    strength = clamp(60 + Math.round((bb.percentB - 1) * 100), 60, 100);
    reading = `Above upper band — overextended (${pct}%)`;
  } else if (bb.percentB <= 0) {
    vote = "CALL";
    strength = clamp(60 + Math.round((0 - bb.percentB) * 100), 60, 100);
    reading = `Below lower band — oversold bounce zone (${pct}%)`;
  } else if (bb.percentB >= 0.85) {
    vote = "PUT";
    strength = Math.round(((bb.percentB - 0.85) / 0.15) * 55);
    reading = `Near upper band (${pct}%)`;
  } else if (bb.percentB <= 0.15) {
    vote = "CALL";
    strength = Math.round(((0.15 - bb.percentB) / 0.15) * 55);
    reading = `Near lower band (${pct}%)`;
  } else {
    reading = `Mid-band range (${pct}%)`;
    strength = 12;
  }
  return { id: "bollinger", name: "Bollinger Bands (20, 2)", value: bb.percentB * 100, vote, strength, reading };
}

// ---------- MACD(12, 26, 9) ----------

export interface MacdPoint {
  macd: number;
  signal: number;
  histogram: number;
}

export function macdSeries(closes: number[]): MacdPoint[] {
  const fast = emaSeries(closes, 12);
  const slow = emaSeries(closes, 26);
  const macdLine = closes.map((_, i) => (fast[i] ?? 0) - (slow[i] ?? 0));
  const signalLine = emaSeries(macdLine, 9);
  return closes.map((_, i) => ({
    macd: macdLine[i] ?? 0,
    signal: signalLine[i] ?? 0,
    histogram: (macdLine[i] ?? 0) - (signalLine[i] ?? 0),
  }));
}

function macdReading(closes: number[], end: number): IndicatorReading | null {
  if (end < 35) return null;
  const series = macdSeries(closes.slice(0, end + 1));
  const cur = series[end];
  const prev = series[end - 1];
  if (!cur || !prev) return null;
  const price = closes[end] ?? 1;
  // Scale histogram relative to price so strength is comparable across pairs.
  const scaled = (cur.histogram / price) * 10000; // in "pips-ish" units
  const rising = cur.histogram > prev.histogram;
  let vote: Vote = "NEUTRAL";
  let strength = 0;
  let reading: string;
  if (cur.histogram > 0 && prev.histogram <= 0) {
    vote = "CALL";
    strength = 65;
    reading = "Bullish crossover — MACD crossed above signal";
  } else if (cur.histogram < 0 && prev.histogram >= 0) {
    vote = "PUT";
    strength = 65;
    reading = "Bearish crossover — MACD crossed below signal";
  } else if (cur.histogram > 0) {
    vote = rising ? "CALL" : "NEUTRAL";
    strength = clamp(Math.round(30 + Math.abs(scaled) * 6), 30, 90);
    reading = rising ? "Bullish momentum building" : "Bullish but momentum fading";
  } else if (cur.histogram < 0) {
    vote = !rising ? "PUT" : "NEUTRAL";
    strength = clamp(Math.round(30 + Math.abs(scaled) * 6), 30, 90);
    reading = !rising ? "Bearish momentum building" : "Bearish but momentum fading";
  } else {
    reading = "No momentum";
    strength = 5;
  }
  return { id: "macd", name: "MACD (12, 26, 9)", value: scaled, vote, strength, reading };
}

// ---------- Stochastic(14, 3, 3) ----------

export interface StochPoint {
  k: number;
  d: number;
}

export function stochasticAt(candles: Candle[], end: number, kPeriod = 14, kSmooth = 3, dPeriod = 3): StochPoint | null {
  if (end < kPeriod + kSmooth + dPeriod) return null;
  const rawK = (idx: number): number | null => {
    if (idx < kPeriod - 1) return null;
    let hh = -Infinity;
    let ll = Infinity;
    for (let i = idx - kPeriod + 1; i <= idx; i++) {
      const c = candles[i];
      if (!c) return null;
      hh = Math.max(hh, c.high);
      ll = Math.min(ll, c.low);
    }
    const close = candles[idx]?.close ?? 0;
    return hh === ll ? 50 : ((close - ll) / (hh - ll)) * 100;
  };
  const smoothK = (idx: number): number | null => {
    let sum = 0;
    for (let j = 0; j < kSmooth; j++) {
      const v = rawK(idx - j);
      if (v === null) return null;
      sum += v;
    }
    return sum / kSmooth;
  };
  const k = smoothK(end);
  if (k === null) return null;
  let dSum = 0;
  for (let j = 0; j < dPeriod; j++) {
    const v = smoothK(end - j);
    if (v === null) return null;
    dSum += v;
  }
  return { k, d: dSum / dPeriod };
}

function stochasticReading(candles: Candle[], end: number): IndicatorReading | null {
  const cur = stochasticAt(candles, end);
  const prev = stochasticAt(candles, end - 1);
  if (!cur || !prev) return null;
  const r = Math.round(cur.k);
  let vote: Vote = "NEUTRAL";
  let strength = 0;
  let reading: string;
  const crossedUp = prev.k <= prev.d && cur.k > cur.d;
  const crossedDown = prev.k >= prev.d && cur.k < cur.d;
  if (cur.k >= 80) {
    vote = "PUT";
    strength = clamp(Math.round(((cur.k - 80) / 20) * 100), 10, 100);
    reading = cur.k >= 90 ? `Extreme overbought (${r})` : `Overbought zone (${r})`;
    if (crossedDown) {
      strength = clamp(strength + 15, 0, 100);
      reading += " — %K crossing down";
    }
  } else if (cur.k <= 20) {
    vote = "CALL";
    strength = clamp(Math.round(((20 - cur.k) / 20) * 100), 10, 100);
    reading = cur.k <= 10 ? `Extreme oversold (${r})` : `Oversold zone (${r})`;
    if (crossedUp) {
      strength = clamp(strength + 15, 0, 100);
      reading += " — %K crossing up";
    }
  } else if (crossedUp) {
    vote = "CALL";
    strength = 45;
    reading = `Bullish %K/%D cross (${r})`;
  } else if (crossedDown) {
    vote = "PUT";
    strength = 45;
    reading = `Bearish %K/%D cross (${r})`;
  } else {
    reading = `Mid-range (${r})`;
    strength = 12;
  }
  return { id: "stochastic", name: "Stochastic (14, 3, 3)", value: cur.k, vote, strength, reading };
}

// ---------- Combined signal ----------

export function computeSignal(candles: Candle[]): SignalResult | null {
  const end = candles.length - 1;
  if (end < 40) return null;
  const closes = candles.map((c) => c.close);
  const readings = [
    rsiReading(closes, end),
    bollingerReading(closes, end),
    macdReading(closes, end),
    stochasticReading(candles, end),
  ].filter((r): r is IndicatorReading => r !== null);
  if (readings.length < 3) return null;

  let callW = 0;
  let putW = 0;
  let neutralW = 0;
  let callVotes = 0;
  let putVotes = 0;
  for (const r of readings) {
    if (r.vote === "CALL") {
      callW += r.strength;
      callVotes++;
    } else if (r.vote === "PUT") {
      putW += r.strength;
      putVotes++;
    } else {
      neutralW += r.strength;
    }
  }
  const totalW = callW + putW;
  const direction: "CALL" | "PUT" = callW >= putW ? "CALL" : "PUT";
  const winW = Math.max(callW, putW);
  const winVotes = Math.max(callVotes, putVotes);
  // Agreement counts neutral votes in the denominator: a verdict backed by
  // one indicator while three sit neutral is weak agreement, not 100%.
  const agreement = totalW > 0 ? Math.round((winW / (totalW + neutralW)) * 100) : 0;
  // Confidence blends agreement with the average strength of the winning side.
  const winStrength =
    direction === "CALL"
      ? callVotes > 0
        ? callW / callVotes
        : 0
      : putVotes > 0
        ? putW / putVotes
        : 0;
  let confidence = Math.round(agreement * 0.6 + winStrength * 0.4);
  if (totalW === 0) confidence = 35;
  confidence = clamp(confidence, 5, 97);
  const risk: SignalResult["risk"] =
    winVotes >= 3 && agreement >= 70 && confidence >= 65
      ? "LOW"
      : agreement >= 45 && confidence >= 48
        ? "MEDIUM"
        : "HIGH";
  const { observedWinRate: calibratedWinRate, sampleSize: calibrationSample } = calibrateConfidence(confidence);
  return { direction, confidence, agreement, risk, callVotes, putVotes, indicators: readings, calibratedWinRate, calibrationSample };
}

// Single-indicator reading at the latest bar (for the Analyzer views).
export function latestIndicator(candles: Candle[], id: IndicatorReading["id"]): IndicatorReading | null {
  const end = candles.length - 1;
  if (end < 0) return null;
  const closes = candles.map((c) => c.close);
  switch (id) {
    case "rsi":
      return rsiReading(closes, end);
    case "bollinger":
      return bollingerReading(closes, end);
    case "macd":
      return macdReading(closes, end);
    case "stochastic":
      return stochasticReading(candles, end);
  }
}

// Recent history of one indicator's primary value, for analyzer sparklines.
export function indicatorHistory(candles: Candle[], id: IndicatorReading["id"], points = 60): { time: number; value: number }[] {
  const closes = candles.map((c) => c.close);
  const out: { time: number; value: number }[] = [];
  const start = Math.max(0, candles.length - points);
  const macd = id === "macd" ? macdSeries(closes) : null;
  for (let i = start; i < candles.length; i++) {
    const c = candles[i];
    if (!c) continue;
    let v: number | null = null;
    if (id === "rsi") v = rsiAt(closes, i);
    else if (id === "bollinger") {
      const bb = bollingerAt(closes, i);
      v = bb ? bb.percentB * 100 : null;
    } else if (id === "macd") {
      const m = macd?.[i];
      v = m ? (m.histogram / (c.close || 1)) * 10000 : null;
    } else {
      const s = stochasticAt(candles, i);
      v = s ? s.k : null;
    }
    if (v !== null && Number.isFinite(v)) out.push({ time: c.time, value: v });
  }
  return out;
}

// ---------- Backtest ----------

export interface BacktestResult {
  totalTrades: number;
  wins: number;
  losses: number;
  winRate: number; // %
  profitFactor: number; // gross win units / gross loss units (0 when no losses)
  maxDrawdown: number; // in stake units
  netUnits: number;
  payout: number; // e.g. 0.9
  breakeven: number; // % win rate needed at this payout
  beatsBreakeven: boolean;
  equity: { time: number; value: number }[];
}

// Walk-forward: at each bar (after warmup) compute the signal from data up
// to that bar; the trade wins if the close `expiryBars` later is on the
// signal's side of the entry close. Win pays `payout` units, loss costs 1.
export function runBacktest(candles: Candle[], expiryBars: number, payout: number): BacktestResult {
  const trades: { time: number; pnl: number }[] = [];
  const warmup = 60;
  for (let i = warmup; i + expiryBars < candles.length; i++) {
    const slice = candles.slice(0, i + 1);
    const sig = computeSignal(slice);
    if (!sig) continue;
    // Only take trades where at least 2 indicators agree — the same rule a
    // user would apply reading the signal card.
    if (Math.max(sig.callVotes, sig.putVotes) < 2) continue;
    const entry = candles[i]?.close ?? 0;
    const exit = candles[i + expiryBars]?.close ?? 0;
    const win = sig.direction === "CALL" ? exit > entry : exit < entry;
    trades.push({ time: candles[i + expiryBars]?.time ?? 0, pnl: win ? payout : -1 });
  }
  let wins = 0;
  let grossWin = 0;
  let grossLoss = 0;
  let equityNow = 0;
  let peak = 0;
  let maxDd = 0;
  const equity: { time: number; value: number }[] = [];
  for (const t of trades) {
    if (t.pnl > 0) {
      wins++;
      grossWin += t.pnl;
    } else {
      grossLoss += -t.pnl;
    }
    equityNow += t.pnl;
    peak = Math.max(peak, equityNow);
    maxDd = Math.max(maxDd, peak - equityNow);
    equity.push({ time: t.time, value: Math.round(equityNow * 100) / 100 });
  }
  const total = trades.length;
  const winRate = total > 0 ? (wins / total) * 100 : 0;
  const breakeven = (1 / (1 + payout)) * 100;
  return {
    totalTrades: total,
    wins,
    losses: total - wins,
    winRate: Math.round(winRate * 10) / 10,
    profitFactor: grossLoss > 0 ? Math.round((grossWin / grossLoss) * 100) / 100 : grossWin > 0 ? 99 : 0,
    maxDrawdown: Math.round(maxDd * 100) / 100,
    netUnits: Math.round(equityNow * 100) / 100,
    payout,
    breakeven: Math.round(breakeven * 10) / 10,
    beatsBreakeven: total > 0 && winRate > breakeven,
    equity,
  };
}

// ---------- Simulated feed ----------

// Deterministic seeded random-walk candles, used ONLY as the clearly
// labelled simulated fallback when the live feed is unreachable (or when
// the user explicitly selects simulated mode). Never presented as live.
export function simulatedCandles(seedKey: string, count: number, intervalSec: number): Candle[] {
  let seed = 2166136261;
  for (let i = 0; i < seedKey.length; i++) {
    seed ^= seedKey.charCodeAt(i);
    seed = Math.imul(seed, 16777619);
  }
  const rand = () => {
    seed = Math.imul(seed ^ (seed >>> 15), 2246822507);
    seed = Math.imul(seed ^ (seed >>> 13), 3266489909);
    seed ^= seed >>> 16;
    return ((seed >>> 0) % 100000) / 100000;
  };
  const isJpy = seedKey.includes("JPY");
  let price = isJpy ? 149.5 : seedKey.includes("EURGBP") ? 0.855 : 1.085;
  const vol = isJpy ? 0.045 : 0.00045;
  const now = Math.floor(Date.now() / 1000);
  const start = now - count * intervalSec;
  const out: Candle[] = [];
  for (let i = 0; i < count; i++) {
    const drift = Math.sin(i / 37) * vol * 0.35;
    const open = price;
    const change = (rand() - 0.5) * 2 * vol + drift;
    const close = open + change;
    const high = Math.max(open, close) + rand() * vol * 0.6;
    const low = Math.min(open, close) - rand() * vol * 0.6;
    out.push({ time: start + i * intervalSec, open, high, low, close });
    price = close;
  }
  return out;
}
