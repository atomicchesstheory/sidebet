import { redirect } from "next/navigation";
import { AchievementsScreen } from "@/components/achievements-screen";
import { getSessionUser } from "@/lib/server/auth";
import { listAchievements } from "@/lib/server/achievements";
import { getWalletSummary } from "@/lib/server/wallet";

export const metadata = { title: "Achievements" };

export default async function AchievementsPage() {
  const user = await getSessionUser();
  if (!user) redirect("/signin?next=/achievements");
  const [data, wallet] = await Promise.all([listAchievements(user.id), getWalletSummary(user.id)]);
  return <AchievementsScreen initial={data} balance={wallet.balance} />;
}
