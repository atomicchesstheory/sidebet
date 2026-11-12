import { z } from "zod";
import { signIn } from "@/lib/server/auth";
import { handle } from "@/lib/server/http";

const Body = z.object({ login: z.string().min(1).max(200), password: z.string().min(1).max(200) });

export async function POST(req: Request) {
  return handle(async () => {
    const b = Body.parse(await req.json());
    await signIn(b.login, b.password);
  });
}
