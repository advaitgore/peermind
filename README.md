# PeerMind

**Your paper's toughest reviewer. In 90 seconds.**

PeerMind is an AI-powered scientific peer review system that turns the 6-month peer review cycle into a 90-second feedback loop. Upload a LaTeX paper or PDF, pick your target venue (NeurIPS, ICML, ICLR, Nature, Science, arXiv), and PeerMind runs two adversarial reviewer agents — a **Skeptic** and a **Champion** — across three self-improving rounds. Between rounds, a **Literature Scout** finds missing and contradicting papers, and a **Code Runner** actually executes code blocks from your paper. A **Fix Agent** then produces unified-diff patches that edit your `.tex` source, recompile the PDF, and stream the updated preview back to you live.

Built for the [Built with Opus 4.7 × Cerebral Valley](https://cerebralvalley.ai/e/built-with-4-7-hackathon) hackathon.

## Why this exists

Scientific peer review is broken. Papers wait 6+ months. Reviewers miss contradicting literature. Nobody checks if the code runs. PeerMind fixes all three in 90 seconds — journal-specific rubrics, real-time multi-agent critique, executed code, and patched source. Built by a researcher-engineer who has lived the bottleneck from both sides.

## Architecture

```
                         ┌──────────────────────────────────────┐
                         │  FastAPI + SSE event bus (backend/)  │
                         └──────────────────────────────────────┘
                                          │
                        ┌─────────────────┴─────────────────┐
                        │                                   │
                ┌───────▼────────┐                 ┌────────▼─────────┐
                │  Orchestrator  │  Managed Agent  │  MCP servers     │
                │  Opus 4.7      │  (coordinator)  │  • literature    │
                └───────┬────────┘                 │  • latex-tools   │
                        │                          └──────────────────┘
        ┌───────────────┼──────────────────┬─────────────┬────────────┐
        │               │                  │             │            │
  ┌─────▼──────┐ ┌──────▼─────┐ ┌──────────▼────┐ ┌──────▼─────┐ ┌────▼──────┐
  │  Skeptic   │ │  Champion  │ │  Lit Scout    │ │ Code Runner│ │ Fix Agent │
  │  Opus 4.7  │ │  Opus 4.7  │ │  Sonnet 4.5   │ │ Sonnet 4.5 │ │ Sonnet 4.5│
  └────────────┘ └────────────┘ └───────────────┘ └────────────┘ └───────────┘
        ▲               ▲
        └─── Agent Skill: adversarial-reviewer / constructive-reviewer
             loaded with the target journal's rubric at session creation
```

Every role is a real **Claude Managed Agent** — `client.beta.agents.create()` with its own model, system prompt, tools, and (optionally) `callable_agents`. Each agent runs in its own session and streams events back through our FastAPI SSE bridge.

**Self-improving loop:** After round 1, the Orchestrator computes **critique delta** (Jaccard similarity over `key_claims_to_verify`) and either runs another round or synthesizes the verdict. Literature findings and code-execution results are injected into the next round's context.

**Live LaTeX patching:** The Fix Agent emits unified diffs classified `AUTO_APPLY` (safe: citation fixes, notation, formatting) or `AUTHOR_REQUIRED` (risky: new experiments, claim rewrites). Applied patches trigger `latexmk` in a `texlive/texlive` Docker sandbox; the PDF updates live. On compile failure, we auto-rollback and mark the patch for manual review.

## Quickstart

```bash
git clone https://github.com/YOUR_ORG/peermind
cd peermind
cp .env.example .env            # then fill in ANTHROPIC_API_KEY

# Build the LaTeX compile sandbox (used by the Fix Agent's recompile loop)
docker build -t peermind-latex:local -f docker/latex.Dockerfile .

# Backend — run from the project root so relative imports resolve.
pip install -r backend/requirements.txt
uvicorn backend.main:app --reload --port 8000

# Frontend (separate terminal)
cd frontend
npm install
npm run dev                     # http://localhost:3000
```

Alternatively, the whole stack runs via `docker compose up --build` (builds `peermind-latex:local` via the `build-only` profile first):

```bash
docker compose --profile build-only build latex
docker compose up --build
```

### Running the MCP servers standalone

The literature and LaTeX MCP servers run on their own so you can plug them
into Claude Desktop / Cursor:

```bash
python -m backend.mcp_servers.literature_search.server  # stdio MCP server
python -m backend.mcp_servers.latex_tools.server        # stdio MCP server
```

Then open http://localhost:3000, drop in a `.tex` file, or hit **Demo mode** to preload the arXiv Self-Refine paper and run an end-to-end review on NeurIPS rubric.

## Tech stack

| Layer | Pieces |
|---|---|
| Agents | `anthropic` SDK (Claude Managed Agents beta: `managed-agents-2026-04-01`) |
| Backend | FastAPI (async), SQLAlchemy+aiosqlite, SSE, kreuzberg for extraction |
| MCP | Official Python MCP SDK — 2 custom servers (literature, latex-tools) |
| Frontend | Next.js 15 (App Router) + TypeScript, Tailwind v4, shadcn/ui, Monaco Editor, react-pdf, Zustand, Framer Motion |
| Compile sandbox | `texlive/texlive` Docker image, `latexmk` with 60s timeout |

## Models

| Role | Model | Why |
|---|---|---|
| Orchestrator | `claude-opus-4-7` | Synthesis, convergence checks, extended thinking for the verdict |
| Reviewer Skeptic | `claude-opus-4-7` | Rigorous adversarial critique |
| Reviewer Champion | `claude-opus-4-7` | Generous constructive critique |
| Literature Scout | `claude-sonnet-4-5` | Fast search + summarization over Semantic Scholar/arXiv |
| Code Runner | `claude-sonnet-4-5` | Container-side code execution via bash |
| Fix Agent | `claude-sonnet-4-5` | Unified-diff generation |

## License

MIT — see [LICENSE](LICENSE).
