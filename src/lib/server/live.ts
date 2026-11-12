import { EventEmitter } from "node:events";

/**
 * In-process change notifications for demo mode (server-sent events).
 * In Supabase mode clients use Supabase Realtime on `contest_signals`
 * (RLS-filtered); this emitter still fires and is harmless.
 * Signals carry no data — clients re-fetch through the API, which applies
 * private-contest access and pick visibility.
 */
const g = globalThis as unknown as { __sidebetBus?: EventEmitter };
const bus = (g.__sidebetBus ??= Object.assign(new EventEmitter(), {}).setMaxListeners(1000));

export function notifyContest(contestId: string) {
  bus.emit(`contest:${contestId}`);
  bus.emit("any");
}

export function onContest(contestId: string, cb: () => void) {
  const ch = `contest:${contestId}`;
  bus.on(ch, cb);
  return () => bus.off(ch, cb);
}
