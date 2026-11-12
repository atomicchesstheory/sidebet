/** Pure formatting helpers, safe on server and client. */

/** One display time zone for server and browser renders (no hydration mismatch). */
const TZ = process.env.NEXT_PUBLIC_DISPLAY_TZ || "America/Chicago";

export function fmtTime(iso: string | Date | null | undefined) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: TZ, timeZoneName: "short" });
}

export function ago(iso: string | Date | null | undefined, nowIso?: string) {
  if (!iso) return "never";
  const s = Math.round(((nowIso ? new Date(nowIso).getTime() : Date.now()) - new Date(iso).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export function pts(n: number) {
  return String(Math.round(n * 100) / 100);
}

export const sideText: Record<string, string> = {
  teal: "text-teal", violet: "text-violet", amber: "text-amber", sky: "text-sky", rose: "text-rose", lime: "text-lime",
};
export const sideBorder: Record<string, string> = {
  teal: "border-teal", violet: "border-violet", amber: "border-amber", sky: "border-sky", rose: "border-rose", lime: "border-lime",
};
export const sideBg: Record<string, string> = {
  teal: "bg-teal", violet: "bg-violet", amber: "bg-amber", sky: "bg-sky", rose: "bg-rose", lime: "bg-lime",
};
