"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { act } from "@/lib/client/api";

type Status = "friends" | "incoming" | "outgoing" | "none" | "self";

/** Add / accept / remove friend, shown on profiles. */
export function FriendButton({ userId, username, status: initial }: { userId: string; username: string; status: Status }) {
  const router = useRouter();
  const [status, setStatus] = useState<Status>(initial);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  if (status === "self") return null;
  const run = async (fn: () => Promise<Status>) => {
    setBusy(true);
    setErr(null);
    try {
      setStatus(await fn());
      router.refresh();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex flex-wrap items-center gap-2">
      {status === "none" && (
        <button className="btn btn-lime px-3 py-1.5 text-sm" disabled={busy} onClick={() => run(async () => {
          const r = await act<{ result: string }>("friend_request", { username });
          return r.result === "accepted" ? "friends" : "outgoing";
        })}>+ Add friend</button>
      )}
      {status === "outgoing" && <span className="chip-label rounded-full border border-line px-3 py-1 text-cream-dim">Request sent</span>}
      {status === "incoming" && (
        <>
          <button className="btn btn-lime px-3 py-1.5 text-sm" disabled={busy} onClick={() => run(async () => { await act("friend_respond", { user_id: userId, accept: true }); return "friends"; })}>Accept friend request</button>
          <button className="btn btn-ghost px-3 py-1.5 text-sm" disabled={busy} onClick={() => run(async () => { await act("friend_respond", { user_id: userId, accept: false }); return "none"; })}>Decline</button>
        </>
      )}
      {status === "friends" && (
        <>
          <span className="chip-label rounded-full border border-lime/50 px-3 py-1 text-lime">✓ Friends</span>
          {confirming ? (
            <span className="flex items-center gap-2 text-xs">
              <span className="text-cream-dim">Remove {username}?</span>
              <button className="font-semibold text-rose" disabled={busy} onClick={() => run(async () => { await act("friend_remove", { user_id: userId }); setConfirming(false); return "none"; })}>Yes, remove</button>
              <button className="text-cream-dim" onClick={() => setConfirming(false)}>Keep</button>
            </span>
          ) : (
            <button className="text-xs text-cream-faint hover:text-rose" onClick={() => setConfirming(true)}>Remove</button>
          )}
        </>
      )}
      {err && <span className="text-sm text-rose">{err}</span>}
    </div>
  );
}

