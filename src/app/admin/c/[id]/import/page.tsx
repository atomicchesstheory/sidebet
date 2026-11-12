import { redirect } from "next/navigation";
import { DraftImport } from "@/components/admin/draft-import";
import { Empty } from "@/components/ui";
import { getSessionUser } from "@/lib/server/auth";
import { getContestView } from "@/lib/server/contests";

export const metadata = { title: "Import draft" };

export default async function ImportDraft({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await getSessionUser();
  if (!user) redirect(`/signin?next=/admin/c/${id}/import`);
  if (!user.is_admin) return <Empty title="Admins only" />;
  const view = await getContestView(user.id, id);
  if (view.contest.kind !== "draft") return <Empty title="Not a draft contest" />;
  if (view.entrants.length < 2) return <Empty title="Waiting for entrants">Both entrants need to join (and stake chips) before you load rosters. Share the invite link from the Setup tab.</Empty>;
  return <DraftImport view={view} />;
}
