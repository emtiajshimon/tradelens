// src/actions.ts
import { z } from "zod";

// src/_lib/db.ts
import { head, put } from "@vercel/blob";
import { promises as fs } from "node:fs";
import path from "node:path";
var TABLE_NAMES = [
  "accounts",
  "journal_entries",
  "usage_daily",
  "settings",
  "signal_history",
  "management_sheets"
];
var AUTO_ID = /* @__PURE__ */ new Set([
  "accounts",
  "journal_entries",
  "usage_daily",
  "signal_history",
  "management_sheets"
]);
var HAS_CREATED_AT = /* @__PURE__ */ new Set([
  "accounts",
  "journal_entries",
  "signal_history",
  "management_sheets"
]);
var BLOB_PREFIX = "tradelens-db";
function eq(col, value) {
  return (row) => row[col] === value;
}
function and(...preds) {
  return (row) => preds.every((p) => p(row));
}
function desc(col) {
  return { col, dir: -1 };
}
var SelectBuilder = class {
  constructor(db, table) {
    this.db = db;
    this.table = table;
  }
  db;
  table;
  pred = null;
  order = null;
  limitN = null;
  where(pred) {
    this.pred = pred;
    return this;
  }
  orderBy(o) {
    this.order = o;
    return this;
  }
  limit(n) {
    this.limitN = n;
    return this;
  }
  async exec() {
    let rows = [...this.db.rows(this.table)];
    if (this.pred) rows = rows.filter(this.pred);
    if (this.order) {
      const { col, dir } = this.order;
      rows.sort((a, b) => {
        const av = a[col];
        const bv = b[col];
        if (av < bv) return -dir;
        if (av > bv) return dir;
        return 0;
      });
    }
    if (this.limitN !== null) rows = rows.slice(0, this.limitN);
    return rows;
  }
  then(onfulfilled, onrejected) {
    return this.exec().then(onfulfilled, onrejected);
  }
};
var InsertBuilder = class {
  constructor(db, table) {
    this.db = db;
    this.table = table;
  }
  db;
  table;
  _values = null;
  done = null;
  values(v) {
    this._values = v;
    return this;
  }
  returning(map) {
    if (!this.done) this.done = this.run(map);
    return this.done;
  }
  async run(map) {
    const row = this.db.insertRow(this.table, this._values ?? {});
    await this.db.persist(this.table);
    if (!map) return [row];
    const out = {};
    for (const [k, col] of Object.entries(map)) out[k] = row[col];
    return [out];
  }
  then(onfulfilled, onrejected) {
    return this.returning().then(onfulfilled, onrejected);
  }
};
var UpdateBuilder = class {
  constructor(db, table) {
    this.db = db;
    this.table = table;
  }
  db;
  table;
  patch = null;
  pred = null;
  done = null;
  set(patch) {
    this.patch = patch;
    return this;
  }
  where(pred) {
    this.pred = pred;
    return this;
  }
  async exec() {
    if (!this.done) {
      this.done = (async () => {
        const n = this.db.updateRows(this.table, this.pred, this.patch ?? {});
        if (n > 0) await this.db.persist(this.table);
        return n;
      })();
    }
    return this.done;
  }
  then(onfulfilled, onrejected) {
    return this.exec().then(onfulfilled, onrejected);
  }
};
var DeleteBuilder = class {
  constructor(db, table) {
    this.db = db;
    this.table = table;
  }
  db;
  table;
  pred = null;
  done = null;
  where(pred) {
    this.pred = pred;
    return this;
  }
  async exec() {
    if (!this.done) {
      this.done = (async () => {
        const n = this.db.deleteRows(this.table, this.pred);
        if (n > 0) await this.db.persist(this.table);
        return n;
      })();
    }
    return this.done;
  }
  then(onfulfilled, onrejected) {
    return this.exec().then(onfulfilled, onrejected);
  }
};
var Db = class {
  data = {
    accounts: [],
    journal_entries: [],
    usage_daily: [],
    settings: [],
    signal_history: [],
    management_sheets: []
  };
  loaded = false;
  saveQueue = Promise.resolve();
  get useBlob() {
    return Boolean(process.env.BLOB_READ_WRITE_TOKEN);
  }
  localDir() {
    if (process.env.TRADELANSL_DB_DIR) return process.env.TRADELANSL_DB_DIR;
    if (process.env.VERCEL) return "/tmp/tradelens-db";
    return path.join(process.cwd(), "data");
  }
  async load() {
    if (this.loaded) return;
    for (const table of TABLE_NAMES) {
      this.data[table] = await this.readTable(table);
    }
    this.loaded = true;
  }
  rows(table) {
    return this.data[table];
  }
  select() {
    return { from: (table) => new SelectBuilder(this, table) };
  }
  insert(table) {
    return new InsertBuilder(this, table);
  }
  update(table) {
    return new UpdateBuilder(this, table);
  }
  delete(table) {
    return new DeleteBuilder(this, table);
  }
  insertRow(table, values) {
    const row = { ...values };
    if (AUTO_ID.has(table)) {
      const rows = this.data[table];
      const maxId = rows.reduce((m, r) => Math.max(m, r.id ?? 0), 0);
      row.id = maxId + 1;
    }
    if (HAS_CREATED_AT.has(table) && row.createdAt === void 0) {
      row.createdAt = /* @__PURE__ */ new Date();
    }
    if (table === "journal_entries" && row.exitPrice === void 0) row.exitPrice = null;
    this.data[table].push(row);
    return row;
  }
  updateRows(table, pred, patch) {
    let n = 0;
    for (const row of this.data[table]) {
      if (pred && !pred(row)) continue;
      Object.assign(row, patch);
      n++;
    }
    return n;
  }
  deleteRows(table, pred) {
    const before = this.data[table].length;
    this.data[table] = this.data[table].filter((r) => !(pred ? pred(r) : true));
    return before - this.data[table].length;
  }
  async persist(table) {
    const run = async () => {
      if (this.useBlob) await this.writeBlob(table);
      else await this.writeFile(table);
    };
    this.saveQueue = this.saveQueue.then(run, run);
    await this.saveQueue;
  }
  // ----- backends -----
  blobPath(table) {
    return `${BLOB_PREFIX}/${table}.json`;
  }
  revive(table, raw) {
    if (!Array.isArray(raw)) return [];
    return raw.map((r) => {
      const row = { ...r };
      if (HAS_CREATED_AT.has(table) && typeof row.createdAt === "string") {
        row.createdAt = new Date(row.createdAt);
      }
      return row;
    });
  }
  async readTable(table) {
    if (this.useBlob) {
      try {
        const meta = await head(this.blobPath(table));
        const res = await fetch(meta.downloadUrl);
        if (!res.ok) return [];
        return this.revive(table, await res.json());
      } catch {
        return [];
      }
    }
    try {
      const text = await fs.readFile(path.join(this.localDir(), `${table}.json`), "utf8");
      return this.revive(table, JSON.parse(text));
    } catch {
      return [];
    }
  }
  async writeBlob(table) {
    await put(this.blobPath(table), JSON.stringify(this.data[table]), {
      access: "private",
      addRandomSuffix: false
    });
  }
  async writeFile(table) {
    const dir = this.localDir();
    await fs.mkdir(dir, { recursive: true });
    const tmp = path.join(dir, `.${table}.json.tmp`);
    await fs.writeFile(tmp, JSON.stringify(this.data[table]), "utf8");
    await fs.rename(tmp, path.join(dir, `${table}.json`));
  }
};
var dbInstance = null;
var loadPromise = null;
function ensureDb() {
  if (dbInstance) return Promise.resolve(dbInstance);
  if (!loadPromise) {
    loadPromise = (async () => {
      const db = new Db();
      await db.load();
      dbInstance = db;
      return db;
    })();
  }
  return loadPromise;
}
function getDb() {
  if (!dbInstance) throw new Error("Database not loaded \u2014 call ensureDb() first.");
  return dbInstance;
}
function createCtx() {
  return { db: getDb, invalidateQueries: () => {
  } };
}

// src/_lib/indicators.ts
function sma(values, period, end) {
  if (end < period - 1) return null;
  let sum = 0;
  for (let i = end - period + 1; i <= end; i++) sum += values[i] ?? 0;
  return sum / period;
}
function stdev(values, period, end, mean) {
  let acc = 0;
  for (let i = end - period + 1; i <= end; i++) {
    const d = (values[i] ?? 0) - mean;
    acc += d * d;
  }
  return Math.sqrt(acc / period);
}
function emaSeries(values, period) {
  const k = 2 / (period + 1);
  const out = [];
  let prev = null;
  for (let i = 0; i < values.length; i++) {
    const v = values[i] ?? 0;
    prev = prev === null ? v : v * k + prev * (1 - k);
    out.push(prev);
  }
  return out;
}
var clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
function rsiAt(closes, end, period = 14) {
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
function rsiReading(closes, end) {
  const v = rsiAt(closes, end);
  if (v === null) return null;
  const r = Math.round(v);
  let vote = "NEUTRAL";
  let strength = 0;
  let reading;
  if (v >= 70) {
    vote = "PUT";
    strength = clamp(Math.round((v - 70) / 30 * 100), 5, 100);
    reading = v >= 80 ? `Extreme overbought (${r})` : `Overbought (${r})`;
  } else if (v <= 30) {
    vote = "CALL";
    strength = clamp(Math.round((30 - v) / 30 * 100), 5, 100);
    reading = v <= 20 ? `Extreme oversold (${r})` : `Oversold (${r})`;
  } else if (v > 55) {
    reading = `Bullish momentum (${r})`;
    strength = Math.round((v - 55) / 15 * 40);
  } else if (v < 45) {
    reading = `Bearish momentum (${r})`;
    strength = Math.round((45 - v) / 15 * 40);
  } else {
    reading = `Neutral zone (${r})`;
    strength = 10;
  }
  return { id: "rsi", name: "RSI (14)", value: v, vote, strength, reading };
}
function bollingerAt(closes, end, period = 20, mult = 2) {
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
function bollingerReading(closes, end) {
  const bb = bollingerAt(closes, end);
  if (bb === null) return null;
  const pct = Math.round(bb.percentB * 100);
  let vote = "NEUTRAL";
  let strength = 0;
  let reading;
  if (bb.percentB >= 1) {
    vote = "PUT";
    strength = clamp(60 + Math.round((bb.percentB - 1) * 100), 60, 100);
    reading = `Above upper band \u2014 overextended (${pct}%)`;
  } else if (bb.percentB <= 0) {
    vote = "CALL";
    strength = clamp(60 + Math.round((0 - bb.percentB) * 100), 60, 100);
    reading = `Below lower band \u2014 oversold bounce zone (${pct}%)`;
  } else if (bb.percentB >= 0.85) {
    vote = "PUT";
    strength = Math.round((bb.percentB - 0.85) / 0.15 * 55);
    reading = `Near upper band (${pct}%)`;
  } else if (bb.percentB <= 0.15) {
    vote = "CALL";
    strength = Math.round((0.15 - bb.percentB) / 0.15 * 55);
    reading = `Near lower band (${pct}%)`;
  } else {
    reading = `Mid-band range (${pct}%)`;
    strength = 12;
  }
  return { id: "bollinger", name: "Bollinger Bands (20, 2)", value: bb.percentB * 100, vote, strength, reading };
}
function macdSeries(closes) {
  const fast = emaSeries(closes, 12);
  const slow = emaSeries(closes, 26);
  const macdLine = closes.map((_, i) => (fast[i] ?? 0) - (slow[i] ?? 0));
  const signalLine = emaSeries(macdLine, 9);
  return closes.map((_, i) => ({
    macd: macdLine[i] ?? 0,
    signal: signalLine[i] ?? 0,
    histogram: (macdLine[i] ?? 0) - (signalLine[i] ?? 0)
  }));
}
function macdReading(closes, end) {
  if (end < 35) return null;
  const series = macdSeries(closes.slice(0, end + 1));
  const cur = series[end];
  const prev = series[end - 1];
  if (!cur || !prev) return null;
  const price = closes[end] ?? 1;
  const scaled = cur.histogram / price * 1e4;
  const rising = cur.histogram > prev.histogram;
  let vote = "NEUTRAL";
  let strength = 0;
  let reading;
  if (cur.histogram > 0 && prev.histogram <= 0) {
    vote = "CALL";
    strength = 65;
    reading = "Bullish crossover \u2014 MACD crossed above signal";
  } else if (cur.histogram < 0 && prev.histogram >= 0) {
    vote = "PUT";
    strength = 65;
    reading = "Bearish crossover \u2014 MACD crossed below signal";
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
function stochasticAt(candles, end, kPeriod = 14, kSmooth = 3, dPeriod = 3) {
  if (end < kPeriod + kSmooth + dPeriod) return null;
  const rawK = (idx) => {
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
    return hh === ll ? 50 : (close - ll) / (hh - ll) * 100;
  };
  const smoothK = (idx) => {
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
function stochasticReading(candles, end) {
  const cur = stochasticAt(candles, end);
  const prev = stochasticAt(candles, end - 1);
  if (!cur || !prev) return null;
  const r = Math.round(cur.k);
  let vote = "NEUTRAL";
  let strength = 0;
  let reading;
  const crossedUp = prev.k <= prev.d && cur.k > cur.d;
  const crossedDown = prev.k >= prev.d && cur.k < cur.d;
  if (cur.k >= 80) {
    vote = "PUT";
    strength = clamp(Math.round((cur.k - 80) / 20 * 100), 10, 100);
    reading = cur.k >= 90 ? `Extreme overbought (${r})` : `Overbought zone (${r})`;
    if (crossedDown) {
      strength = clamp(strength + 15, 0, 100);
      reading += " \u2014 %K crossing down";
    }
  } else if (cur.k <= 20) {
    vote = "CALL";
    strength = clamp(Math.round((20 - cur.k) / 20 * 100), 10, 100);
    reading = cur.k <= 10 ? `Extreme oversold (${r})` : `Oversold zone (${r})`;
    if (crossedUp) {
      strength = clamp(strength + 15, 0, 100);
      reading += " \u2014 %K crossing up";
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
function computeSignal(candles) {
  const end = candles.length - 1;
  if (end < 40) return null;
  const closes = candles.map((c) => c.close);
  const readings = [
    rsiReading(closes, end),
    bollingerReading(closes, end),
    macdReading(closes, end),
    stochasticReading(candles, end)
  ].filter((r) => r !== null);
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
  const direction = callW >= putW ? "CALL" : "PUT";
  const winW = Math.max(callW, putW);
  const winVotes = Math.max(callVotes, putVotes);
  const agreement = totalW > 0 ? Math.round(winW / (totalW + neutralW) * 100) : 0;
  const winStrength = direction === "CALL" ? callVotes > 0 ? callW / callVotes : 0 : putVotes > 0 ? putW / putVotes : 0;
  let confidence = Math.round(agreement * 0.6 + winStrength * 0.4);
  if (totalW === 0) confidence = 35;
  confidence = clamp(confidence, 5, 97);
  const risk = winVotes >= 3 && agreement >= 70 && confidence >= 65 ? "LOW" : agreement >= 45 && confidence >= 48 ? "MEDIUM" : "HIGH";
  return { direction, confidence, agreement, risk, callVotes, putVotes, indicators: readings };
}
function latestIndicator(candles, id) {
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
function indicatorHistory(candles, id, points = 60) {
  const closes = candles.map((c) => c.close);
  const out = [];
  const start = Math.max(0, candles.length - points);
  const macd = id === "macd" ? macdSeries(closes) : null;
  for (let i = start; i < candles.length; i++) {
    const c = candles[i];
    if (!c) continue;
    let v = null;
    if (id === "rsi") v = rsiAt(closes, i);
    else if (id === "bollinger") {
      const bb = bollingerAt(closes, i);
      v = bb ? bb.percentB * 100 : null;
    } else if (id === "macd") {
      const m = macd?.[i];
      v = m ? m.histogram / (c.close || 1) * 1e4 : null;
    } else {
      const s = stochasticAt(candles, i);
      v = s ? s.k : null;
    }
    if (v !== null && Number.isFinite(v)) out.push({ time: c.time, value: v });
  }
  return out;
}
function runBacktest(candles, expiryBars, payout) {
  const trades = [];
  const warmup = 60;
  for (let i = warmup; i + expiryBars < candles.length; i++) {
    const slice = candles.slice(0, i + 1);
    const sig = computeSignal(slice);
    if (!sig) continue;
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
  const equity = [];
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
  const winRate = total > 0 ? wins / total * 100 : 0;
  const breakeven = 1 / (1 + payout) * 100;
  return {
    totalTrades: total,
    wins,
    losses: total - wins,
    winRate: Math.round(winRate * 10) / 10,
    profitFactor: grossLoss > 0 ? Math.round(grossWin / grossLoss * 100) / 100 : grossWin > 0 ? 99 : 0,
    maxDrawdown: Math.round(maxDd * 100) / 100,
    netUnits: Math.round(equityNow * 100) / 100,
    payout,
    breakeven: Math.round(breakeven * 10) / 10,
    beatsBreakeven: total > 0 && winRate > breakeven,
    equity
  };
}
function simulatedCandles(seedKey, count, intervalSec) {
  let seed = 2166136261;
  for (let i = 0; i < seedKey.length; i++) {
    seed ^= seedKey.charCodeAt(i);
    seed = Math.imul(seed, 16777619);
  }
  const rand = () => {
    seed = Math.imul(seed ^ seed >>> 15, 2246822507);
    seed = Math.imul(seed ^ seed >>> 13, 3266489909);
    seed ^= seed >>> 16;
    return (seed >>> 0) % 1e5 / 1e5;
  };
  const isJpy = seedKey.includes("JPY");
  let price = isJpy ? 149.5 : seedKey.includes("EURGBP") ? 0.855 : 1.085;
  const vol = isJpy ? 0.045 : 45e-5;
  const now = Math.floor(Date.now() / 1e3);
  const start = now - count * intervalSec;
  const out = [];
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

// src/actions.ts
function defineAction(action) {
  return action;
}
var PAIRS = {
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
  "USD/SGD": "USDSGD=X"
};
var TIMEFRAMES = ["1M", "5M", "15M", "30M", "1H", "4H", "1D"];
var TF_PARAMS = {
  "1M": { range: "1d", interval: "1m", seconds: 60 },
  "5M": { range: "5d", interval: "5m", seconds: 300 },
  "15M": { range: "1mo", interval: "15m", seconds: 900 },
  "30M": { range: "1mo", interval: "30m", seconds: 1800 },
  "1H": { range: "3mo", interval: "1h", seconds: 3600 },
  "4H": { range: "3mo", interval: "1h", seconds: 14400 },
  "1D": { range: "1y", interval: "1d", seconds: 86400 }
};
var TIER_LIMITS = {
  Free: 3,
  Basic: 25,
  Standard: 75,
  Premium: 200,
  Admin: null
  // unlimited
};
var pairEnum = z.enum(Object.keys(PAIRS));
var tfEnum = z.enum(TIMEFRAMES);
var dayRe = /^\d{4}-\d{2}-\d{2}$/;
var UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";
var feedCache = /* @__PURE__ */ new Map();
var CACHE_MS = 3e4;
function aggregate4h(hourly) {
  const out = [];
  let bucket = null;
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
async function fetchFeed(pair, tf) {
  const symbol = PAIRS[pair];
  if (!symbol) throw new Error(`Unknown pair ${pair}`);
  const cacheKey = `${symbol}|${tf}`;
  const hit = feedCache.get(cacheKey);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.data;
  const params = TF_PARAMS[tf];
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${params.range}&interval=${params.interval}`;
  let json;
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": UA, Accept: "application/json" },
      signal: AbortSignal.timeout(15e3)
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    json = await res.json();
  } catch {
    throw new Error("Live market data is unavailable right now. Check your connection and retry, or switch to the simulated demo feed.");
  }
  const root = json;
  const result = root.chart?.result?.[0];
  const timestamps = result?.timestamp ?? [];
  const quote = result?.indicators?.quote?.[0];
  if (!result || !quote || timestamps.length === 0) {
    throw new Error("Live market data is unavailable right now. Check your connection and retry, or switch to the simulated demo feed.");
  }
  let candles = [];
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
  const num = (v, fallback) => typeof v === "number" && Number.isFinite(v) ? v : fallback;
  const last = candles[candles.length - 1];
  const data = {
    candles,
    price: num(meta.regularMarketPrice, last?.close ?? 0),
    prevClose: num(meta.chartPreviousClose, candles[0]?.open ?? 0),
    dayHigh: num(meta.regularMarketDayHigh, Math.max(...candles.slice(-96).map((c) => c.high))),
    dayLow: num(meta.regularMarketDayLow, Math.min(...candles.slice(-96).map((c) => c.low)))
  };
  feedCache.set(cacheKey, { at: Date.now(), data });
  return data;
}
function simulatedFeed(pair, tf) {
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
    dayLow: Math.min(...daySlice.map((c) => c.low))
  };
}
async function getFeed(pair, tf, simulated) {
  if (simulated) return { feed: simulatedFeed(pair, tf), source: "simulated" };
  return { feed: await fetchFeed(pair, tf), source: "live" };
}
async function hashPassword(password, salt) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${salt}:${password}`));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function accountByToken(ctx, token) {
  if (!token) return null;
  const db = ctx.db();
  const rows = await db.select().from("settings").where(eq("key", `session:${token}`)).limit(1);
  const id = rows[0]?.value;
  if (!id) return null;
  const accts = await db.select().from("accounts").where(eq("id", Number(id))).limit(1);
  return accts[0] ?? null;
}
async function usageToday(ctx, accountId, day) {
  const db = ctx.db();
  const rows = await db.select().from("usage_daily").where(and(eq("accountId", accountId), eq("day", day))).limit(1);
  return rows[0]?.signalsUsed ?? 0;
}
async function createSession(ctx, accountId) {
  const db = ctx.db();
  const token = crypto.randomUUID();
  await db.insert("settings").values({ key: `session:${token}`, value: String(accountId) });
  return token;
}
function ownerKeyFor(account, guestId) {
  return account ? `acct:${account.id}` : `guest:${guestId || "anon"}`;
}
async function bumpUsage(ctx, account, guestId, day, by = 1) {
  const db = ctx.db();
  if (account) {
    const used2 = await usageToday(ctx, account.id, day);
    const existing = await db.select().from("usage_daily").where(and(eq("accountId", account.id), eq("day", day))).limit(1);
    if (existing[0]) {
      await db.update("usage_daily").set({ signalsUsed: used2 + by }).where(eq("id", existing[0].id));
    } else {
      await db.insert("usage_daily").values({ accountId: account.id, day, signalsUsed: by });
    }
    return used2 + by;
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
async function guestUsage(ctx, guestId, day) {
  const db = ctx.db();
  const gkey = `guest-usage:${guestId || "anon"}:${day}`;
  const rows = await db.select().from("settings").where(eq("key", gkey)).limit(1);
  return rows[0] ? Number(rows[0].value) || 0 : 0;
}
var calendarCache = null;
function xmlTag(block, tag) {
  const m = block.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
  if (!m || m[1] === void 0) return "";
  return m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").trim();
}
function eventSortKey(e) {
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
async function fetchCalendar() {
  if (calendarCache && Date.now() - calendarCache.at < 10 * 6e4) return calendarCache.events;
  const res = await fetch("https://nfs.faireconomy.media/ff_calendar_thisweek.xml", {
    headers: { "User-Agent": UA, Accept: "application/xml, text/xml" },
    signal: AbortSignal.timeout(15e3)
  });
  if (!res.ok) throw new Error(`Calendar HTTP ${res.status}`);
  const xml = await res.text();
  const blocks = xml.split("<event>").slice(1);
  const events = [];
  for (const b of blocks) {
    const title = xmlTag(b, "title");
    const country = xmlTag(b, "country");
    if (!title || !country) continue;
    events.push({
      title,
      country,
      date: xmlTag(b, "date"),
      time: xmlTag(b, "time") || "\u2014",
      impact: xmlTag(b, "impact") || "Low",
      forecast: xmlTag(b, "forecast"),
      previous: xmlTag(b, "previous")
    });
  }
  if (events.length === 0) throw new Error("Calendar feed returned no events");
  events.sort((a, b) => eventSortKey(a) - eventSortKey(b));
  const cutoff = Date.now() - 12 * 3600 * 1e3;
  const upcoming = events.filter((e) => eventSortKey(e) >= cutoff).slice(0, 120);
  calendarCache = { at: Date.now(), events: upcoming.length > 0 ? upcoming : events.slice(0, 120) };
  return calendarCache.events;
}
var round2 = (v) => Math.round(v * 100) / 100;
function computeSheetRows(capital, payout, targetPct, riskPct, martingale) {
  const perTrade = round2(capital * riskPct / 100);
  const perWin = round2(perTrade * payout / 100);
  const targetAmount = round2(capital * targetPct / 100);
  if (!(perWin > 0)) throw new Error("Per-win amount is zero \u2014 raise the capital, payout, or risk values.");
  const tradesToTarget = Math.ceil(targetAmount / perWin);
  if (tradesToTarget > 5e3) {
    throw new Error("This plan needs more than 5,000 winning trades to reach its target \u2014 raise the risk per trade or lower the target.");
  }
  const martingaleStake = martingale ? round2(perTrade / (payout / 100)) : null;
  const rows = [];
  for (let i = 1; i <= tradesToTarget; i++) {
    rows.push({
      n: i,
      stake: perTrade,
      winAmount: perWin,
      balance: round2(capital + i * perWin),
      martingaleStake
    });
  }
  return { perTrade, perWin, targetAmount, tradesToTarget, martingaleStake, rows };
}
function sheetOut(row) {
  const math = computeSheetRows(row.capital, row.payout, row.targetPct, row.riskPct, row.martingale === 1);
  let rows = [];
  try {
    const parsed = JSON.parse(row.rowsJson);
    if (Array.isArray(parsed)) rows = parsed;
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
    createdAt: row.createdAt.toISOString()
  };
}
var BACKTEST_DEFAULT_PAIRS = [
  "EUR/USD",
  "GBP/USD",
  "USD/JPY",
  "USD/CAD",
  "EUR/AUD",
  "AUD/USD",
  "NZD/USD",
  "EUR/GBP",
  "EUR/JPY",
  "GBP/JPY"
];
var BREAKEVEN_90 = 52.6;
function summarizeTrades(list) {
  let wins = 0;
  let losses = 0;
  let ties = 0;
  for (const t of list) {
    if (t.outcome === "WIN") wins++;
    else if (t.outcome === "LOSS") losses++;
    else ties++;
  }
  const decided = wins + losses;
  const winRate = decided > 0 ? Math.round(wins / decided * 1e3) / 10 : 0;
  return {
    total: list.length,
    wins,
    losses,
    ties,
    winRate,
    beatsBreakeven: decided > 0 && winRate > BREAKEVEN_90
  };
}
var btCache = /* @__PURE__ */ new Map();
async function fetchClosed5m(pair) {
  const symbol = PAIRS[pair];
  if (!symbol) throw new Error(`Unknown pair ${pair}`);
  const hit = btCache.get(symbol);
  if (hit && Date.now() - hit.at < 6e4) return hit.candles;
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1mo&interval=5m`;
  let json;
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": UA, Accept: "application/json" },
      signal: AbortSignal.timeout(2e4)
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    json = await res.json();
  } catch {
    throw new Error("Live market data is unavailable right now. The backtest uses the live Yahoo Finance feed only and never substitutes simulated data \u2014 retry when the feed is reachable.");
  }
  const root = json;
  const result = root.chart?.result?.[0];
  const timestamps = result?.timestamp ?? [];
  const quote = result?.indicators?.quote?.[0];
  if (!result || !quote || timestamps.length === 0) {
    throw new Error("Live market data is unavailable right now. The backtest uses the live Yahoo Finance feed only and never substitutes simulated data \u2014 retry when the feed is reachable.");
  }
  const nowSec = Math.floor(Date.now() / 1e3);
  const candles = [];
  for (let i = 0; i < timestamps.length; i++) {
    const o = quote.open?.[i];
    const h = quote.high?.[i];
    const l = quote.low?.[i];
    const c = quote.close?.[i];
    const t = timestamps[i];
    if (o == null || h == null || l == null || c == null || t == null) continue;
    if (t + 300 > nowSec) continue;
    candles.push({ time: t, open: o, high: h, low: l, close: c });
  }
  candles.sort((a, b) => a.time - b.time);
  btCache.set(symbol, { at: Date.now(), candles });
  return candles;
}
async function produceSignal(ctx, args) {
  const { feed } = await getFeed(args.pair, args.timeframe, args.simulated);
  const signal = computeSignal(feed.candles);
  if (!signal) throw new Error("Not enough candle history to compute a signal for this timeframe yet.");
  const ref = await nextRef(ctx);
  const last = feed.candles[feed.candles.length - 1];
  const takeAtEpoch = (last?.time ?? Math.floor(Date.now() / 1e3)) + TF_PARAMS[args.timeframe].seconds;
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
      outcome: "PENDING"
    });
  }
  return { ref, takeAtEpoch, signal };
}
var accountShape = z.object({
  id: z.number(),
  name: z.string(),
  email: z.string(),
  tier: z.string()
});
var authResponse = z.object({
  ok: z.boolean(),
  message: z.string(),
  token: z.string().nullable(),
  account: accountShape.nullable()
});
function publicAccount(a) {
  return { id: a.id, name: a.name, email: a.email, tier: a.tier };
}
var candleShape = z.object({
  time: z.number(),
  open: z.number(),
  high: z.number(),
  low: z.number(),
  close: z.number()
});
var indicatorShape = z.object({
  id: z.string(),
  name: z.string(),
  value: z.number(),
  vote: z.enum(["CALL", "PUT", "NEUTRAL"]),
  strength: z.number(),
  reading: z.string()
});
var signalShape = z.object({
  direction: z.enum(["CALL", "PUT"]),
  confidence: z.number(),
  agreement: z.number(),
  risk: z.enum(["LOW", "MEDIUM", "HIGH"]),
  callVotes: z.number(),
  putVotes: z.number(),
  indicators: z.array(indicatorShape)
});
var btStatsShape = z.object({
  total: z.number(),
  wins: z.number(),
  losses: z.number(),
  ties: z.number(),
  winRate: z.number(),
  beatsBreakeven: z.boolean()
});
var btWindowShape = z.object({
  pair: z.string(),
  candles: z.number(),
  firstTime: z.number(),
  lastTime: z.number(),
  daysUsed: z.number(),
  error: z.string().nullable()
});
var btTradeShape = z.object({
  pair: z.string(),
  signalTime: z.number(),
  direction: z.enum(["CALL", "PUT"]),
  confidence: z.number(),
  entryPrice: z.number(),
  exitPrice: z.number(),
  outcome: z.enum(["WIN", "LOSS", "TIE"])
});
var sheetShape = z.object({
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
      martingaleStake: z.number().nullable()
    })
  ),
  createdAt: z.string()
});
var Actions = {
  getCandles: defineAction({
    description: "Fetches candles and price context for one pair/timeframe from the live Yahoo Finance feed (server-side proxy), or the labelled simulated feed when requested.",
    request: z.object({
      pair: pairEnum,
      timeframe: tfEnum,
      simulated: z.boolean().default(false)
    }),
    response: z.object({
      source: z.enum(["live", "simulated"]),
      candles: z.array(candleShape),
      price: z.number(),
      prevClose: z.number(),
      changePct: z.number(),
      dayHigh: z.number(),
      dayLow: z.number(),
      dayPosition: z.number()
    }),
    async handler(_ctx, args) {
      const { feed, source } = await getFeed(args.pair, args.timeframe, args.simulated);
      const changePct = feed.prevClose > 0 ? (feed.price - feed.prevClose) / feed.prevClose * 100 : 0;
      const span = feed.dayHigh - feed.dayLow;
      const dayPosition = span > 0 ? Math.min(100, Math.max(0, (feed.price - feed.dayLow) / span * 100)) : 50;
      return {
        source,
        // Cap the payload: the chart only needs the most recent bars.
        candles: feed.candles.slice(-500),
        price: feed.price,
        prevClose: feed.prevClose,
        changePct: Math.round(changePct * 1e3) / 1e3,
        dayHigh: feed.dayHigh,
        dayLow: feed.dayLow,
        dayPosition: Math.round(dayPosition * 10) / 10
      };
    }
  }),
  getAnalyzer: defineAction({
    description: "Returns one indicator's current reading, recent value history, and detail numbers (bands / MACD lines / stochastic %K %D) for the analyzer views.",
    request: z.object({
      pair: pairEnum,
      timeframe: tfEnum,
      indicator: z.enum(["rsi", "bollinger", "macd", "stochastic"]),
      simulated: z.boolean().default(false)
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
      stochD: z.number().nullable()
    }),
    async handler(_ctx, args) {
      const { feed, source } = await getFeed(args.pair, args.timeframe, args.simulated);
      const candles = feed.candles;
      const end = candles.length - 1;
      const closes = candles.map((c) => c.close);
      const reading = latestIndicator(candles, args.indicator);
      const bb = args.indicator === "bollinger" ? bollingerAt(closes, end) : null;
      const macd = args.indicator === "macd" ? macdSeries(closes)[end] : void 0;
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
        stochD: stoch?.d ?? null
      };
    }
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
      record: z.boolean().default(true)
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
      signal: signalShape.nullable()
    }),
    async handler(ctx, args) {
      const account = args.token ? await accountByToken(ctx, args.token) : null;
      const tier = account ? account.tier : "Free";
      const limit = TIER_LIMITS[tier] ?? 3;
      const usedBefore = account ? await usageToday(ctx, account.id, args.day) : await guestUsage(ctx, args.guestId, args.day);
      const quotaReached = limit !== null && usedBefore >= limit;
      const produced = await produceSignal(ctx, {
        pair: args.pair,
        timeframe: args.timeframe,
        simulated: args.simulated,
        record: args.record,
        ownerKey: ownerKeyFor(account, args.guestId),
        pairLabel: args.pairLabel || args.pair
      });
      const usedToday = await bumpUsage(ctx, account, args.guestId, args.day, 1);
      ctx.invalidateQueries();
      return {
        ok: true,
        reason: quotaReached ? `Daily free quota reached (${usedBefore}/${limit}). This free alternative never paywalls generation \u2014 the signal below was still generated and counted.` : null,
        ref: produced.ref,
        takeAtEpoch: produced.takeAtEpoch,
        mode: args.simulated ? "SIMULATED" : "REAL",
        source: args.simulated ? "simulated" : "live",
        usedToday,
        limit,
        tier,
        quotaReached,
        signal: produced.signal
      };
    }
  }),
  generateBatch: defineAction({
    description: "Future Signals: generates one M5 signal per selected OTC market, capped at the requested count (first N in selection order). Each signal is recorded in history and counted toward the daily quota, never hard-blocked.",
    request: z.object({
      pairs: z.array(pairEnum).min(1).max(21),
      count: z.number().int().min(1).max(15),
      simulated: z.boolean().default(false),
      token: z.string().default(""),
      guestId: z.string().default(""),
      day: z.string().regex(dayRe)
    }),
    response: z.object({
      results: z.array(
        z.object({
          pairLabel: z.string(),
          basePair: z.string(),
          ref: z.string().nullable(),
          takeAtEpoch: z.number().nullable(),
          signal: signalShape.nullable(),
          error: z.string().nullable()
        })
      ),
      usedToday: z.number(),
      limit: z.number().nullable(),
      quotaReached: z.boolean()
    }),
    async handler(ctx, args) {
      const account = args.token ? await accountByToken(ctx, args.token) : null;
      const tier = account ? account.tier : "Free";
      const limit = TIER_LIMITS[tier] ?? 3;
      const usedBefore = account ? await usageToday(ctx, account.id, args.day) : await guestUsage(ctx, args.guestId, args.day);
      const ownerKey = ownerKeyFor(account, args.guestId);
      const chosen = args.pairs.slice(0, args.count);
      const results = [];
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
            pairLabel
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
            error: e instanceof Error ? e.message : "Feed unavailable"
          });
        }
      }
      const usedToday = generated > 0 ? await bumpUsage(ctx, account, args.guestId, args.day, generated) : usedBefore;
      ctx.invalidateQueries();
      return { results, usedToday, limit, quotaReached: limit !== null && usedBefore >= limit };
    }
  }),
  listSignalHistory: defineAction({
    description: "Lists the caller's generated-signal history (newest first) with outcomes, plus settled WIN/LOSS counts used for accuracy.",
    request: z.object({
      token: z.string().default(""),
      guestId: z.string().default("")
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
          createdAt: z.string()
        })
      ),
      wins: z.number(),
      losses: z.number(),
      pending: z.number()
    }),
    async handler(ctx, args) {
      const account = args.token ? await accountByToken(ctx, args.token) : null;
      const db = ctx.db();
      const rows = await db.select().from("signal_history").where(eq("ownerKey", ownerKeyFor(account, args.guestId))).orderBy(desc("id")).limit(100);
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
          createdAt: r.createdAt.toISOString()
        })),
        wins: rows.filter((r) => r.outcome === "WIN").length,
        losses: rows.filter((r) => r.outcome === "LOSS").length,
        pending: rows.filter((r) => r.outcome === "PENDING").length
      };
    }
  }),
  setSignalOutcome: defineAction({
    description: "Marks one of the caller's history signals as WIN, LOSS, or back to PENDING.",
    request: z.object({
      token: z.string().default(""),
      guestId: z.string().default(""),
      id: z.number().int().positive(),
      outcome: z.enum(["PENDING", "WIN", "LOSS"])
    }),
    response: z.object({ ok: z.literal(true) }),
    async handler(ctx, args) {
      const account = args.token ? await accountByToken(ctx, args.token) : null;
      const db = ctx.db();
      await db.update("signal_history").set({ outcome: args.outcome }).where(
        and(
          eq("id", args.id),
          eq("ownerKey", ownerKeyFor(account, args.guestId))
        )
      );
      ctx.invalidateQueries();
      return { ok: true };
    }
  }),
  getOverviewStats: defineAction({
    description: "Real paper-trade accuracy for the last 30 days, computed from settled journal entries (signed-in accounts) plus settled signal-history outcomes. Returns accuracy null when nothing is settled yet \u2014 never a static number.",
    request: z.object({
      token: z.string().default(""),
      guestId: z.string().default("")
    }),
    response: z.object({
      wins: z.number(),
      losses: z.number(),
      settled: z.number(),
      accuracy: z.number().nullable(),
      journalSettled: z.number(),
      historySettled: z.number()
    }),
    async handler(ctx, args) {
      const account = args.token ? await accountByToken(ctx, args.token) : null;
      const db = ctx.db();
      const since = new Date(Date.now() - 30 * 24 * 3600 * 1e3);
      let wins = 0;
      let losses = 0;
      let journalSettled = 0;
      if (account) {
        const rows = await db.select().from("journal_entries").where(eq("accountId", account.id)).limit(500);
        for (const r of rows) {
          if (r.createdAt < since || r.outcome === "OPEN") continue;
          journalSettled++;
          if (r.outcome === "WIN") wins++;
          else losses++;
        }
      }
      const hist = await db.select().from("signal_history").where(eq("ownerKey", ownerKeyFor(account, args.guestId))).limit(500);
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
        accuracy: settled > 0 ? Math.round(wins / settled * 1e3) / 10 : null,
        journalSettled,
        historySettled
      };
    }
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
          previous: z.string()
        })
      ),
      strengths: z.array(
        z.object({ pair: z.string(), changePct: z.number() })
      )
    }),
    async handler(_ctx) {
      try {
        const events = await fetchCalendar();
        return {
          source: "calendar",
          note: "Economic calendar: ForexFactory weekly feed (free public XML, no key). Times are US Eastern as published by the feed. High-impact events are when the trading rules say to stay out of the market.",
          events,
          strengths: []
        };
      } catch {
        const strengths = [];
        for (const pair of Object.keys(PAIRS)) {
          try {
            const { feed } = await getFeed(pair, "1D", false);
            const changePct = feed.prevClose > 0 ? (feed.price - feed.prevClose) / feed.prevClose * 100 : 0;
            strengths.push({ pair, changePct: Math.round(changePct * 1e3) / 1e3 });
          } catch {
          }
        }
        strengths.sort((a, b) => b.changePct - a.changePct);
        return {
          source: "strength",
          note: "The free economic-calendar feed is unavailable right now, so this page is built from live market data instead: pairs ranked by 24h change (strongest first). Retry later for the calendar.",
          events: [],
          strengths
        };
      }
    }
  }),
  saveSheet: defineAction({
    description: "Generates and saves a money-management sheet from the plan inputs. Rows are computed server-side: per trade = capital \xD7 risk%, per win = per trade \xD7 payout%, target = capital \xD7 target%, trades = ceil(target \xF7 per win); martingale adds the 1-step recovery stake (per-trade \xF7 payout fraction).",
    request: z.object({
      token: z.string().default(""),
      guestId: z.string().default(""),
      capital: z.number().positive().max(1e7),
      payout: z.number().min(1).max(100),
      targetPct: z.number().positive().max(1e3),
      riskPct: z.number().positive().max(100),
      martingale: z.boolean().default(false)
    }),
    response: sheetShape,
    async handler(ctx, args) {
      const account = args.token ? await accountByToken(ctx, args.token) : null;
      const math = computeSheetRows(args.capital, args.payout, args.targetPct, args.riskPct, args.martingale);
      const db = ctx.db();
      const inserted = await db.insert("management_sheets").values({
        ownerKey: ownerKeyFor(account, args.guestId),
        capital: args.capital,
        payout: args.payout,
        targetPct: args.targetPct,
        riskPct: args.riskPct,
        martingale: args.martingale ? 1 : 0,
        rowsJson: JSON.stringify(math.rows)
      }).returning();
      const row = inserted[0];
      if (!row) throw new Error("Could not save the sheet.");
      ctx.invalidateQueries();
      return sheetOut(row);
    }
  }),
  listSheets: defineAction({
    description: "Lists the caller's saved management sheets, newest first, each with its inputs summary and full trade-by-trade rows.",
    request: z.object({
      token: z.string().default(""),
      guestId: z.string().default("")
    }),
    response: z.object({ sheets: z.array(sheetShape) }),
    async handler(ctx, args) {
      const account = args.token ? await accountByToken(ctx, args.token) : null;
      const db = ctx.db();
      const rows = await db.select().from("management_sheets").where(eq("ownerKey", ownerKeyFor(account, args.guestId))).orderBy(desc("id")).limit(50);
      return { sheets: rows.map(sheetOut) };
    }
  }),
  deleteSheet: defineAction({
    description: "Deletes one of the caller's saved management sheets.",
    request: z.object({
      token: z.string().default(""),
      guestId: z.string().default(""),
      id: z.number().int().positive()
    }),
    response: z.object({ ok: z.literal(true) }),
    async handler(ctx, args) {
      const account = args.token ? await accountByToken(ctx, args.token) : null;
      const db = ctx.db();
      await db.delete("management_sheets").where(
        and(
          eq("id", args.id),
          eq("ownerKey", ownerKeyFor(account, args.guestId))
        )
      );
      ctx.invalidateQueries();
      return { ok: true };
    }
  }),
  getConfluence: defineAction({
    description: "Computes the 4-indicator signal for one pair on every timeframe at once (multi-timeframe confluence panel). Does not consume signal-generation quota.",
    request: z.object({
      pair: pairEnum,
      simulated: z.boolean().default(false)
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
          error: z.string().nullable()
        })
      ),
      callCount: z.number(),
      putCount: z.number()
    }),
    async handler(_ctx, args) {
      const rows = [];
      let source = args.simulated ? "simulated" : "live";
      for (const tf of TIMEFRAMES) {
        try {
          const got = await getFeed(args.pair, tf, args.simulated);
          source = got.source;
          const sig = computeSignal(got.feed.candles);
          if (!sig) {
            rows.push({ timeframe: tf, direction: null, confidence: null, agreement: null, risk: null, callVotes: 0, putVotes: 0, error: "Not enough history" });
          } else if (sig.callVotes === 0 && sig.putVotes === 0) {
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
              error: null
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
            error: e instanceof Error ? e.message : "Feed unavailable"
          });
        }
      }
      return {
        source,
        rows,
        callCount: rows.filter((r) => r.direction === "CALL").length,
        putCount: rows.filter((r) => r.direction === "PUT").length
      };
    }
  }),
  runBacktestAction: defineAction({
    description: "Runs the honest walk-forward backtest of the 4-indicator signal rule on a pair/timeframe and returns win rate, profit factor, max drawdown and the breakeven comparison for the chosen payout.",
    request: z.object({
      pair: pairEnum,
      timeframe: tfEnum,
      expiryBars: z.number().int().min(1).max(20).default(5),
      payout: z.number().min(0.5).max(0.99).default(0.9),
      simulated: z.boolean().default(false)
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
      equity: z.array(z.object({ time: z.number(), value: z.number() }))
    }),
    async handler(_ctx, args) {
      const { feed, source } = await getFeed(args.pair, args.timeframe, args.simulated);
      const bt = runBacktest(feed.candles, args.expiryBars, args.payout);
      const step = Math.max(1, Math.floor(bt.equity.length / 160));
      const equity = bt.equity.filter((_, i) => i % step === 0 || i === bt.equity.length - 1);
      return { source, candlesUsed: feed.candles.length, ...bt, equity };
    }
  }),
  runBacktest: defineAction({
    description: "Deterministic, read-only backtest of the 4-indicator signal engine over finalized historical 5-minute Yahoo Finance candles: each signal is computed once from candles up to the signal candle only, entry is the next candle's open, settlement the next candle's close. Returns overall and min-confidence stats vs the 52.6% breakeven, per-pair and confidence-bucket breakdowns, the actual data window per pair, and the full trade list. Writes nothing.",
    request: z.object({
      pairs: z.array(pairEnum).min(1).max(21).default([...BACKTEST_DEFAULT_PAIRS]),
      timeframe: z.enum(["5M"]).default("5M"),
      days: z.number().int().min(1).max(30).default(14),
      minConfidence: z.number().int().min(0).max(100).default(60)
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
          error: z.string().nullable()
        })
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
          winRate: z.number()
        })
      ),
      windows: z.array(btWindowShape),
      totalCandles: z.number(),
      trades: z.array(btTradeShape)
    }),
    async handler(_ctx, args) {
      const pairs = [...new Set(args.pairs)];
      const trades = [];
      const windows = [];
      const perPair = [];
      for (const pair of pairs) {
        let candles = [];
        let error = null;
        try {
          const all = await fetchClosed5m(pair);
          const lastAll = all[all.length - 1];
          if (!lastAll) throw new Error("No finalized candles returned for this pair.");
          const cutoff = lastAll.time - args.days * 86400;
          candles = all.filter((c) => c.time >= cutoff);
          if (candles.length < 62) {
            error = `Only ${candles.length} finalized candles available for this pair in the requested window \u2014 not enough to run the engine.`;
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
          daysUsed: first && lastC ? Math.round((lastC.time - first.time) / 86400 * 10) / 10 : 0,
          error
        };
        windows.push(win);
        const pairTrades = [];
        if (!error) {
          const warmup = 60;
          for (let i = warmup; i < candles.length - 1; i++) {
            const sig = computeSignal(candles.slice(0, i + 1));
            if (!sig) continue;
            const signalCandle = candles[i];
            const next = candles[i + 1];
            if (!signalCandle || !next) continue;
            const entryPrice = next.open;
            const exitPrice = next.close;
            let outcome = "TIE";
            if (exitPrice > entryPrice) outcome = sig.direction === "CALL" ? "WIN" : "LOSS";
            else if (exitPrice < entryPrice) outcome = sig.direction === "PUT" ? "WIN" : "LOSS";
            pairTrades.push({
              pair,
              signalTime: signalCandle.time,
              direction: sig.direction,
              confidence: sig.confidence,
              entryPrice,
              exitPrice,
              outcome
            });
          }
        }
        trades.push(...pairTrades);
        const s = summarizeTrades(pairTrades);
        perPair.push({ ...win, trades: s.total, wins: s.wins, losses: s.losses, ties: s.ties, winRate: s.winRate });
      }
      if (windows.length > 0 && windows.every((w) => w.error !== null) && trades.length === 0) {
        throw new Error("Live market data is unavailable right now. The backtest uses the live Yahoo Finance feed only and never substitutes simulated data \u2014 check your connection and retry.");
      }
      const overall = summarizeTrades(trades);
      const subset = summarizeTrades(trades.filter((t) => t.confidence >= args.minConfidence));
      const bucketDefs = [
        { label: "60\u201369", min: 60, max: 69 },
        { label: "70\u201379", min: 70, max: 79 },
        { label: "80+", min: 80, max: null }
      ];
      const buckets = bucketDefs.map((d) => {
        const s = summarizeTrades(
          trades.filter((t) => t.confidence >= d.min && (d.max === null || t.confidence <= d.max))
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
        trades
      };
    }
  }),
  signUp: defineAction({
    description: "Creates a local demo account (full name, email, password) starting on the Free tier. Local only \u2014 no external auth service, no billing.",
    request: z.object({
      name: z.string().trim().min(2).max(80),
      email: z.string().trim().max(120).regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/, "Enter a valid email address"),
      password: z.string().min(6).max(72)
    }),
    response: authResponse,
    async handler(ctx, args) {
      const db = ctx.db();
      const email = args.email.toLowerCase();
      const existing = await db.select().from("accounts").where(eq("email", email)).limit(1);
      if (existing[0]) {
        return { ok: false, message: "An account with this email already exists. Sign in instead.", token: null, account: null };
      }
      const salt = crypto.randomUUID();
      const passwordHash = await hashPassword(args.password, salt);
      const inserted = await db.insert("accounts").values({ name: args.name, email, passwordHash, salt, tier: "Free" }).returning();
      const acct = inserted[0];
      if (!acct) throw new Error("Could not create the account. Please retry.");
      const token = await createSession(ctx, acct.id);
      ctx.invalidateQueries();
      return { ok: true, message: "Account created. You are on the Free tier.", token, account: publicAccount(acct) };
    }
  }),
  signIn: defineAction({
    description: "Signs in to a local demo account with email and password.",
    request: z.object({
      email: z.string().trim().max(120),
      password: z.string().min(1).max(72)
    }),
    response: authResponse,
    async handler(ctx, args) {
      const db = ctx.db();
      const rows = await db.select().from("accounts").where(eq("email", args.email.toLowerCase())).limit(1);
      const acct = rows[0];
      if (!acct) return { ok: false, message: "No account found for this email.", token: null, account: null };
      const hash = await hashPassword(args.password, acct.salt);
      if (hash !== acct.passwordHash) return { ok: false, message: "Incorrect password.", token: null, account: null };
      const token = await createSession(ctx, acct.id);
      return { ok: true, message: `Welcome back, ${acct.name}.`, token, account: publicAccount(acct) };
    }
  }),
  getSession: defineAction({
    description: "Returns the signed-in account and today's signal usage for a session token, or a null account for guests.",
    request: z.object({
      token: z.string().default(""),
      guestId: z.string().default(""),
      day: z.string().regex(dayRe)
    }),
    response: z.object({
      account: accountShape.nullable(),
      tier: z.string(),
      limit: z.number().nullable(),
      usedToday: z.number()
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
    }
  }),
  setTier: defineAction({
    description: "Changes the signed-in account's subscription tier (demo setting \u2014 no billing, nothing is charged).",
    request: z.object({
      token: z.string().min(1),
      tier: z.enum(["Free", "Basic", "Standard", "Premium", "Admin"])
    }),
    response: z.object({ ok: z.boolean(), tier: z.string(), limit: z.number().nullable() }),
    async handler(ctx, args) {
      const account = await accountByToken(ctx, args.token);
      if (!account) throw new Error("Please sign in first.");
      const db = ctx.db();
      await db.update("accounts").set({ tier: args.tier }).where(eq("id", account.id));
      ctx.invalidateQueries();
      return { ok: true, tier: args.tier, limit: TIER_LIMITS[args.tier] ?? null };
    }
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
          createdAt: z.string()
        })
      ),
      totalPnl: z.number(),
      wins: z.number(),
      losses: z.number(),
      open: z.number()
    }),
    async handler(ctx, args) {
      const account = await accountByToken(ctx, args.token);
      if (!account) throw new Error("Please sign in to use the paper-trading journal.");
      const db = ctx.db();
      const rows = await db.select().from("journal_entries").where(eq("accountId", account.id)).orderBy(desc("id")).limit(200);
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
        createdAt: r.createdAt.toISOString()
      }));
      return {
        entries,
        totalPnl: Math.round(rows.reduce((s, r) => s + r.pnl, 0) * 100) / 100,
        wins: rows.filter((r) => r.outcome === "WIN").length,
        losses: rows.filter((r) => r.outcome === "LOSS").length,
        open: rows.filter((r) => r.outcome === "OPEN").length
      };
    }
  }),
  addJournalEntry: defineAction({
    description: "Logs a paper trade (demo units only \u2014 no real money, no broker) to the signed-in account's journal.",
    request: z.object({
      token: z.string().min(1),
      pair: pairEnum,
      timeframe: tfEnum,
      direction: z.enum(["CALL", "PUT"]),
      entryPrice: z.number().positive().max(1e5),
      stake: z.number().positive().max(1e5).default(10),
      expiry: z.string().trim().min(1).max(20).default("5 min"),
      mode: z.enum(["REAL", "SIMULATED"]).default("REAL")
    }),
    response: z.object({ id: z.number() }),
    async handler(ctx, args) {
      const account = await accountByToken(ctx, args.token);
      if (!account) throw new Error("Please sign in to use the paper-trading journal.");
      const db = ctx.db();
      const inserted = await db.insert("journal_entries").values({
        accountId: account.id,
        pair: args.pair,
        timeframe: args.timeframe,
        direction: args.direction,
        entryPrice: args.entryPrice,
        stake: args.stake,
        expiry: args.expiry,
        mode: args.mode,
        outcome: "OPEN",
        pnl: 0
      }).returning({ id: "id" });
      const row = inserted[0];
      if (!row) throw new Error("Could not save the journal entry.");
      ctx.invalidateQueries();
      return { id: row.id };
    }
  }),
  settleJournalEntry: defineAction({
    description: "Settles an open paper trade as WIN or LOSS at a given exit price; P&L uses the standard 90% demo payout (win = +0.9 \xD7 stake, loss = \u2212stake).",
    request: z.object({
      token: z.string().min(1),
      id: z.number().int().positive(),
      outcome: z.enum(["WIN", "LOSS"]),
      exitPrice: z.number().positive().max(1e5)
    }),
    response: z.object({ ok: z.literal(true), pnl: z.number() }),
    async handler(ctx, args) {
      const account = await accountByToken(ctx, args.token);
      if (!account) throw new Error("Please sign in to use the paper-trading journal.");
      const db = ctx.db();
      const rows = await db.select().from("journal_entries").where(and(eq("id", args.id), eq("accountId", account.id))).limit(1);
      const entry = rows[0];
      if (!entry) throw new Error("Journal entry not found.");
      if (entry.outcome !== "OPEN") throw new Error("This entry is already settled.");
      const pnl = args.outcome === "WIN" ? Math.round(entry.stake * 0.9 * 100) / 100 : -entry.stake;
      await db.update("journal_entries").set({ outcome: args.outcome, exitPrice: args.exitPrice, pnl }).where(eq("id", entry.id));
      ctx.invalidateQueries();
      return { ok: true, pnl };
    }
  }),
  deleteJournalEntry: defineAction({
    description: "Deletes one of the signed-in account's journal entries.",
    request: z.object({ token: z.string().min(1), id: z.number().int().positive() }),
    response: z.object({ ok: z.literal(true) }),
    async handler(ctx, args) {
      const account = await accountByToken(ctx, args.token);
      if (!account) throw new Error("Please sign in to use the paper-trading journal.");
      const db = ctx.db();
      await db.delete("journal_entries").where(and(eq("id", args.id), eq("accountId", account.id)));
      ctx.invalidateQueries();
      return { ok: true };
    }
  })
};
async function nextRef(ctx) {
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
async function dispatchAction(body) {
  try {
    if (!body || typeof body !== "object") {
      throw new Error("Expected a JSON body {action, args}.");
    }
    const { action, args } = body;
    if (typeof action !== "string" || !(action in Actions)) {
      throw new Error(`Unknown action: ${String(action)}`);
    }
    const def = Actions[action];
    const parsedArgs = def.request.parse(args ?? {});
    await ensureDb();
    const ctx = createCtx();
    const result = await def.handler(ctx, parsedArgs);
    const data = def.response.parse(result);
    return { data };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Action failed." };
  }
}
async function readJsonBody(req) {
  if (req.body !== void 0) return req.body;
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : {};
}
async function handler(req, res) {
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
export {
  Actions,
  BACKTEST_DEFAULT_PAIRS,
  PAIRS,
  TIER_LIMITS,
  TIMEFRAMES,
  computeSheetRows,
  handler as default,
  dispatchAction
};
