"use client";

export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="card mx-auto grid max-w-lg gap-3 p-6 text-center">
      <div className="font-display text-3xl font-extrabold uppercase text-rose">Foul on the play</div>
      <p className="text-cream-dim">Something went wrong loading this page. Your chips are safe — nothing changed.</p>
      {error.digest && <p className="text-xs text-cream-faint">Ref: {error.digest}</p>}
      <button className="btn btn-lime mx-auto" onClick={reset}>Try again</button>
    </div>
  );
}
