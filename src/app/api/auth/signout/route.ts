import { signOut } from "@/lib/server/auth";
import { handle } from "@/lib/server/http";

export async function POST() {
  return handle(() => signOut());
}
