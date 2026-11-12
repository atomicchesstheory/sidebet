import { config } from "./config";
import { getDb } from "./db";

const g = globalThis as unknown as { __sidebetReady?: Promise<void>; __sidebetTimer?: NodeJS.Timeout };

/** Open the database, seed demo data on first run (demo mode) and start the local scheduler. */
export function ensureReady(): Promise<void> {
  g.__sidebetReady ??= (async () => {
    await getDb();
    if (config.mode === "demo") {
      const { ensureDemoSeed } = await import("./seed");
      await ensureDemoSeed();
    }
    startLocalScheduler();
  })().catch((e) => {
    g.__sidebetReady = undefined;
    throw e;
  });
  return g.__sidebetReady;
}

/** Local/dev scheduler. On Vercel, use the cron route instead (see README). */
function startLocalScheduler() {
  if (!config.localScheduler || process.env.VERCEL || g.__sidebetTimer || process.env.VITEST) return;
  g.__sidebetTimer = setInterval(async () => {
    try {
      const { runScheduledChecks } = await import("./results/pipeline");
      await runScheduledChecks();
    } catch (e) {
      console.error("[side-bet] scheduled check failed", e);
    }
  }, Math.max(30, config.schedulerIntervalSeconds) * 1000);
  g.__sidebetTimer.unref?.();
}
