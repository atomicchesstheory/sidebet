import { z } from "zod";
import { signUp } from "@/lib/server/auth";
import { handle } from "@/lib/server/http";

const Body = z.object({
  username: z.string().min(3).max(24),
  password: z.string().min(8).max(200),
  display_name: z.string().max(40).default(""),
  email: z.string().email().max(200).optional(),
});

export async function POST(req: Request) {
  return handle(async () => {
    const b = Body.parse(await req.json());
    return signUp({ username: b.username, password: b.password, displayName: b.display_name.trim(), email: b.email });
  });
}
