import { getAdminContest } from "@/lib/server/admin";
import { requireAdmin } from "@/lib/server/auth";
import { getContestView } from "@/lib/server/contests";
import { handle } from "@/lib/server/http";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return handle(async () => {
    const u = await requireAdmin();
    return { view: await getContestView(u.id, id), admin: await getAdminContest(u.id, id) };
  });
}
