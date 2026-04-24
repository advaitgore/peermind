"use client";

import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { motion, AnimatePresence } from "framer-motion";
import type { ReactNode } from "react";
import { ArrowUp, ChevronDown, ChevronRight } from "lucide-react";
import { useJob } from "@/lib/store";
import type { ChatTurn } from "@/lib/store";
import { Logo } from "./Logo";
import { VerdictCard } from "./VerdictCard";
import { ReasoningTrace } from "./ReasoningTrace";
import { RebuttalPanel } from "./RebuttalPanel";
import { GuidedActionPlan } from "./GuidedActionPlan";
import { ActionPlan, type ActionPlanHandlers } from "./ActionPlan";

export interface ConversationRailHandle {
  sendFromOutside: (text: string) => void;
}

interface Message {
  key: string;
  body: ReactNode;
  pending?: boolean;
}

function prettyRec(r: string | undefined): string {
  if (!r) return "—";
  return r
    .split("_")
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join(" ");
}

export const ConversationRail = forwardRef<
  ConversationRailHandle,
  {
    jobId: string;
    critiqueDelta: number | undefined;
    handlers: ActionPlanHandlers;
    appliedActionIds: Set<string>;
  }
>(function ConversationRail(
  { jobId, critiqueDelta, handlers, appliedActionIds },
  ref
) {
  const store = useJob();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [input, setInput] = useState("");

  const messages = useMemo(
    () =>
      buildMessages(store, handlers, appliedActionIds, jobId, critiqueDelta),
    [store, handlers, appliedActionIds, jobId, critiqueDelta]
  );

  // Load chat history once per job.
  useEffect(() => {
    void useJob.getState().loadChatHistory(jobId);
  }, [jobId]);

  // Autoscroll only when a brand-new message or chat-turn appears AND the
  // user is already near the bottom. Stepping through guide items swaps a
  // single bubble in place (same total count) — we explicitly don't want
  // to yank the viewport when that happens.
  const prevTotalsRef = useRef({ msgs: 0, chat: 0 });
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const prev = prevTotalsRef.current;
    const msgs = messages.length;
    const chat = store.chatMessages.length;
    const grew = msgs > prev.msgs || chat > prev.chat;
    prevTotalsRef.current = { msgs, chat };
    if (!grew) return;
    const nearBottom =
      el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    if (!nearBottom) return;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [
    messages.length,
    store.chatMessages.length,
    store.chatMessages[store.chatMessages.length - 1]?.content,
  ]);

  const submit = (text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    setInput("");
    void useJob.getState().sendChat(jobId, trimmed);
  };

  useImperativeHandle(
    ref,
    () => ({
      sendFromOutside: (text: string) => submit(text),
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [jobId]
  );

  return (
    <>
      <div
        ref={containerRef}
        className="flex-1 min-h-0 overflow-y-auto scroll-pane px-[var(--space-4)] py-[var(--space-4)] space-y-[var(--space-3)]"
      >
        {/* No AnimatePresence here — exit/layout animations were yanking the
            scroll position on every guide-step advance. Messages just mount
            with a quick fade; that's enough. */}
        {messages.map((m) => (
          <motion.div
            key={m.key}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.22, ease: "easeOut" }}
          >
            <NarratorBubble pending={m.pending}>{m.body}</NarratorBubble>
          </motion.div>
        ))}

        {/* Chat turns appended at the end of the feed. */}
        {store.chatMessages.map((m) => (
          <motion.div
            key={m.id}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.2 }}
          >
            {m.role === "user" ? (
              <UserBubble>{m.content}</UserBubble>
            ) : (
              <NarratorBubble pending={m.streaming}>
                <span className="whitespace-pre-wrap">{m.content || ""}</span>
              </NarratorBubble>
            )}
          </motion.div>
        ))}
      </div>

      {/* Inline composer — ask PeerMind anything about this review. */}
      <RailComposer
        input={input}
        setInput={setInput}
        sending={store.chatSending}
        onSend={() => submit(input)}
      />
    </>
  );
});

function NarratorBubble({
  children,
  pending,
}: {
  children: ReactNode;
  pending?: boolean;
}) {
  return (
    <div
      className="rounded-[var(--radius-md)] border px-[var(--space-3)] py-[var(--space-3)]"
      style={{
        background: "var(--color-surface-1)",
        borderColor: "var(--color-border)",
      }}
    >
      <div className="flex items-center gap-2 mb-[var(--space-2)]">
        <span
          className="inline-flex items-center justify-center rounded-full shrink-0"
          style={{
            width: 18,
            height: 18,
            background: "var(--color-primary-highlight)",
            color: "var(--color-primary-strong)",
          }}
        >
          <Logo size={12} />
        </span>
        <span
          className="eyebrow"
          style={{ color: "var(--color-primary-strong)", letterSpacing: "0.14em" }}
        >
          PeerMind
        </span>
        {pending && (
          <span className="inline-flex items-center gap-0.5 ml-1">
            {[0, 1, 2].map((i) => (
              <motion.span
                key={i}
                className="inline-block rounded-full"
                style={{
                  width: 3,
                  height: 3,
                  background: "var(--color-primary-strong)",
                }}
                animate={{ opacity: [0.25, 1, 0.25] }}
                transition={{
                  duration: 1.1,
                  repeat: Infinity,
                  delay: i * 0.18,
                }}
              />
            ))}
          </span>
        )}
      </div>
      <div
        className="text-[var(--text-sm)] leading-relaxed"
        style={{ color: "var(--color-text)" }}
      >
        {children}
      </div>
    </div>
  );
}

function UserBubble({ children }: { children: ReactNode }) {
  return (
    <div className="flex justify-end">
      <div
        className="max-w-[85%] rounded-[var(--radius-md)] px-[var(--space-3)] py-[var(--space-2)] text-[var(--text-sm)] leading-relaxed whitespace-pre-wrap"
        style={{
          background: "var(--color-surface-3)",
          color: "var(--color-text)",
          border: "1px solid var(--color-border)",
        }}
      >
        {children}
      </div>
    </div>
  );
}

function RailComposer({
  input,
  setInput,
  sending,
  onSend,
}: {
  input: string;
  setInput: (v: string) => void;
  sending: boolean;
  onSend: () => void;
}) {
  return (
    <div className="border-t border-[color:var(--color-border)] px-[var(--space-3)] py-[var(--space-2)]">
      <div className="flex items-center gap-2">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              onSend();
            }
          }}
          placeholder="Ask PeerMind about this review…"
          className="flex-1 min-w-0 rounded-[var(--radius-md)] px-3 py-2 text-[var(--text-sm)] outline-none"
          style={{
            background: "var(--color-surface-2)",
            border: "1px solid var(--color-border)",
            color: "var(--color-text)",
          }}
        />
        <button
          onClick={onSend}
          disabled={sending || !input.trim()}
          className="icon-btn shrink-0"
          aria-label="send"
          title="Send (Enter)"
        >
          <ArrowUp size={14} />
        </button>
      </div>
    </div>
  );
}

/**
 * Expandable dropdown attached to a reviewer bubble. While the reviewer is
 * still streaming tokens, `defaultOpen` is true and the body shows the live
 * prose with a blinking caret. Once the final JSON parses, the body swaps
 * to a structured summary + weakness/strength list, and the dropdown
 * collapses (the user can re-open it).
 */
function ReviewerDetails({
  round,
  which,
  defaultOpen,
}: {
  round: number;
  which: "skeptic" | "champion";
  defaultOpen: boolean;
}) {
  const rounds = useJob((s) => s.rounds);
  const rnd = rounds[round];
  const review = rnd
    ? which === "skeptic"
      ? rnd.skepticReview
      : rnd.championReview
    : undefined;
  const streamedText = rnd
    ? which === "skeptic"
      ? rnd.skepticText
      : rnd.championText
    : "";
  const streaming = !review && streamedText.length > 0;
  const [open, setOpen] = useState(defaultOpen);
  const bodyRef = useRef<HTMLDivElement | null>(null);

  // Autoscroll while streaming so the newest tokens stay in view.
  useEffect(() => {
    if (open && streaming && bodyRef.current) {
      bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
    }
  }, [streamedText, open, streaming]);

  // When streaming starts, snap the dropdown open; when the review settles,
  // leave it however the user last toggled it.
  useEffect(() => {
    if (streaming) setOpen(true);
  }, [streaming]);

  if (!rnd) return null;
  const hasAnything = streamedText.length > 0 || Boolean(review);
  if (!hasAnything) return null;

  const label = streaming
    ? "Hide live stream"
    : review
    ? open
      ? "Hide details"
      : "Show what they said"
    : open
    ? "Hide"
    : "Show";

  return (
    <div className="mt-2">
      <button
        onClick={() => setOpen((v) => !v)}
        className="btn-ghost inline-flex items-center gap-1 text-[var(--text-xs)]"
      >
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        {open ? label.startsWith("Hide") ? label : `Hide` : label}
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="overflow-hidden"
          >
            <div className="mt-2 space-y-2">
              {review ? (
                <>
                  {review.summary && (
                    <div
                      className="text-[var(--text-sm)] leading-relaxed"
                      style={{ color: "var(--color-text-muted)" }}
                    >
                      {review.summary}
                    </div>
                  )}
                  {review.weaknesses && review.weaknesses.length > 0 && (
                    <div>
                      <div
                        className="eyebrow mb-1"
                        style={{ color: "var(--color-skeptic)" }}
                      >
                        Weaknesses
                      </div>
                      <ul className="space-y-1.5">
                        {review.weaknesses.slice(0, 6).map((w, i) => (
                          <li
                            key={i}
                            className="text-[var(--text-sm)] leading-snug flex gap-2"
                          >
                            <span
                              className="mt-1.5 shrink-0 w-1 h-1 rounded-full"
                              style={{
                                background:
                                  w.severity === "critical"
                                    ? "var(--color-skeptic)"
                                    : w.severity === "major"
                                    ? "var(--color-warning)"
                                    : "var(--color-text-faint)",
                              }}
                            />
                            <span>{w.issue}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {review.strengths && review.strengths.length > 0 && (
                    <div>
                      <div
                        className="eyebrow mb-1"
                        style={{ color: "var(--color-champion)" }}
                      >
                        Strengths
                      </div>
                      <ul className="space-y-1">
                        {review.strengths.slice(0, 6).map((s, i) => (
                          <li
                            key={i}
                            className="text-[var(--text-sm)] leading-snug"
                            style={{ color: "var(--color-text-muted)" }}
                          >
                            {s}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </>
              ) : (
                <div
                  ref={bodyRef}
                  className="font-mono whitespace-pre-wrap leading-relaxed max-h-[260px] overflow-y-auto scroll-pane rounded-sm"
                  style={{
                    fontSize: "11px",
                    color: "var(--color-text-muted)",
                    background: "var(--color-surface-2)",
                    border: "1px solid var(--color-border)",
                    padding: "var(--space-2)",
                  }}
                >
                  {streamedText || " "}
                  {streaming && (
                    <motion.span
                      animate={{ opacity: [1, 0, 1] }}
                      transition={{ duration: 0.8, repeat: Infinity }}
                      className="inline-block w-[5px] h-[10px] ml-0.5 align-middle"
                      style={{ background: "var(--color-primary-strong)" }}
                    />
                  )}
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/**
 * Dropdown for the Literature Scout bubble. While the agent is running we
 * show the claim list it's searching for; after it finishes we show the
 * findings.
 */
function ScoutDetails({ inFlight }: { inFlight?: boolean }) {
  const claims = useJob((s) => s.scoutClaimsInFlight);
  const findings = useJob((s) => s.literatureAll);
  const [open, setOpen] = useState(Boolean(inFlight));

  useEffect(() => {
    if (inFlight) setOpen(true);
  }, [inFlight]);

  const hasClaims = claims.length > 0;
  const hasFindings = findings.length > 0;
  if (!hasClaims && !hasFindings) return null;

  return (
    <div className="mt-2">
      <button
        onClick={() => setOpen((v) => !v)}
        className="btn-ghost inline-flex items-center gap-1 text-[var(--text-xs)]"
      >
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        {inFlight
          ? open
            ? "Hide live search"
            : "Show what it's searching"
          : open
          ? "Hide findings"
          : "Show findings"}
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="overflow-hidden"
          >
            <div className="mt-2 space-y-2">
              {inFlight && hasClaims && (
                <div>
                  <div className="eyebrow mb-1" style={{ color: "var(--color-text-faint)" }}>
                    Claims being searched
                  </div>
                  <ul className="space-y-1">
                    {claims.slice(0, 8).map((c, i) => (
                      <li
                        key={i}
                        className="text-[var(--text-sm)] leading-snug flex gap-2"
                        style={{ color: "var(--color-text-muted)" }}
                      >
                        <motion.span
                          className="mt-1.5 shrink-0 w-1 h-1 rounded-full"
                          animate={{ opacity: [0.25, 1, 0.25] }}
                          transition={{
                            duration: 1.1,
                            repeat: Infinity,
                            delay: i * 0.18,
                          }}
                          style={{ background: "var(--color-primary-strong)" }}
                        />
                        <span>{c}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {hasFindings && (
                <div>
                  {inFlight && hasClaims && (
                    <div
                      className="eyebrow mb-1 mt-2"
                      style={{ color: "var(--color-text-faint)" }}
                    >
                      Findings so far
                    </div>
                  )}
                  <ul className="space-y-2">
                    {findings.slice(0, 6).map((f, i) => {
                      const paper = f.papers?.[0];
                      return (
                        <li key={i} className="text-[var(--text-sm)] leading-snug">
                          <div className="flex gap-2">
                            <span
                              className="mt-1.5 shrink-0 w-1 h-1 rounded-full"
                              style={{
                                background:
                                  f.category === "contradicts"
                                    ? "var(--color-skeptic)"
                                    : f.category === "missing_prior_art"
                                    ? "var(--color-warning)"
                                    : "var(--color-primary-strong)",
                              }}
                            />
                            <span>
                              <span style={{ color: "var(--color-text-muted)" }}>
                                {f.claim}
                              </span>
                              {paper && (
                                <>
                                  <br />
                                  <span
                                    className="font-mono"
                                    style={{
                                      fontSize: "11px",
                                      color: "var(--color-text-faint)",
                                    }}
                                  >
                                    {paper.title || paper.id || "(paper)"}
                                    {paper.year ? ` · ${paper.year}` : ""}
                                    {paper.citationCount
                                      ? ` · ${paper.citationCount} citations`
                                      : ""}
                                  </span>
                                </>
                              )}
                            </span>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/**
 * Dropdown for the Code Runner bubble. While running, shows the code
 * blocks queued for execution; after completion, shows the per-block
 * pass/fail results.
 */
function CodeDetails({ inFlight }: { inFlight?: boolean }) {
  const blocks = useJob((s) => s.codeBlocksInFlight);
  const results = useJob((s) => s.codeAll);
  const [open, setOpen] = useState(Boolean(inFlight));

  useEffect(() => {
    if (inFlight) setOpen(true);
  }, [inFlight]);

  const hasBlocks = blocks.length > 0;
  const hasResults = results.length > 0;
  if (!hasBlocks && !hasResults) return null;

  return (
    <div className="mt-2">
      <button
        onClick={() => setOpen((v) => !v)}
        className="btn-ghost inline-flex items-center gap-1 text-[var(--text-xs)]"
      >
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        {inFlight
          ? open
            ? "Hide live runs"
            : "Show what it's running"
          : open
          ? "Hide results"
          : "Show results"}
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="overflow-hidden"
          >
            <div className="mt-2 space-y-2">
              {inFlight && hasBlocks && (
                <ul className="space-y-1.5">
                  {blocks.slice(0, 8).map((b, i) => (
                    <li
                      key={i}
                      className="font-mono leading-snug flex gap-2"
                      style={{ fontSize: "11px", color: "var(--color-text-muted)" }}
                    >
                      <motion.span
                        className="mt-1.5 shrink-0 w-1 h-1 rounded-full"
                        animate={{ opacity: [0.25, 1, 0.25] }}
                        transition={{
                          duration: 1.1,
                          repeat: Infinity,
                          delay: i * 0.18,
                        }}
                        style={{ background: "var(--color-primary-strong)" }}
                      />
                      <span className="min-w-0">
                        <span
                          style={{
                            color: "var(--color-primary-strong)",
                            letterSpacing: "0.06em",
                          }}
                        >
                          {b.language}
                        </span>
                        {b.lines ? (
                          <span style={{ color: "var(--color-text-faint)" }}>
                            {" "}· {b.lines} line{b.lines === 1 ? "" : "s"}
                          </span>
                        ) : null}
                        {b.preview && (
                          <>
                            <br />
                            <span
                              className="truncate block"
                              style={{ color: "var(--color-text-faint)" }}
                            >
                              {b.preview}
                            </span>
                          </>
                        )}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              {hasResults && (
                <ul className="space-y-1.5">
                  {results.slice(0, 8).map((r, i) => (
                    <li
                      key={i}
                      className="text-[var(--text-sm)] leading-snug flex gap-2"
                    >
                      <span
                        className="mt-1.5 shrink-0 w-1 h-1 rounded-full"
                        style={{
                          background:
                            r.status === "passed"
                              ? "var(--color-champion)"
                              : r.status === "failed"
                              ? "var(--color-skeptic)"
                              : "var(--color-warning)",
                        }}
                      />
                      <span>
                        <span
                          className="font-mono"
                          style={{
                            color: "var(--color-primary-strong)",
                            fontSize: "11px",
                            letterSpacing: "0.06em",
                          }}
                        >
                          {r.language}
                        </span>{" "}
                        <span style={{ color: "var(--color-text-muted)" }}>
                          · {r.status}
                        </span>
                        {r.reproducibility_concern && (
                          <>
                            <br />
                            <span
                              style={{ color: "var(--color-text-faint)" }}
                              className="text-[var(--text-xs)]"
                            >
                              {r.reproducibility_concern}
                            </span>
                          </>
                        )}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function buildMessages(
  store: ReturnType<typeof useJob.getState>,
  handlers: ActionPlanHandlers,
  appliedActionIds: Set<string>,
  jobId: string,
  critiqueDelta: number | undefined
): Message[] {
  const out: Message[] = [];
  const venue = store.journalFullName || "the target venue";

  out.push({
    key: "greeting",
    body: (
      <>
        Hi — I'm <strong>PeerMind</strong>, your review co-pilot. I'll have{" "}
        <em>two reviewers</em> look at this for{" "}
        <strong>{venue}</strong>, pull the relevant literature, run any code
        blocks, and synthesize a verdict. I'll walk you through what I find.
      </>
    ),
  });

  // Initial compile status — for .tex / .zip uploads where the PDF has to
  // render before anything else makes sense. arXiv jobs short-circuit to a
  // prebuilt PDF instantly so this bubble never appears for them.
  if (store.pdfCompiling && store.pdfVersion === 0) {
    out.push({
      key: "initial-compile",
      pending: true,
      body: (
        <>Rendering your paper's PDF (this takes a few seconds on first compile)…</>
      ),
    });
  }

  const currentRound = store.currentRound || 1;
  const round = store.rounds[currentRound];
  const skepticDone = Boolean(round?.skepticReview);
  const championDone = Boolean(round?.championReview);
  const skepticStreaming = Boolean(round?.skepticText) && !skepticDone;
  const championStreaming = Boolean(round?.championText) && !championDone;
  const anyRoundStarted = store.currentRound >= 1;

  // One streaming bubble per reviewer while they're mid-stream. The
  // dropdown inside each lets the user watch the live tokens.
  if (anyRoundStarted && !skepticDone) {
    out.push({
      key: "reviewer1-reading",
      pending: true,
      body: (
        <>
          <strong style={{ color: "var(--color-skeptic)" }}>Reviewer 1</strong>{" "}
          is reading the paper now
          {skepticStreaming ? " — open the dropdown to watch live." : "."}
          {skepticStreaming && (
            <ReviewerDetails round={currentRound} which="skeptic" defaultOpen />
          )}
        </>
      ),
    });
  }
  if (anyRoundStarted && !championDone) {
    out.push({
      key: "reviewer2-reading",
      pending: true,
      body: (
        <>
          <strong style={{ color: "var(--color-champion)" }}>Reviewer 2</strong>{" "}
          is reading the paper now
          {championStreaming ? " — open the dropdown to watch live." : "."}
          {championStreaming && (
            <ReviewerDetails round={currentRound} which="champion" defaultOpen />
          )}
        </>
      ),
    });
  }

  if (store.agents.scout.status === "running") {
    out.push({
      key: "scout-running",
      pending: true,
      body: (
        <>
          Literature Scout is searching for prior art on the paper's key claims.
          <ScoutDetails inFlight />
        </>
      ),
    });
  }
  if (store.agents.code_runner.status === "running") {
    out.push({
      key: "code-running",
      pending: true,
      body: (
        <>
          Code Runner is executing the paper's code blocks to check reproducibility.
          <CodeDetails inFlight />
        </>
      ),
    });
  }

  if (skepticDone && round?.skepticReview) {
    const r = round.skepticReview;
    out.push({
      key: "reviewer1-done",
      body: (
        <>
          <strong>Reviewer 1</strong> flagged{" "}
          <strong>{r.weaknesses.length}</strong> weakness
          {r.weaknesses.length === 1 ? "" : "es"} and {r.strengths.length}{" "}
          strength{r.strengths.length === 1 ? "" : "s"}. Recommendation:{" "}
          <em>{prettyRec(r.recommendation)}</em>.
          <ReviewerDetails round={currentRound} which="skeptic" defaultOpen={false} />
        </>
      ),
    });
  }
  if (championDone && round?.championReview) {
    const r = round.championReview;
    out.push({
      key: "reviewer2-done",
      body: (
        <>
          <strong>Reviewer 2</strong> flagged{" "}
          <strong>{r.weaknesses.length}</strong> weakness
          {r.weaknesses.length === 1 ? "" : "es"} and {r.strengths.length}{" "}
          strength{r.strengths.length === 1 ? "" : "s"}. Recommendation:{" "}
          <em>{prettyRec(r.recommendation)}</em>.
          <ReviewerDetails round={currentRound} which="champion" defaultOpen={false} />
        </>
      ),
    });
  }

  if (
    store.literatureAll.length > 0 &&
    store.agents.scout.status !== "running"
  ) {
    const contradict = store.literatureAll.filter(
      (f) => f.category === "contradicts"
    ).length;
    const prior = store.literatureAll.filter(
      (f) => f.category === "missing_prior_art"
    ).length;
    out.push({
      key: "scout-done",
      body: (
        <>
          The Scout pulled <strong>{store.literatureAll.length}</strong>{" "}
          relevant finding
          {store.literatureAll.length === 1 ? "" : "s"}
          {contradict > 0 ? `, ${contradict} contradictory` : ""}
          {prior > 0 ? `, ${prior} missing prior-art` : ""}.
          <ScoutDetails />
        </>
      ),
    });
  }
  if (store.codeAll.length > 0 && store.agents.code_runner.status !== "running") {
    const ok = store.codeAll.filter((c) => c.status === "passed").length;
    out.push({
      key: "code-done",
      body: (
        <>
          Code Runner finished: <strong>{ok}</strong> of {store.codeAll.length}{" "}
          block{store.codeAll.length === 1 ? "" : "s"} reproduced.
          <CodeDetails />
        </>
      ),
    });
  }

  const hasReasoning = store.synthesisReasoning.length > 0;
  const reviewersBothDone = skepticDone && championDone;

  // Synthesis placeholder — appears the moment reviewers are done and
  // disappears as soon as thinking tokens land OR the verdict arrives.
  // Covers the dead air between reviewer completion and Opus 4.7's first
  // thinking delta (can be 5-15s).
  if (reviewersBothDone && !hasReasoning && !store.verdict) {
    out.push({
      key: "synthesizing-pending",
      pending: true,
      body: (
        <>
          Putting it all together — <strong>Opus 4.7</strong> is synthesizing
          the verdict with extended thinking. This usually takes 20-40 seconds.
        </>
      ),
    });
  }

  if (hasReasoning) {
    out.push({
      key: "synthesizing",
      pending: !store.synthesisReasoningDone && !store.verdict,
      body: (
        <div className="space-y-[var(--space-2)]">
          <div>
            Weighing the evidence with extended thinking before committing to a
            verdict.
          </div>
          <ReasoningTrace />
        </div>
      ),
    });
  }

  // Fix-agent placeholder — runs in PARALLEL with synthesis. Shows while
  // reviewers are done and the action plan isn't ready yet, so the user
  // knows the paper is actively being scanned for concrete fixes.
  if (reviewersBothDone && !store.actionPlan) {
    out.push({
      key: "fix-agent-pending",
      pending: true,
      body: (
        <>
          Fix Agent is scanning the paper for concrete edits — citations,
          hedges, missing caveats. Running in parallel with the verdict.
        </>
      ),
    });
  }

  if (store.verdict) {
    out.push({
      key: "verdict",
      body: (
        <div className="space-y-[var(--space-3)]">
          <div>
            Here's my verdict for{" "}
            <strong>{store.title || "your paper"}</strong>.
          </div>
          <VerdictCard verdict={store.verdict} critiqueDelta={critiqueDelta} />
        </div>
      ),
    });
  }

  const authorRequired = store.actionPlan?.author_required ?? [];
  if (store.actionPlan && authorRequired.length > 0) {
    if (store.guideMode === "pending") {
      out.push({
        key: "walkthrough-intro",
        body: (
          <div className="space-y-[var(--space-3)]">
            <div>
              There {authorRequired.length === 1 ? "is" : "are"}{" "}
              <strong>{authorRequired.length}</strong> issue
              {authorRequired.length === 1 ? "" : "s"} you need to look at. Want
              me to walk you through them one by one?
            </div>
            <div className="flex flex-wrap gap-1.5">
              <button
                onClick={() => useJob.getState().setGuideMode("step")}
                className="btn btn-primary"
                style={{ padding: "5px 12px", fontSize: "var(--text-xs)" }}
              >
                Yes, let's go
              </button>
              <button
                onClick={() => useJob.getState().setGuideMode("list")}
                className="btn"
                style={{ padding: "5px 12px", fontSize: "var(--text-xs)" }}
              >
                Show them as a list
              </button>
            </div>
          </div>
        ),
      });
    } else if (store.guideMode === "step") {
      const idx = Math.min(store.guideStep, authorRequired.length - 1);
      const current = authorRequired[idx];
      const applied =
        appliedActionIds.has(current.id) || Boolean(current.applied);
      out.push({
        key: `guide-step-${current.id}`,
        body: (
          <GuidedActionPlan
            item={current}
            index={idx}
            total={authorRequired.length}
            applied={applied}
            handlers={handlers}
            onAdvance={() => useJob.getState().advanceGuide()}
            onShowList={() => useJob.getState().setGuideMode("list")}
          />
        ),
      });
    } else if (store.guideMode === "list") {
      const decoratedPlan = {
        ...store.actionPlan,
        author_required: authorRequired.map((a) => ({
          ...a,
          applied: appliedActionIds.has(a.id) || a.applied,
        })),
      };
      out.push({
        key: "walkthrough-list",
        body: (
          <div className="space-y-[var(--space-2)]">
            <div>
              Here's the full list — tackle them in whatever order works for you.
            </div>
            <ActionPlan plan={decoratedPlan} handlers={handlers} />
            <div className="pt-1">
              <button
                onClick={() => useJob.getState().setGuideMode("step")}
                className="btn-ghost text-[var(--text-xs)]"
              >
                Walk me through them instead
              </button>
            </div>
          </div>
        ),
      });
    } else if (store.guideMode === "done") {
      out.push({
        key: "guide-done",
        body: (
          <div className="space-y-[var(--space-2)]">
            <div>
              That's everything. You can download the edited project zip, grab
              a full review letter, or draft a rebuttal from the footer below.
            </div>
            <button
              onClick={() => useJob.getState().setGuideMode("list")}
              className="btn-ghost text-[var(--text-xs)]"
            >
              Show issues again as a list
            </button>
          </div>
        ),
      });
    }
  }

  if (store.rebuttalStreaming || store.rebuttalComplete) {
    out.push({
      key: "rebuttal",
      pending: store.rebuttalStreaming,
      body: (
        <div className="space-y-[var(--space-3)]">
          <div>
            {store.rebuttalStreaming
              ? "Drafting your rebuttal now — classifying each concern as concede, clarify, or refute."
              : "Here's your rebuttal. Copy it, open it as a letter, or re-draft from the footer if you want to iterate."}
          </div>
          <RebuttalPanel jobId={jobId} />
        </div>
      ),
    });
  }

  if (store.errors.length > 0) {
    out.push({
      key: "errors",
      body: (
        <div className="space-y-1" style={{ color: "var(--color-warning)" }}>
          <div>I hit a few warnings along the way:</div>
          <ul className="list-disc pl-4 text-[11px] font-mono">
            {store.errors.slice(-3).map((e, i) => (
              <li key={i}>{e}</li>
            ))}
          </ul>
        </div>
      ),
    });
  }

  return out;
}

// Silence unused param warnings — the ChatTurn import is load-bearing for
// types in callers.
export type { ChatTurn };
