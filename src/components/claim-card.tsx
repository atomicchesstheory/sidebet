"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Chips, ChipMark } from "./brand";
import { Countdown, ErrorNote } from "./ui";
import { act } from "@/lib/client/api";

export function ClaimCard({ canClaim, nextAt, serverNow, amount, balance, staked }: { canClaim: boolean; nextAt: string | null; serverNow: string; amount: number; balance: number; staked: number }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [ready, setReady] = useState(canClaim);
  return (
    <div className="card flex flex-wrap items-center gap-4 p-4">
      <ChipMark size={40} />
      <div>
        <div className="chip-label text-cream-faint">Available</div>
        <div className="font-display text-4xl font-extrabold"><Chips n={balance} /></div>
        <div className="num text-xs text-cream-dim">{staked.toLocaleString()} staked in open contests</div>
      </div>
      <div className="ml-auto grid justify-items-end gap-1">
        {ready ? (
          <button
            className="btn btn-lime"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setErr(null);
              try {
                await act("claim");
                setReady(false);
                router.refresh();
              } catch (e) {
                setErr((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            Claim chips · +{amount}
          </button>
        ) : (
          <div className="text-right text-sm text-cream-dim">
            Next free chips in{" "}
            {nextAt ? <Countdown to={nextAt} serverNow={serverNow} done="ready — refresh" className="font-semibold text-cream" /> : "—"}
          </div>
        )}
        <ErrorNote error={err} />
      </div>
    </div>
  );
}
