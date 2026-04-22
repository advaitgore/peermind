"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { motion } from "framer-motion";
import { Logo } from "@/components/Logo";
import { Dropzone } from "@/components/Dropzone";
import { JournalSelector } from "@/components/JournalSelector";
import { ThemeToggle } from "@/components/ThemeToggle";
import { createJobFromArxiv, createJobFromFile, fetchJournals, startJob } from "@/lib/api";
import type { JournalId, JournalProfile } from "@/lib/types";

const DEMO_ARXIV_ID = "2303.17651";

export default function Landing() {
  const router = useRouter();
  const [file, setFile] = useState<File | null>(null);
  const [arxivInput, setArxivInput] = useState("");
  const [journal, setJournal] = useState<JournalId | "">("");
  const [profiles, setProfiles] = useState<Record<string, JournalProfile>>({});
  const [starting, setStarting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    fetchJournals().then(setProfiles).catch(() => setProfiles({}));
  }, []);

  const canStart = Boolean((file || arxivInput.trim()) && journal && !starting);

  const go = async (opts?: { arxivId?: string; journal?: JournalId }) => {
    const useJournal = (opts?.journal || journal) as JournalId;
    if (!useJournal) {
      setErr("pick a venue first");
      return;
    }
    setErr(null);
    setStarting(true);
    try {
      let jobId: string;
      if (opts?.arxivId || (!file && arxivInput.trim())) {
        const r = await createJobFromArxiv(opts?.arxivId ?? arxivInput.trim());
        jobId = r.job_id;
      } else if (file) {
        const r = await createJobFromFile(file);
        jobId = r.job_id;
      } else {
        setErr("add a file or arXiv ID");
        setStarting(false);
        return;
      }
      await startJob(jobId, useJournal);
      router.push(`/review/${jobId}`);
    } catch (e) {
      setErr(String((e as Error).message || e));
      setStarting(false);
    }
  };

  const runDemo = () => {
    setJournal("neurips");
    setArxivInput(DEMO_ARXIV_ID);
    setFile(null);
    void go({ arxivId: DEMO_ARXIV_ID, journal: "neurips" });
  };

  return (
    <main className="min-h-screen px-6 py-10">
      <div className="max-w-[520px] mx-auto">
        <div className="flex items-center justify-between mb-10">
          <div className="flex items-center gap-3">
            <Logo size={32} />
            <span className="font-mono text-lg tracking-tight">PeerMind</span>
          </div>
          <ThemeToggle />
        </div>

        <motion.h1
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          className="text-3xl font-semibold leading-tight"
        >
          Your paper&apos;s toughest reviewer.
          <br />
          <span className="text-[color:var(--color-primary)]">In 90 seconds.</span>
        </motion.h1>
        <p className="mt-3 text-sm text-[color:var(--color-text-dim)]">
          Two adversarial Claude agents review your paper against the target venue&apos;s actual
          rubric. A literature scout finds what you missed, a code runner checks that it
          actually runs, and a fix agent patches the source.
        </p>

        <div className="mt-8 space-y-4">
          <Dropzone onFile={(f) => { setFile(f); setArxivInput(""); }} disabled={starting} />

          <div className="flex items-center gap-2">
            <div className="flex-1 h-px bg-[color:var(--color-border)]" />
            <span className="text-[11px] font-mono uppercase tracking-widest text-[color:var(--color-text-faint)]">
              or
            </span>
            <div className="flex-1 h-px bg-[color:var(--color-border)]" />
          </div>

          <div className="flex gap-2">
            <input
              value={arxivInput}
              onChange={(e) => {
                setArxivInput(e.target.value);
                setFile(null);
              }}
              placeholder="arXiv URL or ID — e.g. 2303.17651"
              disabled={starting}
              className="flex-1 card px-3 py-2 font-mono text-sm bg-[color:var(--color-surface-2)]"
            />
          </div>

          <JournalSelector profiles={profiles} value={journal} onChange={setJournal} />

          <button
            onClick={() => void go()}
            disabled={!canStart}
            className="btn btn-primary w-full justify-center py-3 text-sm"
          >
            {starting ? "Starting…" : "Start review"}
          </button>

          {err && <div className="text-xs text-[color:var(--color-danger)] font-mono">{err}</div>}

          <div className="text-center">
            <button
              onClick={runDemo}
              disabled={starting}
              className="text-xs font-mono uppercase tracking-wider text-[color:var(--color-primary)] hover:underline"
            >
              Demo mode → preload Self-Refine (NeurIPS) and go
            </button>
          </div>
        </div>

        <footer className="mt-14 text-[11px] font-mono text-[color:var(--color-text-faint)]">
          built with Claude Opus 4.7 · managed agents · mcp · agent skills · mit license
        </footer>
      </div>
    </main>
  );
}
