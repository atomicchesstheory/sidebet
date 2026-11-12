import { Suspense } from "react";
import { AuthForm } from "@/components/auth/auth-form";
import { config } from "@/lib/server/config";
import { DEMO_PASSWORD, DEMO_USERS } from "@/lib/server/seed";

export const metadata = { title: "Sign in" };

export default function SignIn() {
  return (
    <div className="grid gap-6 py-6">
      <p className="text-center font-display text-xl font-semibold uppercase tracking-wide text-cream-dim">Pick a side. Put up chips.</p>
      <Suspense>
        <AuthForm kind="signin" mode={config.mode} />
      </Suspense>
      {config.mode === "demo" && (
        <div className="card mx-auto max-w-sm p-4 text-sm">
          <div className="chip-label text-lime">Demo accounts</div>
          <p className="mt-1 text-cream-dim">
            Password for all: <code className="text-cream">{DEMO_PASSWORD}</code>
          </p>
          <ul className="mt-2 grid gap-1">
            {DEMO_USERS.map((u) => (
              <li key={u.username}>
                <code className="text-cream">{u.username}</code> <span className="text-cream-dim">— {u.admin ? "admin" : u.username === "casey" ? "not invited to the private contests" : "entrant in the private demos"}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
