"use client";

import { useEffect, useRef, useState } from "react";

const SUPA_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPA_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

export type LiveState = "connecting" | "live" | "polling";

/**
 * Calls `onChange` whenever the contest changes.
 *  - Supabase mode: Realtime postgres_changes on `contest_signals` (RLS-filtered,
 *    so private contests only reach members). Signals carry no picks.
 *  - Demo mode: server-sent events from /api/live/[id].
 *  - Always: a slow poll as a safety net.
 */
export function useContestLive(contestId: string, onChange: () => void, pollMs = 15000): LiveState {
  const cb = useRef(onChange);
  useEffect(() => {
    cb.current = onChange;
  }, [onChange]);
  const [state, setState] = useState<LiveState>("connecting");

  useEffect(() => {
    let closed = false;
    let cleanup = () => {};
    const fire = () => !closed && cb.current();

    if (SUPA_URL && SUPA_KEY) {
      (async () => {
        const { createBrowserClient } = await import("@supabase/ssr");
        const sb = createBrowserClient(SUPA_URL, SUPA_KEY);
        const ch = sb
          .channel(`contest:${contestId}`)
          .on("postgres_changes", { event: "*", schema: "public", table: "contest_signals", filter: `contest_id=eq.${contestId}` }, fire)
          .subscribe((s) => !closed && setState(s === "SUBSCRIBED" ? "live" : "polling"));
        cleanup = () => {
          sb.removeChannel(ch);
        };
      })();
    } else {
      const es = new EventSource(`/api/live/${contestId}`);
      es.addEventListener("hello", () => setState("live"));
      es.addEventListener("change", fire);
      es.onerror = () => setState("polling");
      cleanup = () => es.close();
    }
    const t = setInterval(fire, pollMs);
    return () => {
      closed = true;
      clearInterval(t);
      cleanup();
    };
  }, [contestId, pollMs]);
  return state;
}
