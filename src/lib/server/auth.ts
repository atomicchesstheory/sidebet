import crypto from "node:crypto";
import { cookies } from "next/headers";
import { config } from "./config";
import { asService, getDb } from "./db";
import { AppError } from "./errors";

export type SessionUser = { id: string; username: string; display_name: string; is_admin: boolean };

const COOKIE = "sb_session";
const MAX_AGE = 60 * 60 * 24 * 30;

// ---------------------------------------------------------------- helpers --
function sign(payload: string) {
  return crypto.createHmac("sha256", config.sessionSecret).update(payload).digest("base64url");
}
export function makeSessionToken(userId: string, now = Date.now()) {
  const payload = `${userId}.${Math.floor(now / 1000) + MAX_AGE}`;
  return `${payload}.${sign(payload)}`;
}
export function readSessionToken(token: string | undefined): string | null {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [uid, exp, sig] = parts;
  const expect = sign(`${uid}.${exp}`);
  if (sig.length !== expect.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) return null;
  if (Number(exp) * 1000 < Date.now()) return null;
  if (!/^[0-9a-f-]{36}$/.test(uid)) return null;
  return uid;
}

export function hashPassword(pw: string) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pw, salt, 32);
  return `scrypt$${salt.toString("base64")}$${hash.toString("base64")}`;
}
export function verifyPassword(pw: string, stored: string) {
  const [alg, s, h] = stored.split("$");
  if (alg !== "scrypt") return false;
  const hash = crypto.scryptSync(pw, Buffer.from(s, "base64"), 32);
  return crypto.timingSafeEqual(hash, Buffer.from(h, "base64"));
}

export const USERNAME_RE = /^[a-z0-9_]{3,24}$/;

async function supabaseServer() {
  const { createServerClient } = await import("@supabase/ssr");
  const store = await cookies();
  return createServerClient(config.supabaseUrl, config.supabaseAnonKey, {
    cookies: {
      getAll: () => store.getAll(),
      setAll: (list) => {
        try {
          for (const { name, value, options } of list) store.set(name, value, options);
        } catch {
          // called from a server component; the proxy refreshes the session
        }
      },
    },
  });
}

async function loadProfile(id: string): Promise<SessionUser | null> {
  const rows = await asService((q) =>
    q.query<SessionUser>("select id, username, display_name, is_admin from public.profiles where id = $1", [id]),
  );
  const p = rows[0];
  if (!p) return null;
  if (!p.is_admin && config.adminUsernames.includes(p.username)) {
    await asService((q) => q.query("update public.profiles set is_admin = true where id = $1", [id]));
    p.is_admin = true;
  }
  return p;
}

// ------------------------------------------------------------ public API --
export async function getSessionUser(): Promise<SessionUser | null> {
  if (config.mode === "demo") {
    const store = await cookies();
    const uid = readSessionToken(store.get(COOKIE)?.value);
    if (!uid) return null;
    await getDb();
    return loadProfile(uid);
  }
  const sb = await supabaseServer();
  const { data } = await sb.auth.getUser();
  if (!data.user) return null;
  return loadProfile(data.user.id);
}

export async function requireUser(): Promise<SessionUser> {
  const u = await getSessionUser();
  if (!u) throw new AppError("not_signed_in");
  return u;
}

export async function requireAdmin(): Promise<SessionUser> {
  const u = await requireUser();
  if (!u.is_admin) throw new AppError("admin_only");
  return u;
}

export async function usernameAvailable(username: string) {
  const rows = await asService((q) => q.query("select 1 from public.profiles where username = $1", [username]));
  return rows.length === 0;
}

/** Demo-mode account creation (also used by seeding and tests). */
export async function createLocalUser(username: string, password: string, displayName: string): Promise<string> {
  if (!USERNAME_RE.test(username)) throw new AppError("validation", "Usernames are 3–24 lowercase letters, numbers or underscores.");
  if (password.length < 8) throw new AppError("validation", "Passwords need at least 8 characters.");
  return asService(async (q) => {
    const taken = await q.query("select 1 from public.profiles where username = $1", [username]);
    if (taken.length) throw new AppError("username_taken");
    const [u] = await q.query<{ id: string }>(
      "insert into auth.users (email, raw_user_meta_data) values (null, $1::jsonb) returning id",
      [JSON.stringify({ username, display_name: displayName })],
    );
    await q.query("insert into auth.local_credentials (user_id, username, password_hash) values ($1, $2, $3)", [
      u.id,
      username,
      hashPassword(password),
    ]);
    return u.id;
  });
}

export async function signUp(input: { username: string; password: string; displayName: string; email?: string }) {
  const username = input.username.trim().toLowerCase();
  if (!USERNAME_RE.test(username)) throw new AppError("validation", "Usernames are 3–24 lowercase letters, numbers or underscores.");
  if (!(await usernameAvailable(username))) throw new AppError("username_taken");
  if (config.mode === "demo") {
    const id = await createLocalUser(username, input.password, input.displayName || username);
    (await cookies()).set(COOKIE, makeSessionToken(id), { httpOnly: true, sameSite: "lax", path: "/", maxAge: MAX_AGE, secure: process.env.NODE_ENV === "production" });
    return { needsConfirmation: false };
  }
  if (!input.email) throw new AppError("validation", "Email is required.");
  const sb = await supabaseServer();
  const { data, error } = await sb.auth.signUp({
    email: input.email,
    password: input.password,
    options: { data: { username, display_name: input.displayName || username } },
  });
  if (error) throw new AppError("validation", error.message);
  return { needsConfirmation: !data.session };
}

export async function signIn(login: string, password: string) {
  const l = login.trim().toLowerCase();
  if (config.mode === "demo") {
    const rows = await asService((q) =>
      q.query<{ user_id: string; password_hash: string }>(
        "select user_id, password_hash from auth.local_credentials where username = $1",
        [l],
      ),
    );
    if (!rows[0] || !verifyPassword(password, rows[0].password_hash)) throw new AppError("bad_credentials");
    (await cookies()).set(COOKIE, makeSessionToken(rows[0].user_id), { httpOnly: true, sameSite: "lax", path: "/", maxAge: MAX_AGE, secure: process.env.NODE_ENV === "production" });
    return;
  }
  let email = l;
  if (!l.includes("@")) {
    const rows = await asService((q) =>
      q.query<{ email: string }>(
        "select u.email from auth.users u join public.profiles p on p.id = u.id where p.username = $1",
        [l],
      ),
    );
    if (!rows[0]) throw new AppError("bad_credentials");
    email = rows[0].email;
  }
  const sb = await supabaseServer();
  const { error } = await sb.auth.signInWithPassword({ email, password });
  if (error) throw new AppError("bad_credentials", error.message);
}

export async function signOut() {
  if (config.mode === "demo") {
    (await cookies()).delete(COOKIE);
    return;
  }
  const sb = await supabaseServer();
  await sb.auth.signOut();
}
