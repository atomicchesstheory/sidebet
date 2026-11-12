"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { act } from "@/lib/client/api";
import { ErrorNote } from "./ui";

export function RequestForm() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  return (
    <form
      className="card grid gap-3 p-4"
      onSubmit={async (e) => {
        e.preventDefault();
        const form = e.currentTarget;
        const f = new FormData(form);
        setBusy(true);
        setErr(null);
        try {
          await act("submit_request", { title: f.get("title"), body: f.get("body") });
          form.reset();
          setDone(true);
          router.refresh();
        } catch (e2) {
          setErr((e2 as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <label>
        <span className="label">Title</span>
        <input name="title" className="input" required minLength={3} maxLength={120} placeholder="Office chili cook-off" />
      </label>
      <label>
        <span className="label">What&apos;s the bet?</span>
        <textarea name="body" className="input min-h-32" required minLength={3} maxLength={4000} placeholder="Who wins, how it's scored, where results come from…" />
      </label>
      <ErrorNote error={err} />
      {done && <div className="text-sm text-teal">Sent. You&apos;ll see its status here.</div>}
      <button className="btn btn-lime" disabled={busy}>{busy ? "Sending…" : "Send request"}</button>
    </form>
  );
}
