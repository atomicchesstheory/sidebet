"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { act } from "@/lib/client/api";

export function DisplayNameForm({ current }: { current: string }) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(current);
  const [err, setErr] = useState<string | null>(null);
  if (!editing) return <button className="link w-fit text-sm" onClick={() => setEditing(true)}>Edit display name</button>;
  return (
    <form
      className="flex flex-wrap items-center gap-2"
      onSubmit={async (e) => {
        e.preventDefault();
        try {
          await act("update_display_name", { display_name: name });
          setEditing(false);
          router.refresh();
        } catch (e2) {
          setErr((e2 as Error).message);
        }
      }}
    >
      <input className="input max-w-xs" value={name} maxLength={40} onChange={(e) => setName(e.target.value)} aria-label="Display name" />
      <button className="btn btn-lime px-3 py-1.5 text-sm">Save</button>
      <button type="button" className="btn btn-ghost px-3 py-1.5 text-sm" onClick={() => setEditing(false)}>Cancel</button>
      {err && <span className="text-sm text-rose">{err}</span>}
    </form>
  );
}
