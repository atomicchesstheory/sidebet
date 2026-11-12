import Link from "next/link";
import { redirect } from "next/navigation";
import { DraftRoom } from "@/components/contest/draft-room";
import { Empty } from "@/components/ui";
import { getSessionUser } from "@/lib/server/auth";
import { findContestView } from "@/lib/server/contests";

export const metadata = { title: "Live draft" };

export default async function DraftPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await getSessionUser();
  if (!user) redirect(`/signin?next=/c/${id}/draft`);
  const view = await findContestView(user.id, id);
  if (!view) return <Empty title="Contest not found">It&apos;s private or doesn&apos;t exist.</Empty>;
  if (view.contest.kind !== "draft" || !view.draft) {
    return <Empty title="Not a draft">This contest doesn&apos;t have a draft board. <Link className="link" href={`/c/${id}`}>Back</Link></Empty>;
  }
  return <DraftRoom initial={view} />;
}
