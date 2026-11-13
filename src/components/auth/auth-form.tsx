"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { post } from "@/lib/client/api";
import { ErrorNote } from "@/components/ui";

export function AuthForm({ kind, mode }: { kind: "signin" | "signup"; mode: "demo" | "supabase" }) {
  const router = useRouter();
  const params = useSearchParams();
  const next = params.get("next") || "/";
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setBusy(true);
    setErr(null);
    try {
      if (kind === "signin") {
        await post("/api/auth/signin", { login: f.get("login"), password: f.get("password") });
      } else {
        const r = await post<{ needsConfirmation: boolean }>("/api/auth/signup", {
          username: String(f.get("username") ?? "").toLowerCase(),
          password: f.get("password"),
          ...(mode === "supabase" ? { email: f.get("email") } : {}),
        });
        if (r?.needsConfirmation) {
          setInfo("Check your email to confirm your account, then sign in.");
          setBusy(false);
          return;
        }
      }
      router.push(next.startsWith("/") ? next : "/");
      router.refresh();
    } catch (e2) {
      setErr((e2 as Error).message);
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="card mx-auto grid max-w-sm gap-4 p-6">
      <h1 className="font-display text-3xl font-extrabold uppercase">{kind === "signin" ? "Sign in" : "Create your account"}</h1>
      {kind === "signin" ? (
        <label>
          <span className="label">{mode === "supabase" ? "Username or email" : "Username"}</span>
          <input name="login" className="input" autoComplete="username" required autoFocus />
        </label>
      ) : (
        <>
          <label>
            <span className="label">Username (3–24: a–z, 0–9, _)</span>
            <input name="username" className="input" pattern="[a-zA-Z0-9_]{3,24}" autoComplete="username" required autoFocus />
          </label>
          {mode === "supabase" && (
            <label>
              <span className="label">Email</span>
              <input name="email" type="email" className="input" autoComplete="email" required />
            </label>
          )}
        </>
      )}
      <label>
        <span className="label">Password{kind === "signup" ? " (8+ characters)" : ""}</span>
        <input name="password" type="password" className="input" minLength={kind === "signup" ? 8 : 1} autoComplete={kind === "signin" ? "current-password" : "new-password"} required />
      </label>
      <ErrorNote error={err} />
      {info && <div className="rounded-lg border border-teal/50 bg-teal/10 px-3 py-2 text-sm text-teal">{info}</div>}
      <button className="btn btn-lime" disabled={busy}>{busy ? "One sec…" : kind === "signin" ? "Sign in" : "Create account"}</button>
      <p className="text-center text-sm text-cream-dim">
        {kind === "signin" ? (
          <>New here? <Link className="link" href={`/signup?next=${encodeURIComponent(next)}`}>Create an account</Link></>
        ) : (
          <>Have an account? <Link className="link" href={`/signin?next=${encodeURIComponent(next)}`}>Sign in</Link></>
        )}
      </p>
    </form>
  );
}
