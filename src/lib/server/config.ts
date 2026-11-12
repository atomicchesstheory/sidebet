import "server-only";

/**
 * Two modes:
 *  - "supabase": DATABASE_URL + Supabase Auth + Supabase Realtime (production).
 *  - "demo": in-process PGlite database, local username/password accounts,
 *    server-sent events for live updates. Clearly labeled in the UI.
 */
const env = process.env;

export const config = {
  // POSTGRES_URL is what the Vercel ↔ Supabase integration sets automatically.
  mode: (env.DATABASE_URL || env.POSTGRES_URL ? "supabase" : "demo") as "supabase" | "demo",
  databaseUrl: env.DATABASE_URL || env.POSTGRES_URL || "",
  supabaseUrl: env.NEXT_PUBLIC_SUPABASE_URL ?? "",
  supabaseAnonKey: env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "",
  sessionSecret: env.SESSION_SECRET || "sidebet-demo-session-secret-change-me",
  cronSecret: env.CRON_SECRET ?? "",
  pgliteDir: env.PGLITE_DIR || (env.VERCEL ? "/tmp/sidebet-pglite" : ".data/pglite"),
  adminUsernames: (env.ADMIN_USERNAMES ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
  /** Optional comma-separated allowlist for result source hosts. Empty = any public host. */
  allowedSourceHosts: (env.ALLOWED_SOURCE_HOSTS ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
  localScheduler: env.SIDEBET_LOCAL_SCHEDULER !== "0",
  schedulerIntervalSeconds: Number(env.SIDEBET_CHECK_INTERVAL_SECONDS || 300),
};

export function assertConfig() {
  if (config.mode === "supabase" && (!config.supabaseUrl || !config.supabaseAnonKey)) {
    throw new Error("DATABASE_URL is set, so NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY are required too.");
  }
  if (config.mode === "supabase" && config.sessionSecret.startsWith("sidebet-demo")) {
    // Not used for Supabase sessions, but never ship the default secret.
  }
}
