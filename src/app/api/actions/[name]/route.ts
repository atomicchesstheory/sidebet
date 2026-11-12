import { runAction } from "@/lib/server/actions";
import { handle } from "@/lib/server/http";

export async function POST(req: Request, ctx: { params: Promise<{ name: string }> }) {
  const { name } = await ctx.params;
  return handle(async () => runAction(name, await req.json().catch(() => ({}))));
}
