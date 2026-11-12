import { redirect } from "next/navigation";
import { AdminConsole } from "@/components/admin/admin-console";
import { Empty } from "@/components/ui";
import { getAdminContest } from "@/lib/server/admin";
import { getSessionUser } from "@/lib/server/auth";
import { findContestView } from "@/lib/server/contests";

export const metadata = { title: "Manage contest" };

export default async function ManageContest({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ tab?: string }> }) {
  const { id } = await params;
  const { tab } = await searchParams;
  const user = await getSessionUser();
  if (!user) redirect(`/signin?next=/admin/c/${id}`);
  if (!user.is_admin) return <Empty title="Admins only" />;
  const view = await findContestView(user.id, id);
  if (!view) return <Empty title="Contest not found" />;
  const admin = JSON.parse(JSON.stringify(await getAdminContest(user.id, id)));
  const t = (["setup", "scoring", "results", "review", "settle"] as const).find((x) => x === tab) ?? "setup";
  return <AdminConsole initial={{ view, admin }} initialTab={t} />;
}
