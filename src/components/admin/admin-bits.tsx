"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { act } from "@/lib/client/api";
import { ErrorNote } from "@/components/ui";

export function AdminRequestActions({ id, status }: { id: string; status: string }) {
  const router = useRouter();
  const [note, setNote] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const run = async (s: "reviewing" | "declined") => {
    try {
      await act("update_request", { request_id: id, status: s, note: note || null });
      router.refresh();
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Link href={`/admin/new?request=${id}`} className="btn btn-lime px-3 py-1.5 text-sm">Turn into contest</Link>
      {status !== "reviewing" && <button className="btn btn-ghost px-3 py-1.5 text-sm" onClick={() => run("reviewing")}>Mark reviewing</button>}
      <input className="input max-w-xs py-1.5 text-sm" placeholder="Note to requester (optional)" value={note} onChange={(e) => setNote(e.target.value)} />
      <button className="btn btn-danger px-3 py-1.5 text-sm" onClick={() => run("declined")}>Decline</button>
      <ErrorNote error={err} />
    </div>
  );
}

export function DemoClock() {
  const router = useRouter();
  const [err, setErr] = useState<string | null>(null);
  const shift = async (seconds: number) => {
    try {
      await act("demo_clock", { seconds });
      router.refresh();
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  return (
    <div className="card flex flex-wrap items-center gap-2 border-dashed p-3 text-sm">
      <span className="chip-label text-lime">Demo clock</span>
      <span className="text-cream-dim">Shift server time to test claim cooldowns and lock times:</span>
      <button className="btn btn-ghost px-2 py-1 text-xs" onClick={() => shift(3600)}>+1 hour</button>
      <button className="btn btn-ghost px-2 py-1 text-xs" onClick={() => shift(23 * 3600)}>+23 hours</button>
      <button className="btn btn-ghost px-2 py-1 text-xs" onClick={() => shift(3 * 86400)}>+3 days</button>
      <ErrorNote error={err} />
    </div>
  );
}
