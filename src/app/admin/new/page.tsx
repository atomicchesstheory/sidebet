import { redirect } from "next/navigation";
import { NewContestForm } from "@/components/admin/new-contest-form";
import { Empty } from "@/components/ui";
import { getSessionUser } from "@/lib/server/auth";
import { listRequests } from "@/lib/server/profiles";

export const metadata = { title: "New contest" };

export default async function NewContest({ searchParams }: { searchParams: Promise<{ request?: string }> }) {
  const user = await getSessionUser();
  if (!user) redirect("/signin?next=/admin/new");
  if (!user.is_admin) return <Empty title="Admins only" />;
  const { request } = await searchParams;
  const req = request ? (await listRequests(user.id)).find((r) => r.id === request) ?? null : null;
  return (
    <div className="mx-auto grid max-w-3xl gap-4">
      <h1 className="font-display text-4xl font-extrabold uppercase">New contest</h1>
      <NewContestForm request={req ? { id: req.id, title: req.title, body: req.body } : null} />
    </div>
  );
}
