import { Suspense } from "react";
import { AuthForm } from "@/components/auth/auth-form";
import { config } from "@/lib/server/config";

export const metadata = { title: "Join" };

export default function SignUp() {
  return (
    <div className="grid gap-6 py-6">
      <p className="text-center font-display text-xl font-semibold uppercase tracking-wide text-cream-dim">Pick a side. Put up chips.</p>
      <Suspense>
        <AuthForm kind="signup" mode={config.mode} />
      </Suspense>
      <p className="mx-auto max-w-sm text-center text-xs text-cream-faint">You start with free play chips and can claim more once a week. Chips have no cash value.</p>
    </div>
  );
}
