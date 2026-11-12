import Link from "next/link";
import { Chips } from "@/components/brand";
import { InviteAccept } from "@/components/invite-accept";
import { Empty } from "@/components/ui";
import { getSessionUser } from "@/lib/server/auth";
import { inviteInfo } from "@/lib/server/contests";

export const metadata = { title: "You're invited" };

export default async function Invite({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const info = /^[a-f0-9]{20,80}$/.test(token) ? await inviteInfo(token) : null;
  if (!info) return <Empty title="Invite not found">Double-check the link with whoever sent it.</Empty>;
  if (info.revoked_at) return <Empty title="Invite revoked">This link was turned off. Ask the commish for a new one.</Empty>;
  const user = await getSessionUser();
  return (
    <div className="mx-auto grid max-w-lg gap-4 py-6">
      <div className="chip-label text-violet">Private {info.kind === "bet" ? "bet" : "draft"} · invite</div>
      <h1 className="font-display text-5xl font-extrabold uppercase leading-none">{info.title}</h1>
      <p className="text-cream-dim">Entry stake <Chips n={info.stake} className="text-cream" />. You&apos;ll see the full rules, payout and lock time before you put up chips.</p>
      {user ? (
        <InviteAccept token={token} />
      ) : (
        <div className="flex gap-3">
          <Link className="btn btn-lime" href={`/signup?next=/invite/${token}`}>Create account</Link>
          <Link className="btn btn-ghost" href={`/signin?next=/invite/${token}`}>Sign in</Link>
        </div>
      )}
    </div>
  );
}
