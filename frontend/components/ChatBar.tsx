"use client";

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { AnimatePresence, motion } from "framer-motion";
import { BACKEND_BASE } from "@/lib/api";

export interface ChatBarHandle {
  /** Drop text into the input and expand the bar; does NOT auto-send. */
  prefill: (text: string) => void;
  /** Drop text in AND send immediately. */
  prefillAndSend: (text: string) => void;
  /** Programmatic expand/collapse. */
  setExpanded: (v: boolean) => void;
}

interface ChatMsg {
  id: string;
  role: "user" | "assistant";
  content: string;
  streaming?: boolean;
}

async function* parseSSE(resp: Response): AsyncGenerator<string, void, unknown> {
  const reader = resp.body?.getReader();
  if (!reader) return;
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const events = buffer.split("\n\n");
    buffer = events.pop() ?? "";
    for (const evt of events) {
      for (const line of evt.split("\n")) {
        if (line.startsWith("data:")) yield line.slice(5).trim();
      }
    }
  }
}

/**
 * Prism-style bottom chat bar. Collapsed = single-row input + hint.
 * Expanded = conversation history above with a compact height cap.
 * Lives across the bottom of the main area; does not steal PDF vertical.
 */
export const ChatBar = forwardRef<ChatBarHandle, { jobId: string }>(function ChatBar(
  { jobId },
  ref
) {
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const listRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`${BACKEND_BASE}/api/jobs/${jobId}/chat/messages`)
      .then((r) => (r.ok ? r.json() : { messages: [] }))
      .then((d) => {
        if (!cancelled) setMessages(d.messages || []);
      });
    return () => {
      cancelled = true;
    };
  }, [jobId]);

  useEffect(() => {
    if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [messages, expanded]);

  // Parent components (e.g. ActionPlan's "Suggest a fix") can call this
  // to drop a pre-formed question into the input and optionally auto-send.
  useImperativeHandle(
    ref,
    () => ({
      prefill: (text: string) => {
        setInput(text);
        setExpanded(true);
        // Focus after the transition settles.
        setTimeout(() => inputRef.current?.focus(), 200);
      },
      prefillAndSend: (text: string) => {
        setInput("");
        setExpanded(true);
        setTimeout(() => {
          // send() reads from `input` state; we pass text explicitly.
          // eslint-disable-next-line @typescript-eslint/no-use-before-define
          void send(text);
        }, 50);
      },
      setExpanded,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [jobId]
  );

  const send = useCallback(
    async (override?: string) => {
      const text = (override ?? input).trim();
      if (!text || sending) return;
      setInput("");
      setSending(true);
      setExpanded(true);
      const streamId = `stream-${Date.now()}`;
      const userId = `u-${Date.now()}`;
      setMessages((m) => [
        ...m,
        { id: userId, role: "user", content: text },
        { id: streamId, role: "assistant", content: "", streaming: true },
      ]);
      try {
        const resp = await fetch(`${BACKEND_BASE}/api/jobs/${jobId}/chat`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
          body: JSON.stringify({ message: text }),
        });
        if (!resp.ok) throw new Error(`chat_${resp.status}`);
        for await (const raw of parseSSE(resp)) {
          if (!raw) continue;
          const evt = JSON.parse(raw);
          if (evt.type === "delta") {
            setMessages((m) =>
              m.map((msg) =>
                msg.id === streamId ? { ...msg, content: msg.content + evt.text } : msg
              )
            );
          } else if (evt.type === "done") {
            setMessages((m) =>
              m.map((msg) =>
                msg.id === streamId ? { ...msg, id: evt.id, streaming: false } : msg
              )
            );
          } else if (evt.type === "error") {
            setMessages((m) =>
              m.map((msg) =>
                msg.id === streamId
                  ? { ...msg, content: `⚠ ${evt.detail || "error"}`, streaming: false }
                  : msg
              )
            );
          }
        }
      } catch (e) {
        setMessages((m) =>
          m.map((msg) =>
            msg.id === streamId
              ? { ...msg, content: `⚠ ${String((e as Error).message || e)}`, streaming: false }
              : msg
          )
        );
      } finally {
        setSending(false);
      }
    },
    [jobId, input, sending]
  );

  const hasMessages = messages.length > 0;

  return (
    <div className="border-t border-[color:var(--color-border)] bg-[color:var(--color-bg)]">
      <AnimatePresence>
        {expanded && hasMessages && (
          <motion.div
            key="list"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 240, opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.18 }}
            className="overflow-hidden"
          >
            <div
              ref={listRef}
              className="h-full overflow-y-auto scroll-pane px-6 py-3 space-y-3"
            >
              {messages.map((m) => (
                <div
                  key={m.id}
                  className={m.role === "user" ? "flex justify-end" : "flex justify-start"}
                >
                  <div
                    className={
                      m.role === "user"
                        ? "max-w-[72%] rounded-xl bg-[color:var(--color-surface-3)] text-[color:var(--color-text)] px-3.5 py-2 text-[13px] leading-relaxed whitespace-pre-wrap"
                        : "max-w-[80%] text-[13px] leading-relaxed whitespace-pre-wrap text-[color:var(--color-text)]"
                    }
                  >
                    {m.content ||
                      (m.streaming ? (
                        <span className="text-[color:var(--color-text-faint)]">…</span>
                      ) : (
                        ""
                      ))}
                    {m.streaming && m.content && <span className="stream-cursor" />}
                  </div>
                </div>
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
      <div className="px-6 py-3">
        <div className="flex items-center gap-2">
          <button
            onClick={() => setExpanded((v) => !v)}
            className={`icon-btn ${!hasMessages ? "opacity-40 cursor-default" : ""}`}
            disabled={!hasMessages}
            title={expanded ? "collapse history" : "expand history"}
            aria-label={expanded ? "collapse history" : "expand history"}
          >
            {expanded ? "▾" : "▴"}
          </button>
          <div className="flex-1 flex items-center gap-2 rounded-xl border border-[color:var(--color-border)] bg-[color:var(--color-surface)] px-4 py-2.5 focus-within:border-[color:var(--color-border-strong)] transition-colors">
            <input
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  send();
                }
              }}
              disabled={sending}
              placeholder="Ask anything about this review…"
              className="flex-1 bg-transparent outline-none text-[13.5px] placeholder:text-[color:var(--color-text-faint)]"
            />
            <button
              onClick={() => send()}
              disabled={sending || !input.trim()}
              className="icon-btn text-[color:var(--color-primary)] disabled:text-[color:var(--color-text-faint)]"
              aria-label="send"
              title="send (↵)"
            >
              {sending ? "…" : "↑"}
            </button>
          </div>
          <span className="text-[10px] font-mono uppercase tracking-wider text-[color:var(--color-text-faint)] hidden md:inline-block">
            Opus&nbsp;4.7
          </span>
        </div>
      </div>
    </div>
  );
});

function _ChatBarImperativeSetup() {}
