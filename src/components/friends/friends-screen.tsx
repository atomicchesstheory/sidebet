"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import type { FriendsView } from "@/lib/server/friends";
import { act } from "@/lib/client/api";
import { ErrorNote } from "@/components/ui";

export function FriendsScreen({ initial }: { initial: FriendsView }) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  async function run(key: string, fn: () => Promise<unknown>) {
    setBusy(key);
    setErr(null);
    setNote(null);
    try {
      await fn();
      router.refresh();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  const { friends, incoming, outgoing } = initial;
  return (
    <div className="grid gap-6">
      <header>
        <h1 className="font-display text-4xl font-extrabold uppercase">Friends</h1>
        <p className="text-cream-dim">Add friends by username, then pull them straight into bets you set up.</p>
      </header>

      <form
        className="card flex flex-wrap items-end gap-3 p-4"
        onSubmit={(e) => {
          e.preventDefault();
          const u = name.trim().toLowerCase();
          if (!u) return;
          run("add", async () => {
            const r = await act<{ result: string }>("friend_request", { username: u });
            setNote(r.result === "accepted" ? `You and ${u} are now friends.` : r.result === "already" ? `You've already added ${u}.` : `Request sent to ${u}.`);
            setName("");
          });
        }}
      >
        <label className="grid flex-1 gap-1">
          <span className="label">Add a friend</span>
          <input className="input" placeholder="their username" value={name} onChange={(e) => setName(e.target.value)} autoCapitalize="none" autoCorrect="off" />
        </label>
        <button className="btn btn-lime" disabled={busy === "add" || !name.trim()}>{busy === "add" ? "Sending…" : "Send request"}</button>
        <div className="basis-full">
          <ErrorNote error={err} />
          {note && <div className="rounded-lg border border-lime/40 bg-lime/10 px-3 py-2 text-sm text-lime">{note}</div>}
        </div>
      </form>

      {incoming.length > 0 && (
        <section className="card grid gap-2 border-lime/50 p-4">
          <h2 className="font-display text-xl font-bold uppercase text-lime">Requests for you ({incoming.length})</h2>
          <ul className="grid gap-2">
            {incoming.map((f) => (
              <li key={f.user_id} className="flex flex-wrap items-center gap-2">
                <Link href={`/u/${f.username}`} className="flex-1 font-semibold hover:text-lime">{f.username}</Link>
                <button className="btn btn-lime px-3 py-1.5 text-sm" disabled={!!busy} onClick={() => run(`a${f.user_id}`, () => act("friend_respond", { user_id: f.user_id, accept: true }))}>Accept</button>
                <button className="btn btn-ghost px-3 py-1.5 text-sm" disabled={!!busy} onClick={() => run(`d${f.user_id}`, () => act("friend_respond", { user_id: f.user_id, accept: false }))}>Decline</button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="card grid gap-2 p-4">
        <h2 className="font-display text-xl font-bold uppercase">Your friends ({friends.length})</h2>
        {friends.length === 0 ? (
          <p className="text-sm text-cream-dim">No friends yet. Add someone above. You both get an achievement for it.</p>
        ) : (
          <ul className="grid gap-1 sm:grid-cols-2">
            {friends.map((f) => (
              <li key={f.user_id}>
                <Link href={`/u/${f.username}`} className="flex items-center gap-2 rounded-lg px-2 py-2 hover:bg-panel-2">
                  <span className="grid h-8 w-8 place-items-center rounded-full bg-panel-2 font-display font-bold uppercase text-lime">{f.username[0]}</span>
                  <span className="font-semibold">{f.username}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      {outgoing.length > 0 && (
        <section className="card grid gap-2 p-4">
          <h2 className="font-display text-xl font-bold uppercase text-cream-dim">Waiting on them ({outgoing.length})</h2>
          <ul className="grid gap-1">
            {outgoing.map((f) => (
              <li key={f.user_id} className="flex items-center gap-2 text-sm">
                <Link href={`/u/${f.username}`} className="flex-1 hover:text-lime">{f.username}</Link>
                <button className="text-xs text-cream-faint hover:text-rose" disabled={!!busy} onClick={() => run(`c${f.user_id}`, () => act("friend_remove", { user_id: f.user_id }))}>Cancel request</button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
