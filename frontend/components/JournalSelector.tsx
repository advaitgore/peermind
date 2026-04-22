"use client";

import type { JournalId, JournalProfile } from "@/lib/types";

const JOURNAL_ORDER: JournalId[] = ["neurips", "icml", "iclr", "nature", "science", "arxiv"];

export function JournalSelector({
  profiles,
  value,
  onChange,
}: {
  profiles: Record<string, JournalProfile>;
  value: JournalId | "";
  onChange: (v: JournalId) => void;
}) {
  return (
    <div>
      <label className="block text-xs uppercase tracking-wider text-[color:var(--color-text-dim)] mb-2">
        Target venue
      </label>
      <div className="grid grid-cols-3 gap-2">
        {JOURNAL_ORDER.map((id) => {
          const p = profiles[id];
          if (!p) return null;
          const selected = value === id;
          return (
            <button
              key={id}
              onClick={() => onChange(id)}
              className={`card px-3 py-2 text-left text-sm transition-colors ${
                selected ? "ring-2 ring-[color:var(--color-primary)]" : ""
              }`}
              aria-pressed={selected}
            >
              <div className="font-mono text-xs uppercase tracking-wider text-[color:var(--color-text-dim)]">
                {id}
              </div>
              <div className="mt-0.5 font-medium">{p.full_name}</div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
