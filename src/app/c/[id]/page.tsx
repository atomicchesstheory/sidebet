import Link from "next/link";
import { redirect } from "next/navigation";
import { ContestScreen } from "@/components/contest/contest-screen";
import { Empty } from "@/components/ui";
import { getSessionUser } from "@/lib/server/auth";
import { findContestView } from "@/lib/server/contests";

export default async function ContestPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await getSessionUser();
  if (!user) redirect(`/signin?next=/c/${id}`);
  const view = await findContestView(user.id, id);
  if (!view) {
    return (
      <Empty title="Contest not found">
        It doesn&apos;t exist, or it&apos;s private and you haven&apos;t been invited. Ask the commish for an invite link. <Link href="/browse" className="link">Browse public contests</Link>.
      </Empty>
    );
  }
  return <ContestScreen initial={view} />;
}
