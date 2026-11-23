// Local end-to-end test for the TradeLens Vercel port.
// Runs every action through dispatchAction (the same code path the Vercel
// HTTP handler uses) against the LOCAL JSON-file DB fallback (no Blob token).
// Usage:  TRADELANSL_DB_DIR=./data bun ./test-local.ts
// Exits non-zero if any check fails.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { dispatchAction, default as handler } from "./src/actions";
import { calibrateConfidence, CALIBRATION_BANDS } from "./src/_lib/indicators";

type CallResult = { data?: unknown; error?: string };

let failures = 0;
let passes = 0;

function check(name: string, cond: boolean, extra = ""): void {
  if (cond) {
    passes++;
    console.log(`  PASS ${name}${extra ? ` — ${extra}` : ""}`);
  } else {
    failures++;
    console.log(`  FAIL ${name}${extra ? ` — ${extra}` : ""}`);
  }
}

async function call(action: string, args: Record<string, unknown> = {}): Promise<CallResult> {
  return dispatchAction({ action, args, actionCallId: `test-${action}` });
}

function asObj(v: unknown): Record<string, unknown> {
  return (v ?? {}) as Record<string, unknown>;
}

// The client passes today's date (YYYY-MM-DD) for quota counting.
const today = () => new Date().toISOString().slice(0, 10);

console.log("== TradeLens Vercel port — local end-to-end test ==");
console.log(`DB dir: ${process.env.TRADELANSL_DB_DIR ?? "(default)"}`);

// ---------- auth ----------
console.log("\n[auth]");
const signUp = await call("signUp", {
  name: "Test User",
  email: "test@example.com",
  password: "correct-horse-battery",
});
check("signUp succeeds", !signUp.error && !!asObj(signUp.data).token, signUp.error ?? "");
const token = asObj(signUp.data).token as string;

const dup = await call("signUp", {
  name: "Test User",
  email: "test@example.com",
  password: "correct-horse-battery",
});
check("duplicate signUp rejected (ok:false)", !dup.error && asObj(dup.data).ok === false);

const signInBad = await call("signIn", { email: "test@example.com", password: "wrong" });
check(
  "signIn wrong password rejected (ok:false)",
  !signInBad.error && asObj(signInBad.data).ok === false,
);

const signIn = await call("signIn", { email: "test@example.com", password: "correct-horse-battery" });
check("signIn succeeds", !signIn.error && asObj(signIn.data).ok === true, signIn.error ?? "");
const token2 = asObj(signIn.data).token as string;
check("signIn returns a token", typeof token2 === "string" && token2.length > 10);

const session = await call("getSession", { token, day: today() });
check(
  "getSession returns account",
  !session.error && asObj(asObj(session.data).account).email === "test@example.com",
  session.error ?? "",
);
check("getSession default tier Free", asObj(session.data).tier === "Free");

const setTier = await call("setTier", { token, tier: "Premium" });
check("setTier Premium", !setTier.error && asObj(setTier.data).tier === "Premium", setTier.error ?? "");
const sessionPro = await call("getSession", { token, day: today() });
check("getSession tier now Premium", asObj(sessionPro.data).tier === "Premium");

const badSession = await call("getSession", { token: "no-such-token", day: today() });
check(
  "getSession bad token -> account null",
  !badSession.error && asObj(badSession.data).account === null,
);

// ---------- market data (live Yahoo) ----------
console.log("\n[market data — live Yahoo Finance]");
const candles = await call("getCandles", { pair: "EUR/USD", timeframe: "5M" });
const candleData = asObj(candles.data);
check("getCandles succeeds", !candles.error, candles.error ?? "");
const candleList = candleData.candles as Array<Record<string, unknown>>;
check("getCandles returns >=100 candles", Array.isArray(candleList) && candleList.length >= 100, `n=${candleList.length}`);
console.log(`  INFO getCandles source=${candleData.source} price=${candleData.price}`);

const analyzer = await call("getAnalyzer", { pair: "EUR/USD", timeframe: "5M", indicator: "rsi" });
check("getAnalyzer (rsi) succeeds", !analyzer.error, analyzer.error ?? "");
check(
  "getAnalyzer returns history",
  Array.isArray(asObj(analyzer.data).history) && (asObj(analyzer.data).history as unknown[]).length > 0,
);

// ---------- signals ----------
console.log("\n[signals]");
let recordedSignalId: number | null = null;
let recordedRef = "";
const pairsToTry = ["EUR/USD", "GBP/USD", "USD/JPY", "AUD/USD", "EUR/JPY"];
for (const pair of pairsToTry) {
  const sig = await call("generateSignal", { pair, timeframe: "5M", record: true, token, day: today() });
  if (sig.error) {
    console.log(`  INFO generateSignal ${pair} error: ${sig.error}`);
    continue;
  }
  const sigData = asObj(sig.data);
  const signal = sigData.signal as Record<string, unknown> | null;
  if (signal) {
    // The history reference lives on the outer response (`ref`), not on the
    // signal object (signalShape has no id field — original behaviour).
    recordedRef = String(sigData.ref ?? "");
    console.log(
      `  INFO generateSignal ${pair}: ${signal.direction} conf=${signal.confidence} ref=${recordedRef} usedToday=${sigData.usedToday}`,
    );
    // The live signal carries its calibrated observed win rate (honest labelling).
    const expected = calibrateConfidence(Number(signal.confidence));
    check(
      "generateSignal response carries calibration fields",
      "calibratedWinRate" in signal && "calibrationSample" in signal,
      `calibratedWinRate=${String(signal.calibratedWinRate)} sample=${String(signal.calibrationSample)}`,
    );
    check(
      "response calibration matches the frozen map for its band",
      signal.calibratedWinRate === expected.observedWinRate &&
        signal.calibrationSample === expected.sampleSize,
      `conf=${signal.confidence} -> ${String(signal.calibratedWinRate)} (n=${String(signal.calibrationSample)})`,
    );
    break;
  }
  console.log(`  INFO generateSignal ${pair}: no signal (null)`);
}
check("generateSignal produced a recordable signal", recordedRef !== "");

// ---------- confidence calibration (honest labelling) ----------
console.log("\n[calibration]");
{
  const c = calibrateConfidence;
  const cases: Array<[number, number | null, number]> = [
    [35, 50.2, 33906],
    [49, 50.2, 33906],
    [50, 49.6, 3116],
    [62, 52.3, 4254],
    [67, 51.4, 4536],
    [72, 51.2, 2257],
    [77, 52.0, 898],
    [82, 50.0, 256],
    [90, null, 58], // n < 100: not enough data, never a fabricated rate
    [97, null, 58],
  ];
  for (const [score, rate, n] of cases) {
    const got = c(score);
    check(
      `calibrateConfidence(${score}) -> ${rate === null ? "null" : rate + "%"} (n=${n})`,
      got.observedWinRate === rate && got.sampleSize === n,
      `got ${String(got.observedWinRate)} (n=${got.sampleSize})`,
    );
  }
  // The frozen map covers every possible score 5..97 and no band beats breakeven.
  const covered = CALIBRATION_BANDS.every((b) => b.observedWinRate === null || b.observedWinRate <= 52.6);
  check("no calibration band beats the 52.6% breakeven", covered);
  const totalSample = CALIBRATION_BANDS.reduce((s, b) => s + b.sampleSize, 0);
  check("calibration sample totals the measured backtest (52,871 decided)", totalSample === 52871, `total=${totalSample}`);
}

const history = await call("listSignalHistory", { token, limit: 10 });
const entries = asObj(history.data).entries as Array<Record<string, unknown>>;
check("listSignalHistory returns entries", !history.error && Array.isArray(entries) && entries.length >= 1, history.error ?? "");
if (entries.length > 0) {
  recordedSignalId = entries[0].id as number;
  // setSignalOutcome matches on (id, ownerKey) — the token is required so
  // the outcome update actually lands on the caller's own row.
  const outcome = await call("setSignalOutcome", { token, id: recordedSignalId, outcome: "WIN" });
  check("setSignalOutcome WIN", !outcome.error && asObj(outcome.data).ok === true, outcome.error ?? "");
  // Verify the outcome actually persisted to the local JSON file (not just
  // an in-memory {ok:true}).
  const histFile = await readFile(
    join(process.env.TRADELANSL_DB_DIR ?? "./data", "signal_history.json"),
    "utf8",
  );
  const histRows = JSON.parse(histFile) as Array<Record<string, unknown>>;
  const targetRow = histRows.find((r) => r.id === recordedSignalId);
  check("setSignalOutcome persisted to file (WIN)", targetRow?.outcome === "WIN", JSON.stringify(targetRow));
}

const batch = await call("generateBatch", {
  pairs: ["EUR/USD", "GBP/USD", "USD/JPY"],
  count: 3,
  timeframe: "5M",
  token,
  day: today(),
});
const batchData = asObj(batch.data);
check(
  "generateBatch returns 3 results",
  !batch.error && Array.isArray(batchData.results) && (batchData.results as unknown[]).length === 3,
  batch.error ?? "",
);

const stats = await call("getOverviewStats", { token });
const statsData = asObj(stats.data);
check(
  "getOverviewStats succeeds",
  !stats.error && typeof statsData.settled === "number",
  stats.error ?? "",
);
console.log(`  INFO overview: settled=${statsData.settled} wins=${statsData.wins} losses=${statsData.losses} accuracy=${statsData.accuracy}`);

const confluence = await call("getConfluence", { pair: "EUR/USD", token });
check("getConfluence succeeds", !confluence.error, confluence.error ?? "");
check(
  "getConfluence returns rows",
  Array.isArray(asObj(confluence.data).rows) && (asObj(confluence.data).rows as unknown[]).length > 0,
);

// ---------- news ----------
console.log("\n[news]");
const news = await call("getNews", {});
check("getNews succeeds", !news.error, news.error ?? "");
check("getNews returns events array", Array.isArray(asObj(news.data).events));

// ---------- management sheets (math check) ----------
console.log("\n[management sheets]");
const sheet = await call("saveSheet", {
  token,
  capital: 100,
  payout: 80,
  targetPct: 20,
  riskPct: 2,
  martingale: false,
});
const sheetData = asObj(sheet.data);
check("saveSheet succeeds", !sheet.error, sheet.error ?? "");
check("sheet perTrade = $2.00", sheetData.perTrade === 2, `got ${sheetData.perTrade}`);
check("sheet perWin = $1.60", sheetData.perWin === 1.6, `got ${sheetData.perWin}`);
check("sheet targetAmount = $20.00", sheetData.targetAmount === 20, `got ${sheetData.targetAmount}`);
check("sheet tradesToTarget = 13", sheetData.tradesToTarget === 13, `got ${sheetData.tradesToTarget}`);
const sheetId = sheetData.id as number;

const sheets = await call("listSheets", { token });
const sheetList = asObj(sheets.data).sheets as Array<Record<string, unknown>>;
check("listSheets contains saved sheet", sheetList.some((s) => s.id === sheetId));
const delSheet = await call("deleteSheet", { token, id: sheetId });
check("deleteSheet ok", !delSheet.error && asObj(delSheet.data).ok === true, delSheet.error ?? "");
const sheetsAfter = await call("listSheets", { token });
check(
  "listSheets empty after delete",
  (asObj(sheetsAfter.data).sheets as unknown[]).length === 0,
);

// ---------- backtest (smoke) ----------
// runBacktestAction = single-pair walk-forward (pair/timeframe/expiryBars/payout).
console.log("\n[backtest — smoke, single pair EUR/USD 5M]");
const bt = await call("runBacktestAction", {
  pair: "EUR/USD",
  timeframe: "5M",
});
const btData = asObj(bt.data);
check("runBacktestAction succeeds", !bt.error, bt.error ?? "");
check(
  "runBacktestAction totalTrades > 0",
  typeof btData.totalTrades === "number" && (btData.totalTrades as number) > 0,
  `totalTrades=${btData.totalTrades}`,
);
console.log(
  `  INFO walk-forward EUR/USD: trades=${btData.totalTrades} wins=${btData.wins} losses=${btData.losses} winRate=${btData.winRate}% breakeven=${btData.breakeven}% beatsBreakeven=${btData.beatsBreakeven}`,
);
check(
  "runBacktestAction breakeven ~52.6 @ 90%",
  typeof btData.breakeven === "number" && (btData.breakeven as number) >= 52 && (btData.breakeven as number) <= 53,
  `got ${btData.breakeven}`,
);
check("runBacktestAction equity curve present", Array.isArray(btData.equity));

// runBacktest = multi-pair deterministic backtest (pairs/days/minConfidence).
console.log("\n[backtest — deterministic, 1 pair, 2 days, minConf 60]");
const bt2 = await call("runBacktest", {
  pairs: ["EUR/USD"],
  timeframe: "5M",
  days: 2,
  minConfidence: 60,
});
const bt2Data = asObj(bt2.data);
check("runBacktest succeeds", !bt2.error, bt2.error ?? "");
const overall = asObj(bt2Data.overall);
check(
  "runBacktest overall has trades",
  typeof overall.total === "number" && (overall.total as number) > 0,
  `total=${overall.total}`,
);
console.log(
  `  INFO deterministic 2d EUR/USD: total=${overall.total} wins=${overall.wins} losses=${overall.losses} ties=${overall.ties} winRate=${overall.winRate}% breakeven=${bt2Data.breakeven}%`,
);
check("runBacktest breakeven = 52.6", bt2Data.breakeven === 52.6, `got ${bt2Data.breakeven}`);
check("runBacktest perPair present", Array.isArray(bt2Data.perPair));
check("runBacktest buckets present", Array.isArray(bt2Data.buckets));
check("runBacktest trade list present", Array.isArray(bt2Data.trades));

// ---------- journal ----------
console.log("\n[journal]");
const journalBefore = await call("listJournal", { token });
check(
  "listJournal starts empty",
  (asObj(journalBefore.data).entries as unknown[]).length === 0,
);
const entry = await call("addJournalEntry", {
  token,
  pair: "EUR/USD",
  timeframe: "5M",
  direction: "CALL",
  entryPrice: 1.08,
  stake: 10,
  expiry: "5 min",
  mode: "SIMULATED",
});
const entryData = asObj(entry.data);
check("addJournalEntry succeeds", !entry.error && typeof entryData.id === "number", entry.error ?? "");
const entryId = entryData.id as number;
const journalAfter = await call("listJournal", { token });
check(
  "listJournal has 1 entry",
  (asObj(journalAfter.data).entries as unknown[]).length === 1,
);
const settle = await call("settleJournalEntry", { token, id: entryId, outcome: "WIN", exitPrice: 1.09 });
check(
  "settleJournalEntry WIN pnl = +9 (0.9 x 10)",
  !settle.error && asObj(settle.data).pnl === 9,
  `got ${JSON.stringify(settle.data)}`,
);
const delEntry = await call("deleteJournalEntry", { token, id: entryId });
check("deleteJournalEntry ok", !delEntry.error && asObj(delEntry.data).ok === true, delEntry.error ?? "");
const journalEnd = await call("listJournal", { token });
check(
  "listJournal empty after delete",
  (asObj(journalEnd.data).entries as unknown[]).length === 0,
);

// ---------- error paths ----------
console.log("\n[error paths]");
const unknown = await call("noSuchAction", {});
check("unknown action -> error", !!unknown.error, JSON.stringify(unknown));
const badArgs = await call("getCandles", { pair: "NOT/A-PAIR", timeframe: "5M" });
check("invalid args -> error", !!badArgs.error, JSON.stringify(badArgs));

// ---------- HTTP handler (Vercel entry point) ----------
console.log("\n[HTTP handler]");
const mockReq = {
  method: "POST",
  body: { action: "getCandles", args: { pair: "EUR/USD", timeframe: "5M" }, actionCallId: "http-test" },
};
let httpStatus = 0;
let httpBody: unknown = null;
const mockRes = {
  status(code: number) {
    httpStatus = code;
    return this;
  },
  json(body: unknown) {
    httpBody = body;
  },
};
await handler(mockReq as never, mockRes as never);
check("HTTP handler returns 200", httpStatus === 200, `got ${httpStatus}`);
check(
  "HTTP handler returns {data} with candles",
  !!httpBody && Array.isArray(asObj(asObj(httpBody).data).candles),
  JSON.stringify(httpBody)?.slice(0, 200),
);

console.log(`\n== RESULT: ${passes} passed, ${failures} failed ==`);
if (failures > 0) process.exit(1);
