/**
 * True concurrency against a real PostgreSQL server (PGlite serializes
 * queries, so it can't prove row-lock behaviour). Uses `embedded-postgres`;
 * skipped automatically if the binary can't start on this machine.
 *   npm run test:concurrency
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { migrationFiles } from "@/lib/server/db";

let server: { stop: () => Promise<void> } | null = null;
let pool: pg.Pool;
let available = false;
const PORT = 54329;

beforeAll(async () => {
  try {
    const { default: EmbeddedPostgres } = await import("embedded-postgres");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sidebet-pg-"));
    const s = new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "postgres", port: PORT, persistent: false });
    await s.initialise();
    await s.start();
    server = s;
    pool = new pg.Pool({ connectionString: `postgres://postgres:postgres@localhost:${PORT}/postgres`, max: 20 });
    for (const m of migrationFiles(true)) await pool.query(m.sql);
    available = true;
  } catch (e) {
    console.warn("embedded-postgres unavailable, skipping:", (e as Error).message);
  }
}, 180_000);

afterAll(async () => {
  await pool?.end().catch(() => {});
  await server?.stop().catch(() => {});
});

async function asUser<T>(uid: string, sql: string, params: unknown[] = []): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query("begin");
    await c.query("set local role authenticated");
    await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: uid, role: "authenticated" })]);
    const r = await c.query(sql, params);
    await c.query("commit");
    return r.rows as T;
  } catch (e) {
    await c.query("rollback").catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}
const outcome = (p: Promise<unknown>) => p.then(() => "ok", (e: Error) => e.message);

async function newUser(name: string) {
  const r = await pool.query("insert into auth.users (raw_user_meta_data) values ($1::jsonb) returning id", [JSON.stringify({ username: name })]);
  return r.rows[0].id as string;
}

describe("real Postgres, parallel connections", () => {
  it("20 simultaneous claims grant exactly once", async (ctx) => {
    if (!available) return ctx.skip();
    const u = await newUser("racer");
    const res = await Promise.all(Array.from({ length: 20 }, () => outcome(asUser(u, "select public.claim_chips()"))));
    expect(res.filter((r) => r === "ok")).toHaveLength(1);
    const { rows } = await pool.query("select balance from public.wallets where user_id = $1", [u]);
    expect(rows[0].balance).toBe(510);
  });

  it("20 simultaneous joins charge once", async (ctx) => {
    if (!available) return ctx.skip();
    const admin = await newUser("boss");
    await pool.query("update public.profiles set is_admin = true where id = $1", [admin]);
    const [c] = await asUser<{ id: string }[]>(admin, "insert into public.contests (kind, title, visibility, stake, payout_rule) values ('bet','Race test','public',25,'equal_split_winners') returning id");
    await asUser(admin, "insert into public.contest_outcomes (contest_id, label) values ($1,'A'),($1,'B')", [c.id]);
    await asUser(admin, "select public.admin_set_status($1,'open')", [c.id]);
    const [o] = await asUser<{ id: string }[]>(admin, "select id from public.contest_outcomes where contest_id = $1 limit 1", [c.id]);
    const u = await newUser("joiner");
    const res = await Promise.all(Array.from({ length: 20 }, () => outcome(asUser(u, "select public.join_contest($1,$2)", [c.id, o.id]))));
    expect(res.every((r) => r === "ok")).toBe(true);
    const { rows } = await pool.query("select (select balance from public.wallets where user_id = $1) as bal, (select count(*)::int from public.entries where user_id = $1) as n", [u]);
    expect(rows[0]).toEqual({ bal: 475, n: 1 });
  });

  it("two drafters racing for the same pick: one wins", async (ctx) => {
    if (!available) return ctx.skip();
    const admin = await newUser("boss2");
    await pool.query("update public.profiles set is_admin = true where id = $1", [admin]);
    const [c] = await asUser<{ id: string }[]>(admin, "insert into public.contests (kind, title, visibility, stake, payout_rule, roster_size, draft_format, draft_mode) values ('draft','Draft race','public',0,'winner_take_all',2,'snake','live') returning id");
    await asUser(admin, "insert into public.pool_items (contest_id, name) values ($1,'P1'),($1,'P2'),($1,'P3'),($1,'P4')", [c.id]);
    await pool.query("begin; select set_config('sidebet.internal','on',true); insert into public.scoring_rulesets (contest_id, version, instructions, rules, status) values ($1,1,'x','{}','approved'); commit;".replace("$1", `'${c.id}'`));
    await asUser(admin, "select public.admin_set_status($1,'open')", [c.id]);
    const a = await newUser("drafter_a");
    const b = await newUser("drafter_b");
    await asUser(a, "select public.join_contest($1)", [c.id]);
    await asUser(b, "select public.join_contest($1)", [c.id]);
    await asUser(admin, "select public.start_draft($1)", [c.id]);
    const [p] = await asUser<{ id: string }[]>(admin, "select id from public.pool_items where contest_id = $1 and name = 'P1'", [c.id]);
    // a (on the clock) double-submits pick 1; b tries out of turn; admin also tries the same pick
    const res = await Promise.all([
      outcome(asUser(a, "select public.make_draft_pick($1,$2,1)", [c.id, p.id])),
      outcome(asUser(a, "select public.make_draft_pick($1,$2,1)", [c.id, p.id])),
      outcome(asUser(b, "select public.make_draft_pick($1,$2)", [c.id, p.id])),
      outcome(asUser(admin, "select public.make_draft_pick($1,$2,1)", [c.id, p.id])),
    ]);
    expect(res.filter((r) => r === "ok")).toHaveLength(1);
    const { rows } = await pool.query("select count(*)::int as n from public.draft_picks where contest_id = $1", [c.id]);
    expect(rows[0].n).toBe(1);
  });
});
