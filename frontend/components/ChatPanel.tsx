"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { BACKEND_BASE } from "@/lib/api";

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
        if (line.startsWith("data:")) {
          yield line.slice(5).trim();
        }
      }
    }
  }
}

export function ChatPanel({ jobId }: { jobId: string }) {
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const textAreaRef = useRef<HTMLTextAreaElement | null>(null);

  // Load prior messages on mount.
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
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages]);

  const send = useCallback(
    async (messageOverride?: string) => {
      const text = (messageOverride ?? input).trim();
      if (!text || sending) return;
      setInput("");
      setSending(true);
      // Optimistic user turn + placeholder streaming assistant turn.
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

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  return (
    <div className="flex flex-col h-full">
      <div
        ref={scrollRef}
        className="flex-1 min-h-0 overflow-y-auto scroll-pane px-3 py-3 space-y-3"
      >
        {messages.length === 0 ? (
          <div className="h-full flex items-center justify-center text-center text-[12px] text-[color:var(--color-text-faint)] font-mono px-4">
            <div>
              <div className="mb-2">ask about this review</div>
              <div className="text-[10.5px] space-y-0.5">
                <div>· which critique should I tackle first?</div>
                <div>· draft a rebuttal to the ablation concern</div>
                <div>· explain the disagreement on baselines</div>
              </div>
            </div>
          </div>
        ) : (
          <AnimatePresence initial={false}>
            {messages.map((m) => (
              <motion.div
                key={m.id}
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                className={
                  m.role === "user"
                    ? "flex justify-end"
                    : "flex justify-start"
                }
              >
                <div
                  className={
                    m.role === "user"
                      ? "max-w-[85%] rounded-lg bg-[color:var(--color-surface-3)] text-[color:var(--color-text)] px-3 py-2 text-[13px] leading-relaxed whitespace-pre-wrap"
                      : "max-w-[90%] text-[13px] leading-relaxed whitespace-pre-wrap text-[color:var(--color-text)]"
                  }
                >
                  {m.content || (m.streaming ? <span className="text-[color:var(--color-text-faint)]">…</span> : "")}
                  {m.streaming && m.content && <span className="stream-cursor" />}
                </div>
              </motion.div>
            ))}
          </AnimatePresence>
        )}
      </div>
      <div className="border-t border-[color:var(--color-border)] px-3 py-2.5 bg-[color:var(--color-surface)]">
        <div className="flex items-end gap-2 card-tight px-3 py-2">
          <textarea
            ref={textAreaRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKey}
            rows={1}
            disabled={sending}
            placeholder="Ask about the review…"
            className="flex-1 bg-transparent resize-none outline-none text-[13px] placeholder:text-[color:var(--color-text-faint)] max-h-32"
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
      </div>
    </div>
  );
}
