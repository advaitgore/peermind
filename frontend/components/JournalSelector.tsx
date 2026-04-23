"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Check, Search } from "lucide-react";
import type { JournalId, JournalProfile } from "@/lib/types";

const PRESET_ORDER: JournalId[] = ["neurips", "icml", "iclr", "nature", "science", "arxiv"];

const ABBREV: Record<JournalId, string> = {
  neurips: "NeurIPS",
  icml: "ICML",
  iclr: "ICLR",
  nature: "Nature",
  science: "Science",
  arxiv: "arXiv",
  custom: "",
};

export interface JournalSelection {
  journal: JournalId | ""; // "" = nothing picked yet
  customName?: string; // only set when journal === "custom"
}

/**
 * Searchable combobox for target venue. Shows the 6 preset profiles as
 * suggestions; if the user types something unmatched we offer
 * "Use '<typed>' as custom venue" which submits the custom profile with the
 * venue name injected into the reviewer rubric.
 */
export function JournalSelector({
  profiles,
  value,
  onChange,
}: {
  profiles: Record<string, JournalProfile>;
  value: JournalSelection;
  onChange: (v: JournalSelection) => void;
}) {
  const hasProfiles = Object.keys(profiles).length > 0;
  const [query, setQuery] = useState<string>(() => {
    if (value.journal === "custom") return value.customName || "";
    if (value.journal && ABBREV[value.journal]) return profiles[value.journal]?.full_name || ABBREV[value.journal];
    return "";
  });
  const [open, setOpen] = useState(false);
  const [activeIdx, setActiveIdx] = useState(0);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Close dropdown on outside click.
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (!wrapperRef.current) return;
      if (!wrapperRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, []);

  const q = query.trim().toLowerCase();
  const presetMatches = useMemo(() => {
    const matches: Array<{ id: JournalId; abbrev: string; name: string }> = [];
    for (const id of PRESET_ORDER) {
      const p = profiles[id];
      if (!p) continue;
      const abbrev = ABBREV[id];
      const name = p.full_name;
      const hay = `${abbrev} ${name}`.toLowerCase();
      if (!q || hay.includes(q)) matches.push({ id, abbrev, name });
    }
    return matches;
  }, [q, profiles]);

  const showCustom = q.length >= 2 && !presetMatches.some((m) => m.abbrev.toLowerCase() === q || m.name.toLowerCase() === q);
  const options = showCustom
    ? [...presetMatches, { id: "__custom__" as const, abbrev: "Custom", name: query.trim() }]
    : presetMatches;

  useEffect(() => {
    setActiveIdx(0);
  }, [q, presetMatches.length, showCustom]);

  const pick = (idx: number) => {
    const opt = options[idx];
    if (!opt) return;
    if (opt.id === "__custom__") {
      onChange({ journal: "custom", customName: opt.name });
      setQuery(opt.name);
    } else {
      const id = opt.id as JournalId;
      onChange({ journal: id });
      setQuery(profiles[id]?.full_name || ABBREV[id]);
    }
    setOpen(false);
    inputRef.current?.blur();
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (!open && (e.key === "ArrowDown" || e.key === "Enter")) {
      setOpen(true);
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIdx((i) => Math.min(options.length - 1, i + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIdx((i) => Math.max(0, i - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      pick(activeIdx);
    } else if (e.key === "Escape") {
      setOpen(false);
      inputRef.current?.blur();
    }
  };

  const selectedLabel =
    value.journal === "custom"
      ? value.customName
      : value.journal
      ? profiles[value.journal]?.full_name
      : undefined;

  if (!hasProfiles) {
    return (
      <div>
        <div className="eyebrow mb-3">Target venue</div>
        <div
          className="text-[var(--text-sm)] px-3 py-2 rounded-[var(--radius-md)] border"
          style={{
            background: "var(--color-warning-bg)",
            borderColor: "rgba(217,168,74,0.35)",
            color: "var(--color-warning)",
          }}
        >
          Can&apos;t reach the backend at <span className="font-mono">:8000</span>.
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="eyebrow mb-3">Target venue</div>
      <div ref={wrapperRef} className="relative">
        <div className="input">
          <Search size={15} style={{ color: "var(--color-text-faint)" }} />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setOpen(true);
              // If the user edits away from the current selection, clear it
              // so they don't accidentally submit a stale value.
              if (value.journal && e.target.value.toLowerCase() !== (selectedLabel || "").toLowerCase()) {
                onChange({ journal: "" });
              }
            }}
            onFocus={() => setOpen(true)}
            onKeyDown={onKey}
            placeholder="Search or type a venue — NeurIPS, Nature, EMNLP…"
            aria-expanded={open}
            aria-haspopup="listbox"
            role="combobox"
            autoComplete="off"
            spellCheck={false}
          />
          {value.journal && (
            <span
              className="inline-flex items-center gap-1 text-[11px] font-mono"
              style={{ color: "var(--color-primary-strong)" }}
            >
              <Check size={11} />
              {value.journal === "custom" ? "custom" : ABBREV[value.journal]}
            </span>
          )}
        </div>
        <AnimatePresence>
          {open && options.length > 0 && (
            <motion.ul
              initial={{ opacity: 0, y: -4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }}
              transition={{ duration: 0.12 }}
              role="listbox"
              className="absolute left-0 right-0 top-full mt-2 z-20 rounded-[var(--radius-md)] overflow-hidden"
              style={{
                background: "var(--color-surface)",
                border: "1px solid var(--color-border-strong)",
                boxShadow: "var(--shadow-md)",
              }}
            >
              {options.map((opt, i) => {
                const isCustom = opt.id === "__custom__";
                const isActive = i === activeIdx;
                return (
                  <li
                    key={isCustom ? "custom" : String(opt.id)}
                    role="option"
                    aria-selected={isActive}
                    onMouseEnter={() => setActiveIdx(i)}
                    onMouseDown={(e) => {
                      e.preventDefault(); // keep input focused
                      pick(i);
                    }}
                    className="px-[var(--space-3)] py-[var(--space-2)] cursor-pointer flex items-baseline gap-3 text-[var(--text-sm)]"
                    style={{
                      background: isActive ? "var(--color-surface-3)" : "transparent",
                      borderTop: i === 0 ? "none" : "1px solid var(--color-border)",
                    }}
                  >
                    <span
                      className="font-mono"
                      style={{
                        color: isCustom
                          ? "var(--color-primary-strong)"
                          : "var(--color-text-muted)",
                        fontSize: "var(--text-xs)",
                        letterSpacing: "0.08em",
                        textTransform: "uppercase",
                        width: 56,
                      }}
                    >
                      {opt.abbrev}
                    </span>
                    <span
                      className="flex-1"
                      style={{ color: "var(--color-text)" }}
                    >
                      {isCustom ? (
                        <>
                          Use <span style={{ color: "var(--color-primary-strong)" }}>&ldquo;{opt.name}&rdquo;</span> as custom venue
                        </>
                      ) : (
                        opt.name
                      )}
                    </span>
                  </li>
                );
              })}
            </motion.ul>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}
