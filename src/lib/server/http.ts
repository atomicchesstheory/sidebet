import { NextResponse } from "next/server";
import { isAppError, mapDbError } from "./errors";
import { ensureReady } from "./ready";

export function errorResponse(e: unknown) {
  const err = mapDbError(e);
  if (isAppError(err)) {
    return NextResponse.json({ error: { code: err.code, message: err.message } }, { status: err.status });
  }
  if (err && typeof err === "object" && "issues" in err) {
    return NextResponse.json({ error: { code: "validation", message: "Invalid input." } }, { status: 400 });
  }
  console.error("[side-bet]", err);
  return NextResponse.json({ error: { code: "server_error", message: "Something went wrong. Try again." } }, { status: 500 });
}

export async function handle(fn: () => Promise<unknown>) {
  try {
    await ensureReady();
    const data = await fn();
    return NextResponse.json({ ok: true, data: data ?? null });
  } catch (e) {
    return errorResponse(e);
  }
}
