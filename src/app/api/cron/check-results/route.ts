import { NextResponse } from "next/server";
import { config } from "@/lib/server/config";
import { errorResponse } from "@/lib/server/http";
import { ensureReady } from "@/lib/server/ready";
import { runScheduledChecks } from "@/lib/server/results/pipeline";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** Scheduled result checks. Vercel Cron / GitHub Actions call this with `Authorization: Bearer $CRON_SECRET`. */
export async function GET(req: Request) {
  if (!config.cronSecret || req.headers.get("authorization") !== `Bearer ${config.cronSecret}`) {
    return NextResponse.json({ error: { code: "forbidden", message: "Bad or missing cron secret." } }, { status: 401 });
  }
  try {
    await ensureReady();
    const results = await runScheduledChecks();
    return NextResponse.json({ ok: true, checked: results.length, results });
  } catch (e) {
    return errorResponse(e);
  }
}
