import dns from "node:dns/promises";
import net from "node:net";
import { config } from "../config";
import { AppError } from "../errors";

/**
 * Fetch untrusted public URLs safely: http(s) only, no private/loopback/
 * link-local addresses (checked on every redirect hop), 10s timeout, 2 MB cap.
 */
export const FETCH_TIMEOUT_MS = 10_000;
export const MAX_BYTES = 2 * 1024 * 1024;

export function isPrivateIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return (
      a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0) ||
      (a === 198 && (b === 18 || b === 19)) || a >= 224
    );
  }
  const v = ip.toLowerCase();
  if (v === "::1" || v === "::") return true;
  if (v.startsWith("::ffff:")) return isPrivateIp(v.slice(7));
  return v.startsWith("fc") || v.startsWith("fd") || v.startsWith("fe80") || v.startsWith("ff");
}

export async function assertPublicUrl(raw: string): Promise<URL> {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new AppError("source_blocked", "That isn't a valid URL.");
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new AppError("source_blocked", "Only http(s) URLs are allowed.");
  if (u.username || u.password) throw new AppError("source_blocked", "URLs with credentials aren't allowed.");
  const host = u.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal") || host.endsWith(".local")) {
    throw new AppError("source_blocked", "Local addresses aren't allowed.");
  }
  if (config.allowedSourceHosts.length && !config.allowedSourceHosts.some((h) => host === h || host.endsWith("." + h))) {
    throw new AppError("source_blocked", `Host ${host} isn't in ALLOWED_SOURCE_HOSTS.`);
  }
  const addrs = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true }).catch(() => []);
  if (!addrs.length) throw new AppError("source_blocked", `Couldn't resolve ${host}.`);
  if (addrs.some((a) => isPrivateIp(a.address))) throw new AppError("source_blocked", "That host resolves to a private address.");
  return u;
}

export async function safeFetch(raw: string, accept = "*/*"): Promise<{ url: string; contentType: string; text: string; bytes: number }> {
  let current = raw;
  for (let hop = 0; hop < 4; hop++) {
    const u = await assertPublicUrl(current);
    const res = await fetch(u, {
      redirect: "manual",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { accept, "user-agent": "SideBetResultsBot/1.0 (+results checker)" },
    });
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      current = new URL(res.headers.get("location")!, u).toString();
      continue;
    }
    if (!res.ok) throw new AppError("validation", `Source returned HTTP ${res.status}.`);
    const len = Number(res.headers.get("content-length") ?? 0);
    if (len > MAX_BYTES) throw new AppError("validation", "Source is larger than 2 MB.");
    const reader = res.body?.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    if (reader) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > MAX_BYTES) {
          await reader.cancel();
          throw new AppError("validation", "Source is larger than 2 MB.");
        }
        chunks.push(value);
      }
    }
    const text = new TextDecoder().decode(Buffer.concat(chunks));
    return { url: u.toString(), contentType: res.headers.get("content-type") ?? "", text, bytes: total };
  }
  throw new AppError("validation", "Too many redirects.");
}

/** Reduce HTML to readable text before it goes anywhere near a model. */
export function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<\/(p|div|tr|li|h\d|table|section)>/gi, "\n")
    .replace(/<(br|hr)\s*\/?>/gi, "\n")
    .replace(/<\/t[dh]>/gi, " | ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n")
    .trim();
}
