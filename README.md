# PeerMind

**Your paper's toughest reviewer. In 90 seconds.**

PeerMind compresses the 3–6 month scientific peer-review cycle into a ~90-second multi-agent conversation. Upload a LaTeX project (or arXiv ID, or PDF), pick a target venue (NeurIPS, ICML, ICLR, Nature, Science, arXiv, or a custom venue), and PeerMind runs **six Claude Managed Agents** in parallel: two reviewers, a literature scout, a code runner, a fix agent, and an orchestrator that synthesizes the verdict with **Opus 4.7 extended thinking streamed live to the UI**. Apply the fix-agent patches inline with one-click Yes/No confirms, watch the paper recompile in a Docker-sandboxed `latexmk`, and export the patched project back to Overleaf as a zip — or draft a venue-style rebuttal with the co-pilot in the same breath.

Built for the [Built with Opus 4.7 × Cerebral Valley](https://cerebralvalley.ai/e/built-with-4-7-hackathon) hackathon.

## The three things that make this feel different

1. **Opus 4.7 extended thinking, exposed as a UI surface.** When synthesis runs, the reasoning tokens stream into a collapsible "Reasoning trace" bubble in the conversation rail — you literally watch Opus 4.7 weigh consensus issues, reconcile reviewer disagreement, and arrive at a calibrated acceptance-probability number. Not a log file. A first-class experience.
2. **Six Managed Agents, one narrator voice.** The right rail isn't a dashboard of cards — it's a conversation with a single persona (PeerMind) that narrates what each agent is doing, opens inline dropdowns to show *live* reviewer tokens, scout searches, and code runs, and guides the author through fixes one issue at a time. Real long-running task orchestration, surfaced as a chat.
3. **Round-trip that actually closes.** Fix Agent produces unified diffs, `unidiff` applies them, `latexmk` recompiles in a `texlive/texlive` Docker sandbox, the PDF re-renders live, and a zip export drops straight back into Overleaf. Reviews usually end at "you should fix X" — PeerMind ends at *X is fixed*.

## Architecture

```
  ┌────────────────────────────┐     ┌────────────────────────┐
  │ Next.js 15 + Tailwind v4   │◀───▶│ FastAPI (async) + SSE  │
  │ • conversation rail        │     │ • Managed Agents SDK   │
  │ • react-pdf + Monaco       │     │ • SQLAlchemy / aiosqlite│
  │ • Zustand + Framer Motion  │     │ • event bus per job    │
  └────────────────────────────┘     └──────────┬─────────────┘
                                                 │
                ┌────────────────────────────────┼────────────────────────────┐
                │                                │                            │
           ┌────▼────┐                   ┌───────▼────────┐           ┌──────▼──────┐
           │Orchestr.│                   │  MCP servers   │           │ Docker sbx  │
           │Opus 4.7 │                   │ • lit-search   │           │ texlive+    │
           │+thinking│                   │ • latex-tools  │           │ latexmk     │
           └────┬────┘                   │ • semantic-sch │           └─────────────┘
                │                        └────────────────┘
   ┌────────────┼────────────┬──────────────┬──────────────┐
   │            │            │              │              │
 ┌─▼────┐  ┌────▼───┐  ┌─────▼─────┐  ┌─────▼─────┐  ┌─────▼─────┐
 │Rev 1 │  │ Rev 2  │  │ Lit Scout │  │Code Runner│  │ Fix Agent │
 │Sonnet│  │ Sonnet │  │  Sonnet   │  │  Sonnet   │  │ Opus 4.7  │
 │ 4.5  │  │  4.5   │  │   4.5     │  │    4.5    │  │           │
 └──────┘  └────────┘  └───────────┘  └───────────┘  └───────────┘
      ▲         ▲            ▲              ▲              ▲
      └ Agent Skills: skeptic / champion / scout / code-runner / fix-agent
        (venue rubric injected into system prompt at session creation)

        Synthesis  (Opus 4.7 + extended thinking, streamed as UI trace)
        Rebuttal   (Sonnet 4.5, concede/clarify/refute, streamed as letter)
        Chat       (Sonnet 4.5, prompt-cached paper context)
```

Every role is a real **Claude Managed Agent** via `client.beta.agents.create` with its own system prompt (via Agent Skills JSON), model, and tools. Reviewers + scout + code runner + compile kick off in a single `asyncio.gather`; synthesis and fix-agent run in **parallel** afterwards (Fix Agent reads the raw reviews, not the synthesized verdict, so both Opus 4.7 calls overlap — saving ~60s per review).

## Why Opus 4.7

- **Verdict synthesis with extended thinking.** `thinking.budget_tokens=2048`, `max_tokens=4096`. Every `thinking_delta` event is fanned out to the SSE bus as a `synthesis_thinking` event; the UI assembles them into a live trace. Judges see Opus reason about their paper in real time.
- **Fix Agent with rigorous diff generation + severity judgment.** Unified diffs must match source lines exactly; deciding whether a reviewer concern can be partially addressed via prose (a limitation sentence, a `\cite{TODO-X}` placeholder, a survivorship-bias caveat) versus requiring true author work needs careful reasoning. Opus 4.7 earns the spend.

**Model routing:**

| Role | Model | Why |
|---|---|---|
| Verdict synthesis | **Opus 4.7** (+ extended thinking) | Reasoning trace is a live UI surface |
| Fix Agent | **Opus 4.7** | Unified-diff correctness + severity judgment |
| Reviewer 1 / 2 (Skeptic / Champion) | Sonnet 4.5 | Speed on the critical path (~25 s each, parallel) |
| Literature Scout | Sonnet 4.5 | MCP tool-use over Semantic Scholar / arXiv |
| Code Runner | Sonnet 4.5 | Bash tool-use in the Docker sandbox |
| Chat ("Ask PeerMind") | Sonnet 4.5 (+ prompt caching) | Fast Q&A, paper context cached across turns |
| Rebuttal Co-Pilot | Sonnet 4.5 (+ prompt caching) | Streamed live; cached paper + verdict reused on re-draft |
| Venue auto-detect | Haiku 4.5 | Cheap classifier at upload |

Prompt caching is applied to the paper-context blobs in the chat and rebuttal endpoints (`cache_control: {"type": "ephemeral"}`) so subsequent chat turns or a "Re-draft" click inside the 5-minute TTL reuse cached tokens.

## Features

- **Venue-aware review.** Six built-in rubrics (NeurIPS, ICML, ICLR, Nature, Science, arXiv) + a custom venue option. Haiku 4.5 suggests the venue at upload; user confirms.
- **Conversation rail.** The right rail narrates the pipeline in PeerMind's voice: a greeting on arrival, per-reviewer streaming bubbles with live-token dropdowns, Scout + Code Runner dropdowns showing the exact claims being searched / blocks being executed, an extended-thinking reasoning trace, the verdict card with acceptance-probability bar, and a guided walkthrough. LaTeX commands in displayed text are stripped client-side so the conversation reads as plain prose (`S\&P 500` → `S&P 500`, `2003--2023` → `2003–2023`, `\cite{...}` → `[ref]`).
- **Guided fix walkthrough.** One issue at a time. For a minor item with a concrete prose fix, PeerMind asks *"Would you like me to make this change?"* — Yes applies the diff in place (no scroll yank) and runs a 4-step live-edit timeline (Locating → Applying → Recompiling → Reloading). For critical items it shows the concern + recommended author action and lets you skip.
- **Section-aware PDF navigation.** When an issue references "Section 5.4" or "Table 3", the PDF navigates by searching the text layer for the actual heading — not by guessing a page number from line ratios. A two-pass search skips Table-of-Contents pages (dot-leader detection) and then scrolls to the exact span position within the page (not the page top), so the section heading lands at the top of the viewport.
- **Live LaTeX round-trip with no-flash recompile.** `unidiff` applies patches to the source on disk, `latexmk` recompiles inside a `texlive/texlive` Docker container (with a `.peermind-bak` rollback snapshot). The PDF viewer uses a **double-buffered** `<Document>` — the new version loads in a hidden staging layer first, then cross-fades smoothly into view with the user's scroll position preserved. No blank flash.
- **Live-edit card with typewriter.** While a patch applies, a floating teal card on the PDF types out the new line character-by-character. After `compile_success`, the card transitions to a settled "✓ Edit applied" state showing the full before/after diff. The edited page gets a soft teal left-border strip with hover-to-show-diff that persists for 8 seconds.
- **Acceptance-probability meter.** Calibrated 0-1 estimate from Opus 4.7's synthesis — separate from "confidence." Visualized as a horizontal bar (red/amber/green).
- **Rebuttal Co-Pilot.** Streams a venue-style author response classifying each reviewer concern as *concede*, *clarify*, or *refute*. Copy to clipboard, open as a printable HTML letter, or re-draft.
- **Overleaf round-trip zip.** `GET /api/jobs/{id}/export.zip` walks the (post-patch) source directory, skips latexmk artefacts + backup snapshots, includes the final compiled PDF, and drops a `PEERMIND_REPORT.md` at the root. Unzip → Overleaf → New Project → Upload Project → compiles with zero manual fixup.
- **Review letter export.** Printable HTML version of the full review (verdict, consensus issues, arbitrated disagreements, action plan, applied patches). Ctrl+P → Save as PDF.
- **Three custom MCP servers.** `literature_search` (Semantic Scholar + arXiv), `latex_tools` (compile, diff-apply), and `semantic_scholar`. Shared implementations between the Managed Agent tools and the standalone MCP binaries.

## How the apply flow works (end-to-end)

A typical "Yes, apply it" click traces through these layers:

1. **Frontend** — `onFixNow` in `app/review/[jobId]/page.tsx` parks the diff in zustand (`activeFix`, `activeFixState: "applying"`), routes to `applyPatch(patchId)` for auto-patches or `applyAdhocPatch(...)` for author-required items, and **does not move the PDF** (the user's already at the section from the walkthrough's earlier `scrollToText`).
2. **Backend** — `POST /api/jobs/{id}/patch/apply` (or `/adhoc-apply`) calls `_apply_patch_and_recompile` in `backend/main.py`, which fires a 4-event narrated timeline: `patch_locating` → `patch_diffing` → `patch_compiling` → `patch_reloading`. On context-mismatch (diff doesn't match current source) it fires `compile_error` so the UI shows a red ✗ Retry state instead of stalling.
3. **PDF page hints** — `orchestrator.py::_run_fix_agent` post-processes Fix Agent output: it counts the compiled PDF's pages with `pypdf`, parses each diff's `@@ -L,...` hunk header, and computes `page_hint = round(L / total_source_lines × pdf_page_count)`. Replaces Fix Agent's hand-wavy page guesses with a value derived from the actual diff position.
4. **Frontend swap** — `compile_success` bumps `pdfVersion`. `PDFPreview` mounts the new URL in a hidden staging `<Document>`. When the staging's first page renders, an opacity cross-fade (260 ms) promotes it. The user's `scrollTop` is captured before swap and restored after — so they remain at the same section. An 8-second watchdog force-promotes if react-pdf hits a transient `InvalidPDFException`.
5. **Hover overlay** — when `activeFixState === "applied"`, a `<PageEditHighlight>` is rendered as a child of the edited page's `motion.div`. Its `absolute inset-0` is always positioned correctly relative to the page (no offsetTop math). Hovering the page reveals the settled diff card to the right.

## Quickstart

```bash
git clone https://github.com/advaitgore/peermind
cd peermind
cp .env.example .env            # then fill in ANTHROPIC_API_KEY

# Build the LaTeX compile sandbox used by the Fix Agent + initial compile.
docker build -t peermind-latex:local -f docker/latex.Dockerfile .

# Backend — run from the project root so relative imports resolve.
pip install -r backend/requirements.txt
uvicorn backend.main:app --reload --port 8000

# Frontend (separate terminal)
cd frontend
npm install
npm run dev                     # http://localhost:3000
```

Alternatively, `docker compose up --build` runs the whole stack (build the LaTeX image first via the `build-only` profile):

```bash
docker compose --profile build-only build latex
docker compose up --build
```

Then open http://localhost:3000, drop in a `.tex` file or `.zip` of an Overleaf project, paste an arXiv ID, or click **Demo mode** to preload a sample paper.

### Running the MCP servers standalone

The literature and LaTeX MCP servers run on their own so you can plug them
into Claude Desktop / Cursor:

```bash
python -m backend.mcp_servers.literature_search.server  # stdio MCP server
python -m backend.mcp_servers.latex_tools.server        # stdio MCP server
```

## Tech stack

| Layer | Pieces |
|---|---|
| Agents | `anthropic` SDK 0.96.0 — `client.beta.agents`, `client.beta.environments`, `client.beta.sessions` (Managed Agents beta `managed-agents-2026-04-01`) |
| Backend | FastAPI (async), SQLAlchemy + aiosqlite, sse-starlette, `unidiff`, kreuzberg for PDF text extraction, `pypdf` for compiled-page counting |
| MCP | Official Python MCP SDK — 3 custom stdio servers; shared tool implementations with the in-process agent tools |
| Frontend | Next.js 15 (App Router) + TypeScript, Tailwind v4, Zustand, Framer Motion, react-pdf, Monaco Editor |
| Compile sandbox | `texlive/texlive` Docker image, `latexmk -shell-escape -f -bibtex`, 60 s timeout, auto-rollback on failure |

## What's in the repo

```
backend/
  agents/                # one file per Managed Agent spec
  skills/                # Agent Skills — JSON system prompts with {rubric} injection
  mcp_servers/           # 3 stdio MCP servers (shared impls with agents/ tools)
  journal_profiles/      # 6 venue rubrics + custom profile
  utils/                 # LaTeX parsing, \input resolution, diff application, arxiv fetch
  models/                # SQLAlchemy models + pydantic schemas (mirrored in frontend/lib/types.ts)
  main.py                # FastAPI endpoints, SSE stream, zip export, review letter
frontend/
  app/review/[jobId]/    # workbench page
  components/            # ConversationRail (narrator + guide), GuidedActionPlan,
                         # PDFPreview (double-buffered, text-layer search),
                         # PDFLiveEditCard (typewriter + settled diff),
                         # VerdictCard, ReasoningTrace, RebuttalPanel,
                         # RailFooter, LaTeXEditor, ConsoleNoiseSuppressor
  lib/
    store.ts             # Zustand store + SSE ingest
    api.ts               # backend client
    latex.ts             # stripLatex() display helper
docker/                  # compile-sandbox Dockerfile + compose
```

## License

MIT — see [LICENSE](LICENSE).
