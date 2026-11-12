import { requireUser } from "@/lib/server/auth";
import { getContestView } from "@/lib/server/contests";
import { errorResponse } from "@/lib/server/http";
import { onContest } from "@/lib/server/live";
import { ensureReady } from "@/lib/server/ready";

export const dynamic = "force-dynamic";

/**
 * Demo-mode live updates (server-sent events). Access is checked before the
 * stream opens; events carry no contest data — clients re-fetch the view,
 * which applies pick visibility.
 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  try {
    await ensureReady();
    const u = await requireUser();
    await getContestView(u.id, id); // throws if the user can't see this contest
  } catch (e) {
    return errorResponse(e);
  }
  const enc = new TextEncoder();
  let cleanup = () => {};
  const stream = new ReadableStream({
    start(controller) {
      const send = (s: string) => {
        try {
          controller.enqueue(enc.encode(s));
        } catch {
          cleanup();
        }
      };
      send("retry: 3000\nevent: hello\ndata: {}\n\n");
      const off = onContest(id, () => send(`event: change\ndata: ${Date.now()}\n\n`));
      const ka = setInterval(() => send(": keepalive\n\n"), 20_000);
      cleanup = () => {
        off();
        clearInterval(ka);
      };
      req.signal.addEventListener("abort", () => {
        cleanup();
        try {
          controller.close();
        } catch {}
      });
    },
    cancel() {
      cleanup();
    },
  });
  return new Response(stream, {
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform", connection: "keep-alive" },
  });
}
