// TradeLens persistence adapter for the Vercel port.
//
// Replaces the Hatch artifact's Drizzle/SQLite `ctx.db()` with a small
// JSON-table store that speaks the same query subset the actions use
// (select/insert/update/delete with eq/and/desc, .returning()).
//
// Storage backends:
//  - Vercel Blob when BLOB_READ_WRITE_TOKEN is set (production): one
//    private JSON blob per table at `tradelens-db/<table>.json`, written
//    with put(addRandomSuffix:false) and read via head() + signed URL.
//    The token is only ever read by @vercel/blob from process.env —
//    this file never logs or returns it.
//  - Local JSON files otherwise (dev/test only): TRADELANSL_DB_DIR, or
//    ./data next to the project ( /tmp/tradelens-db on Vercel, where the
//    function filesystem is read-only).
//
// Single-user app: read-modify-write per mutation, saves serialised
// through a queue. Rows keep `createdAt` as a Date in memory (revived
// from ISO strings on load).

import { head, put } from "@vercel/blob";
import { promises as fs } from "node:fs";
import path from "node:path";

// ---------- row types (mirror server/src/schema.ts) ----------

export interface AccountRow {
  id: number;
  name: string;
  email: string;
  passwordHash: string;
  salt: string;
  tier: "Free" | "Basic" | "Standard" | "Premium" | "Admin";
  createdAt: Date;
}

export interface JournalEntryRow {
  id: number;
  accountId: number;
  pair: string;
  timeframe: string;
  direction: "CALL" | "PUT";
  entryPrice: number;
  exitPrice: number | null;
  stake: number;
  expiry: string;
  outcome: "OPEN" | "WIN" | "LOSS";
  pnl: number;
  mode: "REAL" | "SIMULATED";
  createdAt: Date;
}

export interface UsageDailyRow {
  id: number;
  accountId: number;
  day: string;
  signalsUsed: number;
}

export interface SettingsRow {
  key: string;
  value: string;
}

export interface SignalHistoryRow {
  id: number;
  ownerKey: string;
  ref: string;
  pairLabel: string;
  basePair: string;
  timeframe: string;
  direction: "CALL" | "PUT";
  confidence: number;
  outcome: "PENDING" | "WIN" | "LOSS";
  createdAt: Date;
}

export interface ManagementSheetRow {
  id: number;
  ownerKey: string;
  capital: number;
  payout: number;
  targetPct: number;
  riskPct: number;
  martingale: number; // 0/1
  rowsJson: string;
  createdAt: Date;
}

export interface Tables {
  accounts: AccountRow;
  journal_entries: JournalEntryRow;
  usage_daily: UsageDailyRow;
  settings: SettingsRow;
  signal_history: SignalHistoryRow;
  management_sheets: ManagementSheetRow;
}

export type TableName = keyof Tables;
export type Row = Tables[TableName];

const TABLE_NAMES: TableName[] = [
  "accounts",
  "journal_entries",
  "usage_daily",
  "settings",
  "signal_history",
  "management_sheets",
];

// Tables with an auto-increment integer id (settings is keyed by `key`).
const AUTO_ID: ReadonlySet<TableName> = new Set([
  "accounts",
  "journal_entries",
  "usage_daily",
  "signal_history",
  "management_sheets",
]);

// Tables whose rows carry a createdAt Date (defaulted on insert).
const HAS_CREATED_AT: ReadonlySet<TableName> = new Set([
  "accounts",
  "journal_entries",
  "signal_history",
  "management_sheets",
]);

const BLOB_PREFIX = "tradelens-db";

// ---------- query helpers (Drizzle-subset) ----------

export function eq<C extends string, V>(
  col: C,
  value: V,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): (row: any) => boolean {
  return (row) => row[col] === value;
}

export function and(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ...preds: Array<(row: any) => boolean>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): (row: any) => boolean {
  return (row) => preds.every((p) => p(row));
}

export function desc<C extends string>(col: C): { col: C; dir: -1 } {
  return { col, dir: -1 };
}

// ---------- query builders (thenable, like Drizzle) ----------

type Predicate<T> = (row: T) => boolean;

export class SelectBuilder<T extends TableName> {
  private pred: Predicate<Tables[T]> | null = null;
  private order: { col: keyof Tables[T]; dir: 1 | -1 } | null = null;
  private limitN: number | null = null;

  constructor(
    private readonly db: Db,
    private readonly table: T,
  ) {}

  where(pred: Predicate<Tables[T]>): this {
    this.pred = pred;
    return this;
  }

  orderBy(o: { col: keyof Tables[T]; dir: 1 | -1 }): this {
    this.order = o;
    return this;
  }

  limit(n: number): this {
    this.limitN = n;
    return this;
  }

  async exec(): Promise<Tables[T][]> {
    let rows = [...this.db.rows(this.table)];
    if (this.pred) rows = rows.filter(this.pred);
    if (this.order) {
      const { col, dir } = this.order;
      rows.sort((a, b) => {
        const av = a[col] as number | string;
        const bv = b[col] as number | string;
        if (av < bv) return -dir;
        if (av > bv) return dir;
        return 0;
      });
    }
    if (this.limitN !== null) rows = rows.slice(0, this.limitN);
    return rows;
  }

  then<TResult1 = Tables[T][], TResult2 = never>(
    onfulfilled?: ((value: Tables[T][]) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    return this.exec().then(onfulfilled, onrejected);
  }
}

export class InsertBuilder<T extends TableName> {
  private _values: Partial<Tables[T]> | null = null;
  private done: Promise<Tables[T][] | Array<Record<string, unknown>>> | null = null;

  constructor(
    private readonly db: Db,
    private readonly table: T,
  ) {}

  values(v: Partial<Tables[T]>): this {
    this._values = v;
    return this;
  }

  returning(): Promise<Tables[T][]>;
  returning<M extends Record<string, keyof Tables[T]>>(
    map: M,
  ): Promise<Array<{ [K in keyof M]: Tables[T][M[K]] }>>;
  returning(
    map?: Record<string, keyof Tables[T]>,
  ): Promise<Tables[T][] | Array<Record<string, unknown>>> {
    if (!this.done) this.done = this.run(map);
    return this.done;
  }

  private async run(
    map?: Record<string, keyof Tables[T]>,
  ): Promise<Tables[T][] | Array<Record<string, unknown>>> {
    const row = this.db.insertRow(this.table, this._values ?? {});
    await this.db.persist(this.table);
    if (!map) return [row];
    const out: Record<string, unknown> = {};
    for (const [k, col] of Object.entries(map)) out[k] = row[col];
    return [out];
  }

  then<TResult1 = Tables[T][], TResult2 = never>(
    onfulfilled?: ((value: Tables[T][]) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    return this.returning().then(onfulfilled as never, onrejected);
  }
}

export class UpdateBuilder<T extends TableName> {
  private patch: Partial<Tables[T]> | null = null;
  private pred: Predicate<Tables[T]> | null = null;
  private done: Promise<number> | null = null;

  constructor(
    private readonly db: Db,
    private readonly table: T,
  ) {}

  set(patch: Partial<Tables[T]>): this {
    this.patch = patch;
    return this;
  }

  where(pred: Predicate<Tables[T]>): this {
    this.pred = pred;
    return this;
  }

  async exec(): Promise<number> {
    if (!this.done) {
      this.done = (async () => {
        const n = this.db.updateRows(this.table, this.pred, this.patch ?? {});
        if (n > 0) await this.db.persist(this.table);
        return n;
      })();
    }
    return this.done;
  }

  then<TResult1 = number, TResult2 = never>(
    onfulfilled?: ((value: number) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    return this.exec().then(onfulfilled, onrejected);
  }
}

export class DeleteBuilder<T extends TableName> {
  private pred: Predicate<Tables[T]> | null = null;
  private done: Promise<number> | null = null;

  constructor(
    private readonly db: Db,
    private readonly table: T,
  ) {}

  where(pred: Predicate<Tables[T]>): this {
    this.pred = pred;
    return this;
  }

  async exec(): Promise<number> {
    if (!this.done) {
      this.done = (async () => {
        const n = this.db.deleteRows(this.table, this.pred);
        if (n > 0) await this.db.persist(this.table);
        return n;
      })();
    }
    return this.done;
  }

  then<TResult1 = number, TResult2 = never>(
    onfulfilled?: ((value: number) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    return this.exec().then(onfulfilled, onrejected);
  }
}

// ---------- the store ----------

export class Db {
  private data: Record<TableName, Row[]> = {
    accounts: [],
    journal_entries: [],
    usage_daily: [],
    settings: [],
    signal_history: [],
    management_sheets: [],
  };
  private loaded = false;
  private saveQueue: Promise<void> = Promise.resolve();

  get useBlob(): boolean {
    return Boolean(process.env.BLOB_READ_WRITE_TOKEN);
  }

  localDir(): string {
    if (process.env.TRADELANSL_DB_DIR) return process.env.TRADELANSL_DB_DIR;
    if (process.env.VERCEL) return "/tmp/tradelens-db";
    return path.join(process.cwd(), "data");
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    for (const table of TABLE_NAMES) {
      this.data[table] = await this.readTable(table);
    }
    this.loaded = true;
  }

  rows<T extends TableName>(table: T): Tables[T][] {
    return this.data[table] as Tables[T][];
  }

  select(): { from: <T extends TableName>(table: T) => SelectBuilder<T> } {
    return { from: <T extends TableName>(table: T) => new SelectBuilder<T>(this, table) };
  }

  insert<T extends TableName>(table: T): InsertBuilder<T> {
    return new InsertBuilder<T>(this, table);
  }

  update<T extends TableName>(table: T): UpdateBuilder<T> {
    return new UpdateBuilder<T>(this, table);
  }

  delete<T extends TableName>(table: T): DeleteBuilder<T> {
    return new DeleteBuilder<T>(this, table);
  }

  insertRow<T extends TableName>(table: T, values: Partial<Tables[T]>): Tables[T] {
    const row = { ...values } as Record<string, unknown>;
    if (AUTO_ID.has(table)) {
      const rows = this.data[table] as Array<{ id?: number }>;
      const maxId = rows.reduce((m, r) => Math.max(m, r.id ?? 0), 0);
      row.id = maxId + 1;
    }
    if (HAS_CREATED_AT.has(table) && row.createdAt === undefined) {
      row.createdAt = new Date();
    }
    // Known nullable/default fields.
    if (table === "journal_entries" && row.exitPrice === undefined) row.exitPrice = null;
    this.data[table].push(row as unknown as Row);
    return row as unknown as Tables[T];
  }

  updateRows<T extends TableName>(
    table: T,
    pred: Predicate<Tables[T]> | null,
    patch: Partial<Tables[T]>,
  ): number {
    let n = 0;
    for (const row of this.data[table] as Tables[T][]) {
      if (pred && !pred(row)) continue;
      Object.assign(row, patch);
      n++;
    }
    return n;
  }

  deleteRows<T extends TableName>(table: T, pred: Predicate<Tables[T]> | null): number {
    const before = this.data[table].length;
    this.data[table] = (this.data[table] as Tables[T][]).filter((r) => !(pred ? pred(r) : true));
    return before - this.data[table].length;
  }

  async persist(table: TableName): Promise<void> {
    const run = async () => {
      if (this.useBlob) await this.writeBlob(table);
      else await this.writeFile(table);
    };
    this.saveQueue = this.saveQueue.then(run, run);
    await this.saveQueue;
  }

  // ----- backends -----

  private blobPath(table: TableName): string {
    return `${BLOB_PREFIX}/${table}.json`;
  }

  private revive(table: TableName, raw: unknown[]): Row[] {
    if (!Array.isArray(raw)) return [];
    return raw.map((r) => {
      const row = { ...(r as Record<string, unknown>) };
      if (HAS_CREATED_AT.has(table) && typeof row.createdAt === "string") {
        row.createdAt = new Date(row.createdAt);
      }
      return row as unknown as Row;
    });
  }

  private async readTable(table: TableName): Promise<Row[]> {
    if (this.useBlob) {
      try {
        const meta = await head(this.blobPath(table));
        const res = await fetch(meta.downloadUrl);
        if (!res.ok) return [];
        return this.revive(table, (await res.json()) as unknown[]);
      } catch {
        // Missing blob (or unreadable) → empty table.
        return [];
      }
    }
    try {
      const text = await fs.readFile(path.join(this.localDir(), `${table}.json`), "utf8");
      return this.revive(table, JSON.parse(text) as unknown[]);
    } catch {
      return [];
    }
  }

  private async writeBlob(table: TableName): Promise<void> {
    await put(this.blobPath(table), JSON.stringify(this.data[table]), {
      access: "private",
      addRandomSuffix: false,
    });
  }

  private async writeFile(table: TableName): Promise<void> {
    const dir = this.localDir();
    await fs.mkdir(dir, { recursive: true });
    const tmp = path.join(dir, `.${table}.json.tmp`);
    await fs.writeFile(tmp, JSON.stringify(this.data[table]), "utf8");
    await fs.rename(tmp, path.join(dir, `${table}.json`));
  }
}

// ---------- singleton ----------

let dbInstance: Db | null = null;
let loadPromise: Promise<Db> | null = null;

/** Loads the store once per process (Blob or local files). */
export function ensureDb(): Promise<Db> {
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

/** Synchronous accessor — only valid after `await ensureDb()`. */
export function getDb(): Db {
  if (!dbInstance) throw new Error("Database not loaded — call ensureDb() first.");
  return dbInstance;
}

/** Handler context shape (replaces the Hatch SDK Ctx). */
export interface Ctx {
  db: () => Db;
  invalidateQueries: () => void;
}

export function createCtx(): Ctx {
  return { db: getDb, invalidateQueries: () => {} };
}
