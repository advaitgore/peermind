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
import { useJob } from "@/lib/store";
import { PDFLiveEditCard } from "./PDFLiveEditCard";

export interface PDFPreviewHandle {
  scrollToPage: (page: number, opts?: { flash?: boolean }) => void;
  scrollToRatio: (ratio: number) => void;
  getPageRect: (page: number) => DOMRect | null;
  /** Search the PDF text layer for `query`. Scrolls to the first page that
   *  contains it and returns true. Returns false if not found. */
  scrollToText: (query: string) => boolean;
}

const Document = dynamic(() => import("react-pdf").then((m) => m.Document), {
  ssr: false,
});
const Page = dynamic(() => import("react-pdf").then((m) => m.Page), {
  ssr: false,
});

if (typeof window !== "undefined") {
  import("react-pdf").then(({ pdfjs }) => {
    pdfjs.GlobalWorkerOptions.workerSrc = `https://unpkg.com/pdfjs-dist@${pdfjs.version}/build/pdf.worker.min.mjs`;
  });
}

type ZoomMode = "fit-width" | "fit-page" | "custom";

/**
 * Double-buffered PDF renderer.
 *
 * The previous visible `<Document>` stays mounted and on-screen until the
 * next version has loaded + rendered its first page, then we cross-fade
 * them. No blank flash during recompile. Scroll position is preserved
 * because both layers render inside the same scroll container and produce
 * the same flow.
 */
export const PDFPreview = forwardRef<
  PDFPreviewHandle,
  {
    jobId: string;
    version: number;
    compiling: boolean;
    error: string | null;
    title?: string | null;
    /** If set, scroll to this page + flash it immediately after a recompile
     *  cross-fade instead of restoring the old scroll position. */
    postSwapPage?: number | null;
  }
>(function PDFPreview({ jobId, version, compiling, error, title, postSwapPage }, ref) {
  const [pageNum, setPageNum] = useState(1);
  // Per-page text index built from the PDF text layer. Used by scrollToText
  // to find sections without relying on approximate page_hint arithmetic.
  const pageTextMap = useRef<Map<number, string>>(new Map());
  // Page to show the teal hover-highlight overlay on (after a successful apply).
  const [highlightPage, setHighlightPage] = useState<number | null>(null);
  const activeFixState = useJob((s) => s.activeFixState);
  const activeFix = useJob((s) => s.activeFix);
  // Clear highlight when the fix card is dismissed.
  useEffect(() => {
    if (!activeFix) setHighlightPage(null);
  }, [activeFix]);

  // When the patch finishes applying ("applied" state), set the highlight
  // page so the teal overlay appears on the edited page (without scrolling
  // there). Auto-clear activeFix after 8 seconds.
  useEffect(() => {
    if (activeFixState !== "applied") return;
    setHighlightPage(activeFix?.page_hint ?? null);
    const t = setTimeout(
      () => useJob.setState({ activeFix: null, activeFixState: null }),
      8000
    );
    return () => clearTimeout(t);
  }, [activeFixState, activeFix?.page_hint]);
  // Pending scroll target — set by jumpToPageFn, consumed by registerPage
  // callback when the target page element mounts with a valid offsetTop.
  const pendingScrollTargetRef = useRef<number | null>(null);
  const [zoom, setZoom] = useState<ZoomMode>("fit-width");
  const [customScale, setCustomScale] = useState(1.0);
  const [loadError, setLoadError] = useState<string | null>(null);

  const shellRef = useRef<HTMLDivElement | null>(null);
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  // Page refs for the *visible* layer only — used for scroll-to-page and
  // page-rect measurement. Staging pages never get scrolled into by the
  // user explicitly.
  const pageRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  const [viewport, setViewport] = useState({ w: 0, h: 0 });

  const nextUrl = version > 0 ? pdfUrl(jobId, version) : null;

  // `visibleUrl` is what's actually mounted in the flow. `stagingUrl` is
  // the new URL that's loading in an absolute-positioned overlay waiting
  // to be promoted. `swapping` flips true once staging has loaded — both
  // layers transition opacity, then visibleUrl is promoted.
  const [visibleUrl, setVisibleUrl] = useState<string | null>(null);
  const [visibleVersion, setVisibleVersion] = useState<number>(0);
  const [visiblePageCount, setVisiblePageCount] = useState(0);

  const [stagingUrl, setStagingUrl] = useState<string | null>(null);
  const [stagingVersion, setStagingVersion] = useState<number>(0);
  const [stagingReady, setStagingReady] = useState(false);
  const [stagingPageCount, setStagingPageCount] = useState(0);

  // When version advances, start staging (or mount directly on first load).
  useEffect(() => {
    if (!nextUrl || version === 0) return;
    if (visibleUrl === null) {
      setVisibleUrl(nextUrl);
      setVisibleVersion(version);
      return;
    }
    if (version === visibleVersion) return;
    setStagingUrl(nextUrl);
    setStagingVersion(version);
    setStagingReady(false);
  }, [nextUrl, version, visibleUrl, visibleVersion]);

  // Watchdog — if staging takes longer than 8s to become ready (e.g.,
  // react-pdf hits a transient InvalidPDFException and never recovers),
  // force-promote so the user isn't stuck on the old PDF forever.
  useEffect(() => {
    if (!stagingUrl || stagingReady) return;
    const t = setTimeout(() => {
      setStagingReady(true);
    }, 8000);
    return () => clearTimeout(t);
  }, [stagingUrl, stagingReady]);

  // Perform the actual scroll + highlight once we have a valid element.
  // Called either immediately (if page is already mounted) or from the
  // registerPage callback (when the page mounts after a swap).
  const _doScroll = (target: number, el: HTMLDivElement) => {
    if (pendingScrollTargetRef.current !== target) return; // stale / already done
    pendingScrollTargetRef.current = null;
    if (!scrollerRef.current) return;
    scrollerRef.current.scrollTop = el.offsetTop - 16;
    setPageNum(target);
    el.setAttribute("data-flash", "pulse");
    setTimeout(() => el.removeAttribute("data-flash"), 1800);
    // Highlight + 8s clear are now handled by the activeFixState effect,
    // not here — this function only handles user-initiated scrolls.
  };

  // Kick off a scroll-to-page. Sets the pending target so registerPage
  // will pick it up if the page isn't mounted yet. Also tries immediately
  // in case pageRefs already has the element (e.g. user-initiated scroll).
  const jumpToPageFn = (target: number) => {
    pendingScrollTargetRef.current = target;
    const el = pageRefs.current.get(target);
    if (el && scrollerRef.current && el.offsetTop > 0) {
      _doScroll(target, el);
    }
    // Otherwise registerPage will handle it when the page mounts.
  };

  // Once staging's first page has rendered, transition.
  useEffect(() => {
    if (!stagingReady || stagingUrl === null) return;
    const scrollTop = scrollerRef.current?.scrollTop ?? 0;
    const t = setTimeout(() => {
      setVisibleUrl(stagingUrl);
      setVisibleVersion(stagingVersion);
      setVisiblePageCount(stagingPageCount);
      setStagingUrl(null);
      setStagingReady(false);
      setStagingPageCount(0);
      pageRefs.current.clear();
      pageTextMap.current.clear();
      // Always restore the user's pre-swap scroll position. The "where to
      // edit" navigation happened earlier (when the walkthrough step
      // rendered, via scrollToText). On apply the viewport should stay
      // exactly where the user already is. The teal hover overlay on the
      // edited page is set independently via the activeFixState effect.
      requestAnimationFrame(() => {
        if (scrollerRef.current) scrollerRef.current.scrollTop = scrollTop;
        if (shellRef.current) {
          shellRef.current.setAttribute("data-flash", "pulse");
          setTimeout(() => shellRef.current?.removeAttribute("data-flash"), 1800);
        }
      });
    }, 280);
    return () => clearTimeout(t);
  }, [stagingReady, stagingUrl, stagingVersion, stagingPageCount]); // eslint-disable-line react-hooks/exhaustive-deps

  // Resize observation for fit-width.
  useEffect(() => {
    if (!scrollerRef.current) return;
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) {
        setViewport({ w: e.contentRect.width, h: e.contentRect.height });
      }
    });
    ro.observe(scrollerRef.current);
    return () => ro.disconnect();
  }, []);

  // Intersection observer to track which page is "current" while scrolling.
  useEffect(() => {
    if (!scrollerRef.current || visiblePageCount === 0) return;
    const root = scrollerRef.current;
    const obs = new IntersectionObserver(
      (entries) => {
        let best = { ratio: 0, page: pageNum };
        for (const e of entries) {
          const p = Number((e.target as HTMLElement).dataset.page);
          if (!Number.isFinite(p)) continue;
          if (e.intersectionRatio > best.ratio)
            best = { ratio: e.intersectionRatio, page: p };
        }
        if (best.ratio > 0 && best.page !== pageNum) setPageNum(best.page);
      },
      { root, threshold: [0.25, 0.5, 0.75] }
    );
    for (const [, el] of pageRefs.current) obs.observe(el);
    return () => obs.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visiblePageCount, visibleUrl]);

  const scrollToPage = (target: number, opts?: { flash?: boolean }) => {
    const el = pageRefs.current.get(target);
    if (!el || !scrollerRef.current) return;
    scrollerRef.current.scrollTo({ top: el.offsetTop - 16, behavior: "smooth" });
    setPageNum(target);
    if (opts?.flash) {
      el.setAttribute("data-flash", "pulse");
      setTimeout(() => el.removeAttribute("data-flash"), 1800);
    }
  };

  useImperativeHandle(
    ref,
    () => ({
      scrollToPage,
      scrollToRatio: (ratio: number) => {
        if (visiblePageCount === 0) return;
        const clamped = Math.max(0, Math.min(1, ratio));
        const target = Math.max(
          1,
          Math.min(visiblePageCount, Math.ceil(clamped * visiblePageCount))
        );
        scrollToPage(target, { flash: true });
      },
      getPageRect: (page: number) => {
        const el = pageRefs.current.get(page);
        return el ? el.getBoundingClientRect() : null;
      },
      scrollToText: (query: string): boolean => {
        const q = query.toLowerCase().replace(/\s+/g, " ").trim();
        if (!q) return false;
        const dotLeaderRe = /\.(\s*\.){2,}/;
        let foundPage: number | null = null;
        for (let p = 1; p <= visiblePageCount; p++) {
          const text = pageTextMap.current.get(p);
          if (!text || !text.includes(q)) continue;
          if (dotLeaderRe.test(text)) continue;
          foundPage = p;
          break;
        }
        if (foundPage === null) {
          for (let p = 1; p <= visiblePageCount; p++) {
            const text = pageTextMap.current.get(p);
            if (text?.includes(q)) { foundPage = p; break; }
          }
        }
        if (foundPage === null) return false;

        // Poll for the text-layer spans on that page. onGetTextSuccess
        // fires when the text content is *extracted*, but the matching
        // <span> nodes may not be in the DOM yet. Retry up to ~1.5s.
        const target = foundPage;
        const tryScrollToSpan = (attempts = 0): void => {
          const pageEl = pageRefs.current.get(target);
          if (!pageEl || !scrollerRef.current) {
            if (attempts < 15) setTimeout(() => tryScrollToSpan(attempts + 1), 100);
            return;
          }
          const spans = pageEl.querySelectorAll<HTMLElement>(
            ".react-pdf__Page__textContent span"
          );
          if (spans.length === 0) {
            // Text layer not in DOM yet — retry.
            if (attempts < 15) {
              setTimeout(() => tryScrollToSpan(attempts + 1), 100);
              return;
            }
            // Give up — at least scroll to page top.
            jumpToPageFn(target);
            return;
          }
          for (const span of spans) {
            if (span.textContent?.toLowerCase().includes(q)) {
              const pageRect = pageEl.getBoundingClientRect();
              const spanRect = span.getBoundingClientRect();
              const spanOffsetInPage = spanRect.top - pageRect.top;
              const scrollTop =
                pageEl.offsetTop + spanOffsetInPage - 80;
              scrollerRef.current.scrollTop = Math.max(0, scrollTop);
              setPageNum(target);
              pageEl.setAttribute("data-flash", "pulse");
              setTimeout(() => pageEl.removeAttribute("data-flash"), 1800);
              return;
            }
          }
          // Spans rendered but none matched — page top fallback.
          jumpToPageFn(target);
        };
        tryScrollToSpan();
        return true;
      },
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [visiblePageCount]
  );

  const width =
    zoom === "fit-width"
      ? Math.max(320, viewport.w - 64)
      : zoom === "fit-page"
      ? undefined
      : undefined;
  const height =
    zoom === "fit-page" ? Math.max(240, viewport.h - 88) : undefined;
  const scale = zoom === "custom" ? customScale : undefined;

  const recompiling =
    (compiling && !error && !loadError) || stagingUrl !== null;

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
          {recompiling ? (
            <motion.span
              key="compiling"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="chip chip-accent"
            >
              <span className="inline-block w-1.5 h-1.5 rounded-full bg-[color:var(--color-primary)] animate-pulse" />
              recompiling
            </motion.span>
          ) : error || loadError ? (
            <motion.span
              key="err"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              className="chip"
              style={{
                color: "var(--color-danger)",
                borderColor: "var(--color-danger)",
              }}
            >
              compile error
            </motion.span>
          ) : visibleVersion > 0 ? (
            <motion.span
              key="ok"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              className="chip"
            >
              v{visibleVersion}
            </motion.span>
          ) : null}
        </AnimatePresence>
        <a
          href={visibleUrl || "#"}
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
        {/* Floating live-edit card during patch apply. Absolute on top-right. */}
        <PDFLiveEditCard />
        <div
          ref={scrollerRef}
          className="absolute inset-0 overflow-auto scroll-pane"
        >
          <div className="relative min-h-full flex items-start justify-center py-[var(--space-5)] px-[var(--space-5)]">
            {visibleUrl ? (
              <div
                className="relative"
                style={{
                  opacity: stagingReady ? 0 : 1,
                  transition: "opacity 260ms ease",
                }}
              >
                <DocumentLayer
                  url={visibleUrl}
                  width={width}
                  height={height}
                  scale={scale}
                  onNumPages={setVisiblePageCount}
                  onLoadError={(msg) => setLoadError(msg || null)}
                  onPageText={(n, text) => {
                    pageTextMap.current.set(n, text);
                  }}
                  highlightPage={
                    activeFixState === "applied" ? highlightPage : null
                  }
                  registerPage={(n, el) => {
                    if (el) {
                      pageRefs.current.set(n, el);
                      if (n === pendingScrollTargetRef.current) {
                        requestAnimationFrame(() => {
                          if (el.offsetTop > 0) _doScroll(n, el);
                        });
                      }
                    } else {
                      pageRefs.current.delete(n);
                    }
                  }}
                />
              </div>
            ) : (
              <div
                className="h-full flex items-center justify-center text-[var(--text-sm)]"
                style={{ color: "var(--color-text-faint)" }}
              >
                {compiling ? "fetching paper…" : "PDF will appear once compiled"}
              </div>
            )}

            {stagingUrl && stagingUrl !== visibleUrl && (
              <div
                className="absolute inset-0 flex items-start justify-center py-[var(--space-5)] px-[var(--space-5)] pointer-events-none"
                style={{
                  opacity: stagingReady ? 1 : 0,
                  transition: "opacity 260ms ease",
                }}
                aria-hidden="true"
              >
                <DocumentLayer
                  url={stagingUrl}
                  width={width}
                  height={height}
                  scale={scale}
                  onNumPages={setStagingPageCount}
                  onFirstPageRendered={() => setStagingReady(true)}
                  staging
                />
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Bottom nav */}
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
            <span style={{ color: "var(--color-text-faint)" }}>
              {" "}
              / {String(visiblePageCount).padStart(2, "0")}
            </span>
          </span>
          <button
            className="icon-btn"
            onClick={() =>
              scrollToPage(Math.min(visiblePageCount, pageNum + 1))
            }
            disabled={pageNum >= visiblePageCount}
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

/**
 * One mounted react-pdf Document with its pages laid out in flow. The
 * caller positions the wrapper (relative for visible layer, absolute for
 * staging) and controls opacity; this component just renders.
 */
function DocumentLayer({
  url,
  width,
  height,
  scale,
  onNumPages,
  onLoadError,
  onFirstPageRendered,
  onPageText,
  highlightPage,
  registerPage,
  staging,
}: {
  url: string;
  width?: number;
  height?: number;
  scale?: number;
  onNumPages: (n: number) => void;
  onLoadError?: (msg: string) => void;
  onFirstPageRendered?: () => void;
  onPageText?: (page: number, text: string) => void;
  /** Page to render the teal hover-highlight overlay on. */
  highlightPage?: number | null;
  registerPage?: (page: number, el: HTMLDivElement | null) => void;
  staging?: boolean;
}) {
  const [numPages, setNumPages] = useState(0);
  const file = useMemo(() => ({ url }), [url]);
  const firstPageFiredRef = useRef(false);

  useEffect(() => {
    firstPageFiredRef.current = false;
  }, [url]);

  return (
    <Document
      file={file}
      onLoadSuccess={({ numPages: n }) => {
        setNumPages(n);
        onNumPages(n);
        // Clear any prior transient load error now that load actually
        // succeeded — react-pdf often retries InvalidPDFException on its
        // own when the backend finishes writing the file.
        onLoadError?.("");
      }}
      onLoadError={(err) => {
        const msg = String(err?.message || err);
        // InvalidPDFException is usually transient (PDF still being
        // written). Don't surface it as a terminal "compile error".
        if (msg.includes("Invalid PDF structure")) return;
        onLoadError?.(msg);
      }}
      loading={<DocLoading />}
      error={<DocError />}
      className="pdf-doc-wrap"
    >
      {Array.from({ length: numPages }, (_, i) => i + 1).map((n) => (
        <motion.div
          key={`${url}-${n}`}
          ref={(el) => {
            if (registerPage) registerPage(n, el);
          }}
          data-page={n}
          initial={staging ? { opacity: 1 } : { opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{
            duration: staging ? 0 : 0.22,
            delay: staging ? 0 : Math.min(n * 0.015, 0.25),
          }}
          className="bg-white relative"
          style={{
            boxShadow: "var(--shadow-md)",
            borderRadius: "var(--radius-lg)",
            marginBottom: 16,
          }}
        >
          <Page
            pageNumber={n}
            width={width}
            height={height}
            scale={scale}
            renderTextLayer={true}
            renderAnnotationLayer={false}
            className="pdf-page-render"
            loading={<PageLoading />}
            onRenderSuccess={() => {
              if (n === 1 && !firstPageFiredRef.current) {
                firstPageFiredRef.current = true;
                onFirstPageRendered?.();
              }
            }}
            onGetTextSuccess={(textContent) => {
              if (onPageText) {
                const text = textContent.items
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  .map((item: any) => item.str ?? "")
                  .join(" ")
                  .toLowerCase();
                onPageText(n, text);
              }
            }}
          />
          <span
            className="absolute -top-5 right-0 font-mono text-[var(--text-xs)]"
            style={{ color: "var(--color-text-faint)" }}
          >
            {String(n).padStart(2, "0")}
          </span>
          {/* Hover overlay rendered as a child so it's always correctly
              positioned relative to the page, regardless of scroll offset. */}
          {n === highlightPage && <PageEditHighlight />}
        </motion.div>
      ))}
    </Document>
  );
}

/**
 * Teal hover-highlight rendered INSIDE the page's motion.div so its
 * position is always correct regardless of scroll position or DOM timing.
 * The page element is `position: relative` so `absolute inset-0` here
 * covers it exactly. Hovering the page reveals the diff card on the right.
 */
function PageEditHighlight() {
  const [hovered, setHovered] = useState(false);
  return (
    <div
      className="absolute inset-0 z-10"
      style={{ pointerEvents: "auto" }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {/* Teal left strip + subtle fill */}
      <div
        className="absolute inset-0"
        style={{
          borderLeft: "4px solid rgba(120,196,207,0.75)",
          background: hovered
            ? "rgba(120,196,207,0.1)"
            : "rgba(120,196,207,0.04)",
          transition: "background 180ms ease",
          borderRadius: "0 var(--radius-lg) var(--radius-lg) 0",
          pointerEvents: "none",
        }}
      />
      {/* Diff card appears to the right when hovered */}
      {hovered && (
        <div
          className="absolute"
          style={{ top: 8, right: -340, width: 320, pointerEvents: "auto" }}
          onMouseEnter={() => setHovered(true)}
          onMouseLeave={() => setHovered(false)}
        >
          <PDFLiveEditCard forceVisible />
        </div>
      )}
    </div>
  );
}

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
  return (
    <div
      className="bg-white"
      style={{ width: 600, height: 800 }}
      aria-label="rendering page"
    />
  );
}
