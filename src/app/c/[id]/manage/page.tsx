import Link from "next/link";
import { redirect } from "next/navigation";
import { ManageScreen } from "@/components/manual/manage-screen";
import { Empty } from "@/components/ui";
import { getSessionUser } from "@/lib/server/auth";
import { isAppError } from "@/lib/server/errors";
import { getManageView, type ManageView } from "@/lib/server/manual";

export const metadata = { title: "Run your bet" };

export default async function ManagePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await getSessionUser();
  if (!user) redirect(`/signin?next=/c/${id}/manage`);
  if (!/^[0-9a-f-]{36}$/.test(id)) return <Empty title="Contest not found" />;
  let data: ManageView | null = null;
  try {
    data = await getManageView(user.id, id);
  } catch (e) {
    if (!isAppError(e)) throw e;
  }
  if (!data) {
    return (
      <Empty title="Only the organizer can manage this">
        <Link href={`/c/${id}`} className="link">Back to the contest</Link>
      </Empty>
    );
  }
  if (!data.view.contest.manual && user.is_admin) redirect(`/admin/c/${id}`);
  return <ManageScreen data={data} />;
}
