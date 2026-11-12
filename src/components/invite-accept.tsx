"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { act } from "@/lib/client/api";
import { ErrorNote } from "./ui";

export function InviteAccept({ token }: { token: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  return (
    <div className="grid gap-2">
      <ErrorNote error={err} />
      <button
        className="btn btn-lime py-3 text-lg"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setErr(null);
          try {
            const r = await act<{ contest_id: string }>("redeem_invite", { token });
            router.push(`/c/${r.contest_id}`);
          } catch (e) {
            setErr((e as Error).message);
            setBusy(false);
          }
        }}
      >
        {busy ? "Opening…" : "Accept invite & view contest"}
      </button>
    </div>
  );
}
