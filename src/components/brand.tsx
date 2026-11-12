/** Two offset chips — the Side Bet mark. */
export function ChipMark({ size = 28, className = "" }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" className={className} aria-hidden="true">
      <g>
        <circle cx="12" cy="13" r="10" fill="#2fd3c0" />
        <circle cx="12" cy="13" r="6.2" fill="none" stroke="#131417" strokeWidth="1.6" strokeDasharray="3 2.4" />
      </g>
      <g>
        <circle cx="20" cy="19" r="10" fill="#c9f63c" stroke="#131417" strokeWidth="1.6" />
        <circle cx="20" cy="19" r="6.2" fill="none" stroke="#131417" strokeWidth="1.6" strokeDasharray="3 2.4" />
        <circle cx="20" cy="19" r="2.2" fill="#131417" />
      </g>
    </svg>
  );
}

export function Wordmark({ size = "md" }: { size?: "md" | "lg" }) {
  const big = size === "lg";
  return (
    <span className="inline-flex items-center gap-2">
      <ChipMark size={big ? 52 : 28} />
      <span className={`font-display font-extrabold uppercase italic leading-none tracking-tight ${big ? "text-6xl" : "text-2xl"}`}>
        Side<span className="text-lime">Bet</span>
      </span>
    </span>
  );
}

/** Small inline chip indicator for amounts. */
export function Chips({ n, className = "", sign = false }: { n: number; className?: string; sign?: boolean }) {
  return (
    <span className={`num inline-flex items-center gap-1 font-semibold ${className}`}>
      <ChipMark size={14} />
      {sign && n > 0 ? "+" : ""}
      {n.toLocaleString()}
    </span>
  );
}
