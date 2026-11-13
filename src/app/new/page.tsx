import { redirect } from "next/navigation";
import { NewManualContest } from "@/components/manual/new-manual-contest";
import { getSessionUser } from "@/lib/server/auth";

export const metadata = { title: "Start a bet" };

export default async function NewBetPage() {
  const user = await getSessionUser();
  if (!user) redirect("/signin?next=/new");
  return <NewManualContest />;
}
