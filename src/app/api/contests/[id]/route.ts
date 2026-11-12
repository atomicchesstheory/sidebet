import { requireUser } from "@/lib/server/auth";
import { getContestView } from "@/lib/server/contests";
import { handle } from "@/lib/server/http";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return handle(async () => getContestView((await requireUser()).id, id));
}
