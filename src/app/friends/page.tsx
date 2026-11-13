import { redirect } from "next/navigation";
import { FriendsScreen } from "@/components/friends/friends-screen";
import { getSessionUser } from "@/lib/server/auth";
import { listFriends } from "@/lib/server/friends";

export const metadata = { title: "Friends" };

export default async function FriendsPage() {
  const user = await getSessionUser();
  if (!user) redirect("/signin?next=/friends");
  return <FriendsScreen initial={await listFriends(user.id)} />;
}
