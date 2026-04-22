"use client";

import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";

export function PDFPreview({
  jobId,
  version,
  compiling,
  error,
}: {
  jobId: string;
  version: number;
  compiling: boolean;
  error: string | null;
}) {
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    // Give the backend a moment to write the file on compile_success.
    const t = setTimeout(() => {
      setUrl(`/api/jobs/${jobId}/output.pdf?v=${version}`);
    }, 150);
    return () => clearTimeout(t);
  }, [jobId, version]);

  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center justify-between px-3 py-2 text-xs font-mono uppercase tracking-wider text-[color:var(--color-text-dim)] border-b border-[color:var(--color-border)]">
        <span>PDF preview</span>
        <AnimatePresence mode="wait">
          {compiling ? (
            <motion.span
              key="compiling"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="flex items-center gap-1.5 text-[color:var(--color-primary)]"
            >
              <span className="inline-block w-2 h-2 bg-[color:var(--color-primary)] rounded-full animate-pulse" />
              compiling…
            </motion.span>
          ) : error ? (
            <motion.span
              key="error"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              className="text-[color:var(--color-danger)]"
            >
              ✗ compile failed
            </motion.span>
          ) : version > 0 ? (
            <motion.span
              key="ok"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              className="text-[color:var(--color-champion)]"
            >
              ✓ v{version}
            </motion.span>
          ) : (
            <motion.span key="waiting" initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
              waiting
            </motion.span>
          )}
        </AnimatePresence>
      </div>
      <div className="flex-1 min-h-0 bg-[color:var(--color-surface-2)]">
        <AnimatePresence mode="wait">
          {url && version > 0 ? (
            <motion.iframe
              key={url}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.3 }}
              src={url}
              className="w-full h-full bg-white"
              title="Compiled PDF"
            />
          ) : (
            <motion.div
              key="placeholder"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              className="h-full flex items-center justify-center text-xs font-mono text-[color:var(--color-text-faint)]"
            >
              {compiling ? "compiling initial PDF…" : "PDF will appear here once compiled"}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
      {error && (
        <details className="border-t border-[color:var(--color-border)] bg-[color:var(--color-surface-2)]">
          <summary className="px-3 py-2 text-xs font-mono text-[color:var(--color-text-dim)] cursor-pointer">
            view last compile log
          </summary>
          <pre className="px-3 py-2 text-[11px] font-mono max-h-40 overflow-auto scroll-pane text-[color:var(--color-danger)]">
            {error}
          </pre>
        </details>
      )}
    </div>
  );
}
