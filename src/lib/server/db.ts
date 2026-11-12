import fs from "node:fs";
import path from "node:path";
import { config } from "./config";
import { mapDbError } from "./errors";

/* eslint-disable @typescript-eslint/no-explicit-any */
export type Row = Record<string, any>;
export interface Q {
  query<T = Row>(text: string, params?: unknown[]): Promise<T[]>;
}
export interface Db extends Q {
  kind: "pglite" | "pg";
  transaction<T>(fn: (tx: Q) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

const g = globalThis as unknown as { __sidebetDb?: Promise<Db>; __sidebetDbFactory?: () => Promise<Db> };

function sqlDir() {
  return path.join(process.cwd(), "supabase");
}

export function migrationFiles(includeShim: boolean): { name: string; sql: string }[] {
  const out: { name: string; sql: string }[] = [];
  if (includeShim) {
    const shim = path.join(sqlDir(), "shim", "0000_local_auth_shim.sql");
    out.push({ name: "0000_local_auth_shim", sql: fs.readFileSync(shim, "utf8") });
  }
  const dir = path.join(sqlDir(), "migrations");
  for (const f of fs.readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    out.push({ name: f.replace(/\.sql$/, ""), sql: fs.readFileSync(path.join(dir, f), "utf8") });
  }
  return out;
}

export async function runMigrations(db: { exec(sql: string): Promise<unknown>; query: Q["query"] }, includeShim: boolean) {
  await db.exec(
    "create schema if not exists sidebet_private; create table if not exists sidebet_private.migrations (name text primary key, applied_at timestamptz not null default now());",
  );
  const done = new Set((await db.query<{ name: string }>("select name from sidebet_private.migrations")).map((r) => r.name));
  const applied: string[] = [];
  for (const m of migrationFiles(includeShim)) {
    if (done.has(m.name)) continue;
    await db.exec(m.sql);
    await db.query("insert into sidebet_private.migrations (name) values ($1) on conflict do nothing", [m.name]);
    applied.push(m.name);
  }
  return applied;
}

export async function createPgliteDb(dataDir: string): Promise<Db> {
  const { PGlite } = await import("@electric-sql/pglite");
  if (!dataDir.startsWith("memory://")) fs.mkdirSync(dataDir, { recursive: true });
  const pg = new PGlite(dataDir);
  await pg.waitReady;
  const exec = (sql: string) => pg.exec(sql);
  const query = async <T = Row>(text: string, params?: unknown[]) => {
    try {
      return (await pg.query<T>(text, params as any[])).rows;
    } catch (e) {
      throw mapDbError(e);
    }
  };
  await runMigrations({ exec, query }, true);
  return {
    kind: "pglite",
    query,
    async transaction<T>(fn: (tx: Q) => Promise<T>) {
      try {
        return await pg.transaction(async (tx) => {
          const q: Q = { query: async (t, p) => (await tx.query<any>(t, p as any[])).rows };
          return fn(q);
        });
      } catch (e) {
        throw mapDbError(e);
      }
    },
    close: () => pg.close(),
  };
}

export async function createPgDb(url: string): Promise<Db> {
  const { default: pgmod } = await import("pg");
  // numeric -> number, bigint (counts) -> number
  pgmod.types.setTypeParser(1700, (v: string) => Number(v));
  pgmod.types.setTypeParser(20, (v: string) => Number(v));
  const local = /localhost|127\.0\.0\.1/.test(url);
  // Strip sslmode/supa params from the URL (they'd override our ssl settings and
  // fail on Supabase's certificate chain); encrypt with our own ssl option instead.
  const u = new URL(url);
  for (const k of ["sslmode", "supa", "pgbouncer"]) u.searchParams.delete(k);
  const pool = new pgmod.Pool({ connectionString: u.toString(), max: 5, ssl: local ? undefined : { rejectUnauthorized: false } });
  const query = async <T = Row>(text: string, params?: unknown[]) => {
    try {
      return (await pool.query(text, params as any[])).rows as T[];
    } catch (e) {
      throw mapDbError(e);
    }
  };
  return {
    kind: "pg",
    query,
    async transaction<T>(fn: (tx: Q) => Promise<T>) {
      const client = await pool.connect();
      try {
        await client.query("begin");
        const res = await fn({ query: async (t, p) => (await client.query(t, p as any[])).rows });
        await client.query("commit");
        return res;
      } catch (e) {
        await client.query("rollback").catch(() => {});
        throw mapDbError(e);
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}

/** Test hook: swap the database (e.g. an in-memory PGlite). */
export function setDbFactory(f: (() => Promise<Db>) | undefined) {
  g.__sidebetDbFactory = f;
  g.__sidebetDb = undefined;
}

export function getDb(): Promise<Db> {
  if (!g.__sidebetDb) {
    const factory =
      g.__sidebetDbFactory ??
      (async () => {
        if (config.mode === "supabase") return createPgDb(config.databaseUrl);
        return createPgliteDb(config.pgliteDir);
      });
    g.__sidebetDb = factory().catch((e) => {
      g.__sidebetDb = undefined;
      throw e;
    });
  }
  return g.__sidebetDb;
}

// numeric columns come back as strings from PGlite; normalize at the edges.
export const num = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));

/** Run as the signed-in user: role `authenticated`, RLS on, auth.uid() set. */
export async function asUser<T>(userId: string | null, fn: (q: Q) => Promise<T>): Promise<T> {
  const db = await getDb();
  return db.transaction(async (tx) => {
    await tx.query(userId ? "set local role authenticated" : "set local role anon");
    await tx.query("select set_config('request.jwt.claims', $1, true)", [
      JSON.stringify(userId ? { sub: userId, role: "authenticated" } : { role: "anon" }),
    ]);
    return fn(tx);
  });
}

/** Run as the server (table owner). Only for app-controlled pipeline/settlement work. */
export async function asService<T>(fn: (q: Q) => Promise<T>): Promise<T> {
  const db = await getDb();
  return db.transaction(fn);
}
