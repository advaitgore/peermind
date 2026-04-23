"use client";

import dynamic from "next/dynamic";
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { AnimatePresence, motion } from "framer-motion";
import { ChevronLeft, ChevronRight, Download } from "lucide-react";
import { pdfUrl } from "@/lib/api";

export interface PDFPreviewHandle {
  scrollToPage: (page: number, opts?: { flash?: boolean }) => void;
  scrollToRatio: (ratio: number) => void;
}

const Document = dynamic(() => import("react-pdf").then((m) => m.Document), { ssr: false });
const Page = dynamic(() => import("react-pdf").then((m) => m.Page), { ssr: false });

if (typeof window !== "undefined") {
  import("react-pdf").then(({ pdfjs }) => {
    pdfjs.GlobalWorkerOptions.workerSrc = `https://unpkg.com/pdfjs-dist@${pdfjs.version}/build/pdf.worker.min.mjs`;
  });
}

type ZoomMode = "fit-width" | "fit-page" | "custom";

export const PDFPreview = forwardRef<
  PDFPreviewHandle,
  {
    jobId: string;
    version: number;
    compiling: boolean;
    error: string | null;
    title?: string | null;
  }
>(function PDFPreview({ jobId, version, compiling, error, title }, ref) {
  const [numPages, setNumPages] = useState(0);
  const [pageNum, setPageNum] = useState(1);
  const [zoom, setZoom] = useState<ZoomMode>("fit-width");
  const [customScale, setCustomScale] = useState(1.0);
  const [loadError, setLoadError] = useState<string | null>(null);

  const shellRef = useRef<HTMLDivElement | null>(null);
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const pageRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  const [viewport, setViewport] = useState({ w: 0, h: 0 });

  const url = version > 0 ? pdfUrl(jobId, version) : null;
  const file = useMemo(() => (url ? { url } : null), [url]);

  useEffect(() => {
    if (!shellRef.current || version === 0) return;
    const el = shellRef.current;
    el.setAttribute("data-flash", "pulse");
    const t = setTimeout(() => el.removeAttribute("data-flash"), 1300);
    return () => {
      clearTimeout(t);
      el.removeAttribute("data-flash");
    };
  }, [version]);

  useEffect(() => {
    if (!scrollerRef.current) return;
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) setViewport({ w: e.contentRect.width, h: e.contentRect.height });
    });
    ro.observe(scrollerRef.current);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    setPageNum(1);
    setLoadError(null);
    pageRefs.current.clear();
  }, [url]);

  useEffect(() => {
    if (!scrollerRef.current || numPages === 0) return;
    const root = scrollerRef.current;
    const obs = new IntersectionObserver(
      (entries) => {
        let best = { ratio: 0, page: pageNum };
        for (const e of entries) {
          const p = Number((e.target as HTMLElement).dataset.page);
          if (!Number.isFinite(p)) continue;
          if (e.intersectionRatio > best.ratio) best = { ratio: e.intersectionRatio, page: p };
        }
        if (best.ratio > 0 && best.page !== pageNum) setPageNum(best.page);
      },
      { root, threshold: [0.25, 0.5, 0.75] }
    );
    for (const [, el] of pageRefs.current) obs.observe(el);
    return () => obs.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [numPages, url]);

  const scrollToPage = (target: number, opts?: { flash?: boolean }) => {
    const el = pageRefs.current.get(target);
    if (!el || !scrollerRef.current) return;
    scrollerRef.current.scrollTo({ top: el.offsetTop - 16, behavior: "smooth" });
    setPageNum(target);
    if (opts?.flash) {
      el.setAttribute("data-flash", "pulse");
      setTimeout(() => el.removeAttribute("data-flash"), 1300);
    }
  };

  useImperativeHandle(
    ref,
    () => ({
      scrollToPage,
      scrollToRatio: (ratio: number) => {
        if (numPages === 0) return;
        const clamped = Math.max(0, Math.min(1, ratio));
        const target = Math.max(1, Math.min(numPages, Math.ceil(clamped * numPages)));
        scrollToPage(target, { flash: true });
      },
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [numPages]
  );

  const width =
    zoom === "fit-width" ? Math.max(320, viewport.w - 64) : zoom === "fit-page" ? undefined : undefined;
  const height = zoom === "fit-page" ? Math.max(240, viewport.h - 88) : undefined;
  const scale = zoom === "custom" ? customScale : undefined;

  return (
    <div className="h-full flex flex-col">
      {/* Top: breadcrumb title */}
      <div className="flex items-center gap-3 px-[var(--space-4)] h-10 border-b border-[color:var(--color-border)]">
        <span className="eyebrow shrink-0">paper</span>
        <span
          className="text-[var(--text-sm)] truncate"
          style={{ color: "var(--color-text-muted)" }}
        >
          {title || "Loading…"}
        </span>
        <div className="flex-1" />
        <AnimatePresence mode="wait" initial={false}>
          {compiling ? (
            <motion.span
              key="compiling"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="chip chip-accent"
            >
              <span className="inline-block w-1.5 h-1.5 rounded-full bg-[color:var(--color-primary)] animate-pulse" />
              compiling
            </motion.span>
          ) : error || loadError ? (
            <motion.span
              key="err"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              className="chip"
              style={{ color: "var(--color-danger)", borderColor: "var(--color-danger)" }}
            >
              compile error
            </motion.span>
          ) : version > 0 ? (
            <motion.span
              key="ok"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              className="chip"
            >
              v{version}
            </motion.span>
          ) : null}
        </AnimatePresence>
        <a
          href={url || "#"}
          download
          className="icon-btn"
          aria-label="download PDF"
          title="download"
        >
          <Download size={15} />
        </a>
      </div>

      {/* Document on warm offset backdrop */}
      <div
        ref={shellRef}
        className="flex-1 min-h-0 relative overflow-hidden"
        style={{ background: "var(--color-surface-offset)" }}
      >
        <div
          ref={scrollerRef}
          className="absolute inset-0 overflow-auto scroll-pane flex items-start justify-center py-[var(--space-5)] px-[var(--space-5)]"
        >
          {file ? (
            <Document
              file={file}
              onLoadSuccess={({ numPages }) => setNumPages(numPages)}
              onLoadError={(err) => {
                setLoadError(String(err?.message || err));
                setNumPages(0);
              }}
              loading={<DocLoading />}
              error={<DocError />}
              className="pdf-doc-wrap"
            >
              {Array.from({ length: numPages }, (_, i) => i + 1).map((n) => (
                <motion.div
                  key={`${url}-${n}`}
                  ref={(el) => {
                    if (el) pageRefs.current.set(n, el);
                    else pageRefs.current.delete(n);
                  }}
                  data-page={n}
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.22, delay: Math.min(n * 0.015, 0.25) }}
                  className="bg-white relative"
                  style={{ boxShadow: "var(--shadow-md)", borderRadius: "var(--radius-lg)" }}
                >
                  <Page
                    pageNumber={n}
                    width={width}
                    height={height}
                    scale={scale}
                    renderTextLayer={false}
                    renderAnnotationLayer={false}
                    className="pdf-page-render"
                    loading={<PageLoading />}
                  />
                  <span
                    className="absolute -top-5 right-0 font-mono text-[var(--text-xs)]"
                    style={{ color: "var(--color-text-faint)" }}
                  >
                    {String(n).padStart(2, "0")}
                  </span>
                </motion.div>
              ))}
            </Document>
          ) : (
            <div
              className="h-full flex items-center justify-center text-[var(--text-sm)]"
              style={{ color: "var(--color-text-faint)" }}
            >
              {compiling ? "fetching paper…" : "PDF will appear once compiled"}
            </div>
          )}
        </div>
      </div>

      {/* Bottom nav — prev / 07 / 54 / next + zoom */}
      <div className="flex items-center justify-between px-[var(--space-4)] h-11 border-t border-[color:var(--color-border)]">
        <div className="w-[140px]">
          <select
            value={zoom}
            onChange={(e) => setZoom(e.target.value as ZoomMode)}
            className="bg-transparent text-[var(--text-xs)] font-mono uppercase tracking-wider outline-none cursor-pointer"
            style={{ color: "var(--color-text-muted)" }}
            aria-label="zoom"
          >
            <option value="fit-width">Fit width</option>
            <option value="fit-page">Fit page</option>
            <option value="custom">Custom {Math.round(customScale * 100)}%</option>
          </select>
          {zoom === "custom" && (
            <span className="ml-2 inline-flex items-center">
              <button
                className="icon-btn text-[10px]"
                onClick={() => setCustomScale((s) => Math.max(0.4, s - 0.1))}
                aria-label="zoom out"
              >
                −
              </button>
              <button
                className="icon-btn text-[10px]"
                onClick={() => setCustomScale((s) => Math.min(3, s + 0.1))}
                aria-label="zoom in"
              >
                +
              </button>
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            className="icon-btn"
            onClick={() => scrollToPage(Math.max(1, pageNum - 1))}
            disabled={pageNum <= 1}
            aria-label="previous page"
          >
            <ChevronLeft size={16} />
          </button>
          <span
            className="font-mono text-[var(--text-sm)] tabular-nums tracking-wide"
            style={{ color: "var(--color-text)" }}
          >
            {String(pageNum).padStart(2, "0")}
            <span style={{ color: "var(--color-text-faint)" }}> / {String(numPages).padStart(2, "0")}</span>
          </span>
          <button
            className="icon-btn"
            onClick={() => scrollToPage(Math.min(numPages, pageNum + 1))}
            disabled={pageNum >= numPages}
            aria-label="next page"
          >
            <ChevronRight size={16} />
          </button>
        </div>
        <div className="w-[140px]" />
      </div>
    </div>
  );
});

function DocLoading() {
  return (
    <div
      className="flex items-center justify-center text-[var(--text-sm)] font-mono py-20"
      style={{ color: "var(--color-text-faint)" }}
    >
      loading document…
    </div>
  );
}
function DocError() {
  return (
    <div
      className="flex items-center justify-center text-[var(--text-sm)] font-mono py-20"
      style={{ color: "var(--color-danger)" }}
    >
      failed to load PDF
    </div>
  );
}
function PageLoading() {
  return <div className="bg-white" style={{ width: 600, height: 800 }} aria-label="rendering page" />;
}
