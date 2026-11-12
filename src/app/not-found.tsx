import Link from "next/link";

export default function NotFound() {
  return (
    <div className="card mx-auto grid max-w-lg gap-3 p-6 text-center">
      <div className="font-display text-3xl font-extrabold uppercase">Out of bounds</div>
      <p className="text-cream-dim">That page doesn&apos;t exist.</p>
      <Link href="/" className="btn btn-lime mx-auto">Back home</Link>
    </div>
  );
}
