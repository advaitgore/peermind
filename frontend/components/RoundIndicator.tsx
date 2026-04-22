"use client";

export function RoundIndicator({
  current,
  max,
  complete,
}: {
  current: number;
  max: number;
  complete?: boolean;
}) {
  const pips = Array.from({ length: max }, (_, i) => i + 1);
  return (
    <div className="flex items-center gap-2 text-xs font-mono uppercase tracking-wider text-[color:var(--color-text-dim)]">
      <span>Round {Math.min(current || 1, max)}/{max}</span>
      <div className="flex gap-1">
        {pips.map((n) => {
          const filled = n < current || (complete && n === current);
          const active = n === current && !complete;
          return (
            <span
              key={n}
              aria-label={`round ${n}`}
              className={`inline-block w-2.5 h-2.5 rounded-full border border-[color:var(--color-border-strong)] ${
                filled
                  ? "bg-[color:var(--color-primary)] border-[color:var(--color-primary)]"
                  : active
                  ? "bg-[color:var(--color-primary)]/40"
                  : "bg-transparent"
              }`}
            />
          );
        })}
      </div>
    </div>
  );
}
