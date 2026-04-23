"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useDropzone } from "react-dropzone";
import { motion, AnimatePresence } from "framer-motion";
import { ArrowRight, Link as LinkIcon, Settings2, Sparkles, UploadCloud, Zap } from "lucide-react";
import { Logo } from "@/components/Logo";
import { JournalSelector, type JournalSelection } from "@/components/JournalSelector";
import {
  createJobFromArxiv,
  createJobFromFile,
  fetchJournals,
  startJob,
  type JobCreateResponse,
} from "@/lib/api";
import type { DetectedVenue, JournalProfile } from "@/lib/types";

const DEMO_ARXIV_ID = "2303.17651";

export default function Landing() {
  const router = useRouter();
  const [file, setFile] = useState<File | null>(null);
  const [arxivInput, setArxivInput] = useState("");
  const [journal, setJournal] = useState<JournalSelection>({ journal: "" });
  const [profiles, setProfiles] = useState<Record<string, JournalProfile>>({});
  const [starting, setStarting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Job that was pre-created when the user dropped a file / entered an arXiv.
  const [preUploadedJobId, setPreUploadedJobId] = useState<string | null>(null);
  const [detecting, setDetecting] = useState(false);
  const [detection, setDetection] = useState<DetectedVenue | null>(null);
  const userPickedRef = useRef<boolean>(false);
  const inFlightSignature = useRef<string | null>(null);

  useEffect(() => {
    fetchJournals().then(setProfiles).catch(() => setProfiles({}));
  }, []);

  // When a JobCreateResponse lands, adopt the detected venue unless the
  // user has already typed their own pick.
  const adoptDetection = useCallback((resp: JobCreateResponse) => {
    setPreUploadedJobId(resp.job_id);
    if (resp.detected_venue) {
      setDetection(resp.detected_venue);
      if (!userPickedRef.current) {
        setJournal({
          journal: resp.detected_venue.journal_id,
          customName:
            resp.detected_venue.journal_id === "custom"
              ? resp.detected_venue.display_name
              : undefined,
        });
      }
    }
  }, []);

  // Kick off upload + detection in the background as soon as we have an input.
  const triggerUpload = useCallback(
    async (source: { kind: "file"; file: File } | { kind: "arxiv"; id: string }) => {
      const sig = source.kind === "file" ? `f:${source.file.name}:${source.file.size}` : `a:${source.id}`;
      if (inFlightSignature.current === sig) return;
      inFlightSignature.current = sig;
      setDetecting(true);
      setErr(null);
      try {
        const resp =
          source.kind === "file"
            ? await createJobFromFile(source.file)
            : await createJobFromArxiv(source.id);
        adoptDetection(resp);
      } catch (e) {
        setErr(String((e as Error).message || e));
        inFlightSignature.current = null;
      } finally {
        setDetecting(false);
      }
    },
    [adoptDetection]
  );

  // File drop.
  const onDrop = useCallback(
    (files: File[]) => {
      if (!files.length) return;
      setFile(files[0]);
      setArxivInput("");
      setPreUploadedJobId(null);
      setDetection(null);
      void triggerUpload({ kind: "file", file: files[0] });
    },
    [triggerUpload]
  );
  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: {
      "application/pdf": [".pdf"],
      "application/zip": [".zip"],
      "text/x-tex": [".tex"],
      "application/x-tex": [".tex"],
    },
    maxFiles: 1,
    disabled: starting,
  });

  // arXiv ID commit (on blur or Enter). Light-weight id-shape check to avoid firing on every keystroke.
  const maybeCommitArxiv = useCallback(() => {
    const val = arxivInput.trim();
    if (!val) return;
    if (!/^\d{4}\.\d{4,6}$|arxiv\.org\/(abs|pdf)\/\d{4}\.\d{4,6}/.test(val)) return;
    setFile(null);
    setPreUploadedJobId(null);
    setDetection(null);
    void triggerUpload({ kind: "arxiv", id: val });
  }, [arxivInput, triggerUpload]);

  const canStart = Boolean((file || arxivInput.trim()) && journal.journal && !starting);

  const go = async (opts?: { arxivId?: string; journal?: JournalSelection }) => {
    const useSel = opts?.journal || journal;
    if (!useSel.journal) {
      setErr("pick a venue first");
      return;
    }
    setErr(null);
    setStarting(true);
    try {
      let jobId: string;
      if (preUploadedJobId && !opts?.arxivId) {
        jobId = preUploadedJobId;
      } else if (opts?.arxivId || (!file && arxivInput.trim())) {
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
      await startJob(jobId, useSel.journal, {
        custom_venue_name: useSel.journal === "custom" ? useSel.customName : undefined,
      });
      router.push(`/review/${jobId}`);
    } catch (e) {
      setErr(String((e as Error).message || e));
      setStarting(false);
    }
  };

  const runDemo = () => {
    userPickedRef.current = true; // demo mode is explicit
    setJournal({ journal: "neurips" });
    setArxivInput(DEMO_ARXIV_ID);
    setFile(null);
    void go({ arxivId: DEMO_ARXIV_ID, journal: { journal: "neurips" } });
  };

  return (
    <div className="min-h-screen flex flex-col">
      {/* Minimal toolbar */}
      <header className="flex items-center px-5 h-14 border-b border-[color:var(--color-border)]">
        <div className="flex items-center gap-2.5">
          <Logo size={22} />
          <span className="font-display text-[var(--text-md)] tracking-tight">PeerMind</span>
        </div>
        <div className="flex-1 text-center">
          <span className="eyebrow">New review</span>
        </div>
        <button className="icon-btn" aria-label="settings" title="settings">
          <Settings2 size={16} />
        </button>
      </header>

      {/* Centered card */}
      <main className="flex-1 flex items-center justify-center px-5 py-10">
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.3, ease: "easeOut" }}
          className="w-full max-w-[560px]"
        >
          <div className="card-raised p-[var(--space-7)]">
            <motion.div
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.08, duration: 0.3 }}
              className="mb-[var(--space-6)]"
            >
              <span className="chip chip-accent mb-4">
                <Zap size={11} strokeWidth={2.5} />
                Results in 90 seconds
              </span>
              <h1
                className="font-display font-semibold leading-[1.05] text-[color:var(--color-text)]"
                style={{ fontSize: "var(--text-2xl)" }}
              >
                Your paper's<br />toughest reviewer.
              </h1>
              <p className="mt-4 text-[color:var(--color-text-muted)] text-[var(--text-base)] leading-relaxed">
                Two adversarial reviewers critique your paper against the target venue&apos;s real rubric.
                A literature scout finds what you missed. A code runner checks it actually runs.
              </p>
            </motion.div>

            <div className="tick-divider my-[var(--space-5)]" />

            {/* Upload */}
            <div {...getRootProps()} className="dropzone px-6 py-8 cursor-pointer text-center" data-drag={isDragActive}>
              <input {...getInputProps()} />
              <div className="mx-auto w-10 h-10 rounded-full flex items-center justify-center bg-[color:var(--color-surface-2)] text-[color:var(--color-primary)] mb-3">
                <UploadCloud size={20} strokeWidth={1.75} />
              </div>
              {file ? (
                <>
                  <div className="font-mono text-[var(--text-sm)]">{file.name}</div>
                  <div className="eyebrow mt-1">{(file.size / 1024).toFixed(1)} KB · drop again to replace</div>
                </>
              ) : isDragActive ? (
                <div className="text-[var(--text-sm)]">Drop to upload.</div>
              ) : (
                <>
                  <div className="text-[var(--text-sm)] text-[color:var(--color-text)]">
                    Drop your paper, or click to browse
                  </div>
                  <div className="eyebrow mt-1">
                    Overleaf .zip · .tex · .pdf
                  </div>
                  <div className="text-[10px] font-mono mt-0.5" style={{ color: "var(--color-text-faint)" }}>
                    full projects supported — main + bib + sections + figures
                  </div>
                </>
              )}
            </div>

            {/* or — arXiv input */}
            <div className="flex items-center gap-3 my-[var(--space-4)]">
              <div className="flex-1 tick-divider" />
              <span className="eyebrow">or</span>
              <div className="flex-1 tick-divider" />
            </div>

            <label className="input">
              <LinkIcon size={15} className="text-[color:var(--color-text-faint)]" />
              <input
                value={arxivInput}
                onChange={(e) => {
                  setArxivInput(e.target.value);
                  setFile(null);
                  setPreUploadedJobId(null);
                  setDetection(null);
                }}
                onBlur={maybeCommitArxiv}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    maybeCommitArxiv();
                  }
                }}
                placeholder="Paste an arXiv URL or ID — e.g. 2303.17651"
                disabled={starting}
                spellCheck={false}
              />
            </label>

            {/* Detection status + venue selector */}
            <div className="my-[var(--space-5)]">
              <AnimatePresence>
                {detecting && (
                  <motion.div
                    initial={{ opacity: 0, y: -4 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0 }}
                    className="mb-2 flex items-center gap-2 text-[var(--text-xs)] font-mono"
                    style={{ color: "var(--color-text-muted)" }}
                  >
                    <span
                      className="inline-block w-1.5 h-1.5 rounded-full animate-pulse"
                      style={{ background: "var(--color-primary)" }}
                    />
                    classifying venue with Haiku 4.5…
                  </motion.div>
                )}
              </AnimatePresence>

              <JournalSelector
                profiles={profiles}
                value={journal}
                onChange={(sel) => {
                  userPickedRef.current = true;
                  setJournal(sel);
                }}
              />

              {/* Detection rationale chip, shown after auto-fill */}
              <AnimatePresence>
                {detection && !userPickedRef.current && journal.journal && (
                  <motion.div
                    initial={{ opacity: 0, y: -4 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0 }}
                    className="mt-2 flex items-start gap-2 text-[var(--text-xs)] leading-snug"
                    style={{ color: "var(--color-text-muted)" }}
                  >
                    <Sparkles size={12} style={{ color: "var(--color-primary-strong)" }} className="mt-0.5 shrink-0" />
                    <span>
                      <span
                        className="font-mono mr-1"
                        style={{ color: "var(--color-primary-strong)" }}
                      >
                        auto-detected
                      </span>
                      {detection.rationale || `Pattern matches ${detection.display_name}.`}
                    </span>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>

            {/* Primary CTA */}
            <button
              onClick={() => void go()}
              disabled={!canStart}
              className="btn btn-primary w-full"
              style={{ padding: "var(--space-4) var(--space-4)", fontSize: "var(--text-base)" }}
            >
              {starting ? "Starting review…" : "Start review"}
            </button>

            {err && (
              <div className="mt-3 text-[var(--text-sm)] text-[color:var(--color-danger)] font-mono">
                {err}
              </div>
            )}

            <div className="mt-4 text-center">
              <button
                onClick={runDemo}
                disabled={starting}
                className="btn-ghost inline-flex items-center gap-1.5 text-[var(--text-sm)]"
              >
                <span>Demo mode — preload Self-Refine on NeurIPS</span>
                <ArrowRight size={14} />
              </button>
            </div>
          </div>

          <div className="mt-5 text-center eyebrow text-[color:var(--color-text-faint)]">
            Built on Claude Opus 4.7 · Haiku 4.5 · Managed Agents · MCP
          </div>
        </motion.div>
      </main>
    </div>
  );
}
