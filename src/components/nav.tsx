"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState } from "react";
import { Chips } from "./brand";
import { post } from "@/lib/client/api";

type U = { id: string; username: string; display_name: string; is_admin: boolean } | null;

export function Nav({ user, balance, canClaim, achievementsReady = 0, friendRequests = 0 }: { user: U; balance: number | null; canClaim: boolean; achievementsReady?: number; friendRequests?: number }) {
  const path = usePathname();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  if (!user) {
    return (
      <nav className="ml-auto flex items-center gap-2">
        <Link href="/signin" className="btn btn-ghost px-3 py-1.5 text-sm">Sign in</Link>
        <Link href="/signup" className="btn btn-lime px-3 py-1.5 text-sm">Join</Link>
      </nav>
    );
  }
  const links: { href: string; label: string; badge?: number; mobileOnly?: boolean }[] = [
    { href: "/", label: "Home" },
    { href: "/browse", label: "Browse" },
    { href: "/friends", label: "Friends", badge: friendRequests },
    { href: "/achievements", label: "Achievements", badge: achievementsReady },
    { href: `/u/${user.username}`, label: "Profile" },
    { href: "/requests", label: "Requests", mobileOnly: true },
    ...(user.is_admin ? [{ href: "/admin", label: "Admin" }] : []),
  ];
  const Badge = ({ n }: { n?: number }) => (n ? <span className="num ml-1 rounded-full bg-lime px-1.5 text-[10px] font-bold text-ink">{n}</span> : null);
  const active = (h: string) => (h === "/" ? path === "/" : path.startsWith(h));
  return (
    <>
      <nav className="ml-4 hidden items-center gap-1 md:flex">
        {links.filter((l) => !l.mobileOnly).map((l) => (
          <Link key={l.href} href={l.href} className={`flex items-center rounded-lg px-2.5 py-1.5 text-sm font-semibold ${active(l.href) ? "bg-panel-2 text-cream" : "text-cream-dim hover:text-cream"}`}>
            {l.label}<Badge n={l.badge} />
          </Link>
        ))}
      </nav>
      <div className="ml-auto flex items-center gap-2">
        <Link href="/new" className="btn btn-lime hidden px-3 py-1.5 text-sm sm:inline-flex">+ Start a bet</Link>
        <Link href="/wallet" className="relative flex items-center gap-1 rounded-full border border-line bg-panel px-3 py-1 text-sm" title="Wallet">
          <Chips n={balance ?? 0} />
          {canClaim && <span className="absolute -right-1 -top-1 h-2.5 w-2.5 rounded-full bg-lime" aria-label="Free chips ready" />}
        </Link>
        <button
          className="hidden text-sm text-cream-dim hover:text-cream md:block"
          onClick={async () => {
            await post("/api/auth/signout", {});
            router.push("/");
            router.refresh();
          }}
        >
          Sign out
        </button>
        <button className="btn btn-ghost relative px-2.5 py-1.5 md:hidden" aria-expanded={open} aria-label="Menu" onClick={() => setOpen((o) => !o)}>
          ☰
          {achievementsReady + friendRequests > 0 && <span className="absolute -right-1 -top-1 h-2.5 w-2.5 rounded-full bg-lime" aria-label="New notifications" />}
        </button>
      </div>
      {open && (
        <div className="absolute inset-x-0 top-full border-b border-line bg-ink px-4 py-3 md:hidden">
          <div className="grid gap-1">
            <Link href="/new" onClick={() => setOpen(false)} className="btn btn-lime mb-1">+ Start a bet</Link>
            {links.map((l) => (
              <Link key={l.href} href={l.href} onClick={() => setOpen(false)} className={`flex items-center rounded-lg px-3 py-2 font-semibold ${active(l.href) ? "bg-panel-2" : "text-cream-dim"}`}>
                {l.label}<Badge n={l.badge} />
              </Link>
            ))}
            <Link href="/wallet" onClick={() => setOpen(false)} className="rounded-lg px-3 py-2 font-semibold text-cream-dim">Wallet</Link>
            <button
              className="rounded-lg px-3 py-2 text-left font-semibold text-cream-dim"
              onClick={async () => {
                await post("/api/auth/signout", {});
                setOpen(false);
                router.push("/");
                router.refresh();
              }}
            >
              Sign out
            </button>
          </div>
        </div>
      )}
    </>
  );
}
