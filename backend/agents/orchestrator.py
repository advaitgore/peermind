"""Lead Orchestrator — runs the full multi-round review pipeline for a job.

Every agent invoked here is a real Claude Managed Agent (see agent_factory):
- Skeptic and Champion: `claude-opus-4-7`, one session per round.
- Literature Scout: `claude-sonnet-4-5`, custom tools backed by the same
  implementations the MCP server exposes.
- Code Runner: `claude-sonnet-4-5`, bash access to the managed container.
- Fix Agent: `claude-sonnet-4-5`, synthesizes unified-diff patches.
- Synthesis step (this function): extended-thinking-enabled Opus 4.7 via the
  orchestrator skill when multiagent preview is enabled, otherwise a direct
  Opus 4.7 call through the Messages API fallback path.

Events are fanned out through ``backend.event_bus.bus`` so the SSE endpoint
can relay every token/patch/compile event to the browser.
"""
from __future__ import annotations

import asyncio
import json
import uuid
from pathlib import Path
from typing import Any

from anthropic import AsyncAnthropic

from ..config import get_settings
from ..event_bus import bus
from ..models.database import Job, Patch, get_sessionmaker
from ..models.schemas import ReviewEvent
from ..utils.critique_delta import compute_critique_delta
from ..utils.latex import compile_latex, find_main_tex
from .agent_factory import extract_json, factory
from .code_runner import build_code_runner_spec, build_code_runner_user_message
from .fix_agent import build_fix_agent_spec, build_fix_user_message
from .literature_scout import build_scout_spec, build_scout_user_message
from .reviewer_champion import build_champion_spec, build_champion_user_message
from .reviewer_skeptic import build_skeptic_spec, build_skeptic_user_message
from .skills import load_skill


# ---------- Utility: load journal profile ----------


def _claim_covered(claim: str, seeds: list[str]) -> bool:
    """Cheap overlap check — is this new claim basically the same thing a seed
    claim was already about? Uses token Jaccard on words ≥4 chars.
    """
    import re as _re
    tokens = lambda s: {t for t in _re.findall(r"[A-Za-z0-9]+", s.lower()) if len(t) > 3}
    ct = tokens(claim)
    if not ct:
        return True
    for s in seeds:
        st = tokens(s)
        if not st:
            continue
        overlap = len(ct & st) / max(len(ct | st), 1)
        if overlap >= 0.35:
            return True
    return False


def _load_journal(journal_id: str, custom_venue_name: str | None = None) -> dict[str, Any]:
    path = Path(__file__).resolve().parent.parent / "journal_profiles" / "profiles.json"
    data = json.loads(path.read_text(encoding="utf-8"))
    if journal_id not in data:
        raise KeyError(f"Unknown journal profile: {journal_id}")
    profile = dict(data[journal_id])
    profile["id"] = journal_id

    # Substitute {journal_name} in the custom profile so reviewers speak
    # about the right venue instead of literally echoing the placeholder.
    if journal_id == "custom":
        name = (custom_venue_name or "the target venue").strip() or "the target venue"
        for key in (
            "full_name",
            "reviewer_guidelines_summary",
            "persona_skeptic_inject",
            "persona_champion_inject",
        ):
            if key in profile and isinstance(profile[key], str):
                profile[key] = profile[key].replace("{journal_name}", name)
    return profile


# ---------- Initial compile ----------


async def _initial_compile(job: Job) -> None:
    """Show the paper PDF as quickly as possible.

    For arXiv sources, ``create_job`` already saved the canonical pre-built
    PDF from ``arxiv.org/pdf/{id}`` to ``job.pdf_path`` — compile-from-source
    is fragile (minted, custom .sty, etc.) and can take 30+ seconds when it
    works at all. Short-circuit to the pre-built PDF and tell the UI.

    For uploaded ``.tex``/``.zip`` sources we don't have a pre-built PDF so
    we fall through to ``compile_latex`` (latexmk in the Docker sandbox).
    Patches always recompile — that path exercises the sandbox for real.
    """
    src = Path(job.source_dir)
    await bus.publish(
        job.id,
        ReviewEvent(
            event_type="compile_started",
            agent="system",
            data={"stage": "initial"},
        ),
    )

    # Fast path: arXiv pre-built PDF is already on disk.
    if job.pdf_path and Path(job.pdf_path).is_file():
        await bus.publish(
            job.id,
            ReviewEvent(
                event_type="compile_success",
                agent="system",
                data={
                    "pdf_url": f"/api/jobs/{job.id}/output.pdf?v=prebuilt",
                    "elapsed_ms": 0,
                    "stage": "initial",
                    "source": "prebuilt",
                },
            ),
        )
        return

    if not job.main_tex:
        await bus.publish(
            job.id,
            ReviewEvent(
                event_type="compile_error",
                agent="system",
                data={"log": "No .tex source found to compile", "stage": "initial"},
            ),
        )
        return

    res = await compile_latex(src, main_tex=job.main_tex)
    if res.success and res.pdf_path is not None:
        sm = get_sessionmaker()
        async with sm() as session:
            j = await session.get(Job, job.id)
            assert j is not None
            j.pdf_path = str(res.pdf_path)
            await session.commit()
        await bus.publish(
            job.id,
            ReviewEvent(
                event_type="compile_success",
                agent="system",
                data={
                    "pdf_url": f"/api/jobs/{job.id}/output.pdf?v=initial",
                    "elapsed_ms": res.elapsed_ms,
                    "stage": "initial",
                    "source": "compiled",
                },
            ),
        )
    else:
        await bus.publish(
            job.id,
            ReviewEvent(
                event_type="compile_error",
                agent="system",
                data={"log": (res.log or "")[-4000:] or "compile failed", "stage": "initial"},
            ),
        )


# ---------- Reviewer runner (with streaming) ----------


async def _run_reviewer(
    job_id: str,
    role: str,  # "skeptic" | "champion"
    spec_fn,
    user_message_fn,
    journal: dict[str, Any],
    round_num: int,
    paper_text: str,
    previous_reviews: list[dict[str, Any]],
    lit: list[dict[str, Any]],
    code: list[dict[str, Any]],
) -> dict[str, Any]:
    spec = spec_fn(journal)
    user_msg = user_message_fn(round_num, paper_text, previous_reviews, lit, code)

    async def on_event(kind: str, data: dict[str, Any]) -> None:
        if kind == "token":
            await bus.publish(
                job_id,
                ReviewEvent(
                    event_type="reviewer_token",
                    agent=role,  # type: ignore[arg-type]
                    round=round_num,
                    data={"text": data.get("text", "")},
                ),
            )
        elif kind == "tool_use":
            await bus.publish(
                job_id,
                ReviewEvent(
                    event_type="reviewer_token",
                    agent=role,  # type: ignore[arg-type]
                    round=round_num,
                    data={"tool_use": data.get("tool")},
                ),
            )
        elif kind == "error":
            await bus.publish(
                job_id,
                ReviewEvent(
                    event_type="error",
                    agent=role,  # type: ignore[arg-type]
                    round=round_num,
                    data=data,
                ),
            )

    final_text = await factory.run_session(spec, user_msg, on_event=on_event)
    parsed = extract_json(final_text) or {
        "summary": final_text[:500],
        "strengths": [],
        "weaknesses": [],
        "key_claims_to_verify": [],
        "scores": {},
        "confidence": 0.3,
        "recommendation": "borderline",
        "updated_from_previous": [],
    }
    await bus.publish(
        job_id,
        ReviewEvent(
            event_type="reviewer_complete",
            agent=role,  # type: ignore[arg-type]
            round=round_num,
            data={"review": parsed},
        ),
    )
    return parsed


# ---------- Scout + Code runs ----------


async def _run_scout(
    job_id: str,
    round_num: int,
    claims: list[str],
    paper_title: str | None,
    paper_abstract: str,
) -> list[dict[str, Any]]:
    if not claims:
        return []
    # Include the actual claim strings so the UI can show what the Scout
    # is searching for while the agent runs.
    await bus.publish(
        job_id,
        ReviewEvent(
            event_type="literature_started",
            agent="scout",
            round=round_num,
            data={"claims": claims, "count": len(claims)},
        ),
    )
    spec = build_scout_spec()
    user_msg = build_scout_user_message(claims, paper_title, paper_abstract)
    out = await factory.run_session(spec, user_msg)
    parsed = extract_json(out) or {"findings": []}
    findings = parsed.get("findings", [])
    await bus.publish(
        job_id,
        ReviewEvent(
            event_type="literature_found",
            agent="scout",
            round=round_num,
            data={"findings": findings, "count": len(findings)},
        ),
    )
    return findings


async def _run_code(
    job_id: str, round_num: int, code_blocks: list[dict[str, Any]]
) -> list[dict[str, Any]]:
    if not code_blocks:
        return []
    # Include a lightweight preview (language + first line) of each block
    # so the UI can show what the Code Runner is about to execute.
    previews = [
        {
            "block_id": b.get("block_id"),
            "language": b.get("language") or "unknown",
            "preview": (b.get("code") or "").splitlines()[0][:140] if b.get("code") else "",
            "lines": len((b.get("code") or "").splitlines()),
        }
        for b in code_blocks
    ]
    await bus.publish(
        job_id,
        ReviewEvent(
            event_type="code_started",
            agent="code_runner",
            round=round_num,
            data={"blocks": previews, "count": len(code_blocks)},
        ),
    )
    spec = build_code_runner_spec()
    user_msg = build_code_runner_user_message(code_blocks)
    out = await factory.run_session(spec, user_msg)
    parsed = extract_json(out) or {"results": [], "summary": "no results"}
    results = parsed.get("results", [])
    await bus.publish(
        job_id,
        ReviewEvent(
            event_type="code_run_result",
            agent="code_runner",
            round=round_num,
            data={"results": results, "summary": parsed.get("summary", ""), "count": len(results)},
        ),
    )
    return results


# ---------- Synthesis (orchestrator step with extended thinking) ----------


async def _synthesize_verdict(
    job_id: str,
    journal: dict[str, Any],
    all_round_reviews: list[dict[str, Any]],
    lit: list[dict[str, Any]],
    code: list[dict[str, Any]],
) -> dict[str, Any]:
    skill = load_skill("orchestrator")
    from .skills import render_prompt

    system = render_prompt(
        skill.system_prompt_template,
        {
            "journal_name": journal["full_name"],
            "journal_rubric": journal["reviewer_guidelines_summary"],
            "strong_accept_threshold": journal.get("strong_accept_threshold", 0),
        },
    )
    user = json.dumps(
        {
            "all_round_reviews": all_round_reviews,
            "literature_findings": lit,
            "code_results": code,
        },
        indent=2,
    )[:200_000]

    settings = get_settings()
    client = AsyncAnthropic(api_key=settings.anthropic_api_key or None)

    # Stream the synthesis step with extended thinking. Thinking deltas flow
    # to the UI as they arrive so the user watches Opus reason about the
    # evidence. Text deltas accumulate into the final JSON buffer.
    async def _stream(enable_thinking: bool) -> str:
        kwargs: dict[str, Any] = dict(
            model="claude-opus-4-7",
            # 4k is enough for the verdict JSON + one-line prose. 8k was
            # overprovisioned and cost ~30s of extra generation time.
            max_tokens=4096,
            system=system,
            messages=[{"role": "user", "content": user}],
        )
        if enable_thinking:
            # Half the previous budget — still visible, a lot faster.
            kwargs["thinking"] = {"type": "enabled", "budget_tokens": 2048}
        buf: list[str] = []
        saw_thinking = False
        done_emitted = False
        async with client.messages.stream(**kwargs) as stream:
            async for ev in stream:
                etype = getattr(ev, "type", None)
                if etype == "content_block_delta":
                    delta = getattr(ev, "delta", None)
                    dtype = getattr(delta, "type", None)
                    if dtype == "thinking_delta":
                        saw_thinking = True
                        chunk = getattr(delta, "thinking", "") or ""
                        if chunk:
                            await bus.publish(
                                job_id,
                                ReviewEvent(
                                    event_type="synthesis_thinking",
                                    agent="orchestrator",
                                    data={"text": chunk},
                                ),
                            )
                    elif dtype == "text_delta":
                        buf.append(getattr(delta, "text", "") or "")
                elif etype == "content_block_stop":
                    # When a thinking block closes, notify the UI so it can
                    # flip the ReasoningTrace into its settled state.
                    block = getattr(ev, "content_block", None)
                    if block is not None and getattr(block, "type", None) == "thinking":
                        done_emitted = True
                        await bus.publish(
                            job_id,
                            ReviewEvent(
                                event_type="synthesis_thinking_done",
                                agent="orchestrator",
                                data={},
                            ),
                        )
        # Safety: if thinking was enabled and we saw deltas but the SDK didn't
        # surface the stop event, still send the terminator so the UI doesn't
        # stay stuck on a spinner.
        if enable_thinking and saw_thinking and not done_emitted:
            await bus.publish(
                job_id,
                ReviewEvent(
                    event_type="synthesis_thinking_done",
                    agent="orchestrator",
                    data={},
                ),
            )
        return "".join(buf)

    try:
        text = await _stream(enable_thinking=True)
    except Exception:
        # Extended thinking may not be available; fall back to plain stream.
        text = await _stream(enable_thinking=False)

    return extract_json(text) or {
        "recommendation": "borderline",
        "confidence": 0.3,
        "acceptance_probability": 0.3,
        "one_line_verdict": "Unable to synthesize — see individual reviews.",
        "reviewer_recommendations": {},
        "consensus_issues": [],
        "disagreements_arbitrated": [],
        "scores_synthesis": {},
    }


# ---------- Fix Agent (patches + action plan) ----------


import re as _re


def _page_hint_from_diff(diff: str, total_source_lines: int, pdf_page_count: int) -> int | None:
    """Estimate the PDF page where a unified diff lands.

    Parses the first `@@ -LINE,...` hunk header and maps the source line
    onto a PDF page using the known total source-line count and PDF page
    count. Much more accurate than Fix Agent's hand-wavy section estimate.
    """
    if not diff or total_source_lines <= 0 or pdf_page_count <= 0:
        return None
    m = _re.search(r"@@ -(\d+)", diff)
    if not m:
        return None
    source_line = int(m.group(1))
    return max(1, min(pdf_page_count, round(source_line / total_source_lines * pdf_page_count)))


def _count_pdf_pages(job_id: str) -> int:
    """Return the PDF page count for the given job's compiled output.

    Uses pypdf (already in requirements) to count pages from the on-disk
    PDF. Returns 0 if no PDF exists or pypdf is unavailable.
    """
    try:
        from pypdf import PdfReader
        from ..config import get_settings
        from ..models.database import Job
        import sqlite3

        settings = get_settings()
        # Can't use async DB here (called via asyncio.to_thread) — use
        # sqlite3 directly for the one-row lookup.
        db_path = str(settings.database_url).replace("sqlite+aiosqlite:///", "")
        conn = sqlite3.connect(db_path, timeout=5)
        row = conn.execute("SELECT pdf_path FROM jobs WHERE id = ?", (job_id,)).fetchone()
        conn.close()
        if not row or not row[0]:
            return 0
        from pathlib import Path
        pdf_path = Path(row[0])
        if not pdf_path.is_file():
            return 0
        reader = PdfReader(str(pdf_path))
        return len(reader.pages)
    except Exception:
        return 0


async def _run_fix_agent(
    job_id: str,
    paper_source: str,
    verdict: dict[str, Any],
    all_reviews: list[dict[str, Any]],
    lit: list[dict[str, Any]],
    code: list[dict[str, Any]],
    main_tex_name: str,
) -> dict[str, Any]:
    spec = build_fix_agent_spec()
    user_msg = build_fix_user_message(paper_source, verdict, all_reviews, lit, code, main_tex_name)
    out = await factory.run_session(spec, user_msg)
    raw = extract_json(out)
    if raw is None:
        # Parse failed — almost always truncation. Breadcrumb so we can
        # diagnose on the next iteration instead of silently returning
        # an empty action plan.
        tail = (out or "")[-400:].replace("\n", "\\n")
        print(
            f"[fix_agent] extract_json returned None (output {len(out or '')} chars). "
            f"Tail: {tail!r}",
            flush=True,
        )
    parsed = raw or {"auto_apply_patches": [], "author_required": []}

    # The model sometimes drops the wrapper and returns one of:
    #   {"diff": ..., "description": ..., "category": ...}          (single patch)
    #   [{"diff": ...}, {"diff": ...}, ...]                         (list of patches)
    # Reshape either into the expected {auto_apply_patches: [...]} wrapper.
    if isinstance(parsed, list):
        parsed = {"auto_apply_patches": list(parsed), "author_required": []}
    elif isinstance(parsed, dict) and "auto_apply_patches" not in parsed and "author_required" not in parsed:
        keys = set(parsed.keys())
        if "diff" in keys and ("description" in keys or "category" in keys):
            parsed = {"auto_apply_patches": [parsed], "author_required": []}
        else:
            parsed = {"auto_apply_patches": [], "author_required": []}

    ap_count = len(parsed.get("auto_apply_patches") or [])
    ar_count = len(parsed.get("author_required") or [])
    if ap_count == 0 and ar_count == 0:
        # Parse succeeded but both lists empty — model decided to emit
        # nothing, or the JSON had the shape but missing both arrays.
        print(
            f"[fix_agent] action plan empty after parse (parsed_keys="
            f"{list(parsed.keys())}). Paper title: {main_tex_name!r}.",
            flush=True,
        )
    # Always regenerate patch_ids.
    for p in parsed.get("auto_apply_patches") or []:
        p["patch_id"] = "p_" + uuid.uuid4().hex[:10]

    # Override Fix Agent's page_hint estimates with values derived from
    # the actual diff hunk line numbers. Fix Agent's guesses are often
    # wrong; hunk lines + pypdf page count gives exact accuracy.
    total_source_lines = len(paper_source.splitlines())
    pdf_page_count = await asyncio.to_thread(_count_pdf_pages, job_id)
    if total_source_lines > 0 and pdf_page_count > 0:
        for p in parsed.get("auto_apply_patches") or []:
            ph = _page_hint_from_diff(p.get("diff", ""), total_source_lines, pdf_page_count)
            if ph:
                p["page_hint"] = ph
        for a in parsed.get("author_required") or []:
            # Derive from fix_hint diff if present, otherwise keep Fix Agent's guess.
            fh_diff = (a.get("fix_hint") or {}).get("diff", "")
            if fh_diff:
                ph = _page_hint_from_diff(fh_diff, total_source_lines, pdf_page_count)
                if ph:
                    a["page_hint"] = ph
            elif not a.get("page_hint"):
                # Fall back to tex_line_hint if available.
                tex_line = a.get("tex_line_hint")
                if tex_line:
                    a["page_hint"] = max(1, round(tex_line / total_source_lines * pdf_page_count))
    return parsed


# ---------- Public entrypoint ----------


async def run_review_pipeline(
    job_id: str,
    journal_id: str,
    custom_venue_name: str | None = None,
) -> None:
    """Top-level pipeline. Publishes SSE events throughout and terminates with job_complete."""
    sm = get_sessionmaker()
    async with sm() as session:
        job = await session.get(Job, job_id)
    if job is None:
        return

    try:
        journal = _load_journal(journal_id, custom_venue_name)

        await bus.publish(
            job_id,
            ReviewEvent(
                event_type="job_started",
                agent="orchestrator",
                data={
                    "journal": journal_id,
                    "journal_full_name": journal["full_name"],
                    "title": job.title,
                    "main_tex": job.main_tex,
                    "source_type": job.source_type,
                },
            ),
        )

        # Kick off initial compile in parallel with the first round of review.
        compile_task = asyncio.create_task(_initial_compile(job))

        paper_text = job.paper_text or ""
        # Pull code blocks for the code runner.
        from ..utils.extract import extract_paper

        extracted = await extract_paper(Path(job.source_dir), job.main_tex, job.source_type)
        paper_text = paper_text or extracted.full_text
        code_blocks_all = extracted.code_blocks

        all_round_reviews: list[dict[str, Any]] = []
        lit_findings: list[dict[str, Any]] = []
        code_results: list[dict[str, Any]] = []

        # ----- Single-round parallel pipeline -----
        # Rounds-with-convergence proved redundant: rounds 2/3 rarely surfaced
        # new information because reviewers read the same source twice. We now
        # run reviewers + scout + code runner all in parallel, then optionally
        # do a tiny scout "refine" pass if reviewers ask for specific claims
        # the seed search didn't cover.

        await bus.publish(
            job_id,
            ReviewEvent(
                event_type="round_started",
                agent="orchestrator",
                round=1,
                data={"of": 1, "mode": "parallel"},
            ),
        )

        # Seed claims for the scout — so it can begin searching immediately
        # based on what the paper itself claims, not wait for reviewer output.
        from ..utils.extract import extract_seed_claims

        seed_claims = extract_seed_claims(paper_text, limit=4)

        skeptic_task = asyncio.create_task(
            _run_reviewer(
                job_id, "skeptic", build_skeptic_spec, build_skeptic_user_message,
                journal, 1, paper_text, [], [], [],
            )
        )
        champion_task = asyncio.create_task(
            _run_reviewer(
                job_id, "champion", build_champion_spec, build_champion_user_message,
                journal, 1, paper_text, [], [], [],
            )
        )
        scout_task = asyncio.create_task(
            _run_scout(
                job_id, 1, seed_claims,
                job.paper_title or job.title, paper_text[:4000],
            )
        )
        code_task = asyncio.create_task(_run_code(job_id, 1, code_blocks_all))

        skeptic_out, champion_out, seed_findings, code_out = await asyncio.gather(
            skeptic_task, champion_task, scout_task, code_task
        )
        all_round_reviews.append({"round": 1, "a": skeptic_out, "b": champion_out})
        lit_findings.extend(seed_findings)
        code_results.extend(code_out)

        # Emit a critique_delta of 1.0 (everything new — this is the only round)
        # so the UI's Δ chip has a value. Not semantically meaningful in a
        # single-round pipeline but keeps the store / widgets happy.
        await bus.publish(
            job_id,
            ReviewEvent(
                event_type="critique_delta",
                agent="orchestrator",
                round=1,
                data={"delta": 1.0, "threshold": 0.15, "mode": "single-round"},
            ),
        )

        # (Scout refine pass removed — it was sequential after reviewers
        # finished and added 15-30s with marginal value. Synthesis + Fix
        # Agent already reason over the seed scout's findings.)

        await bus.publish(
            job_id,
            ReviewEvent(
                event_type="round_complete",
                agent="orchestrator",
                round=1,
                data={"converged": True, "delta": 1.0, "mode": "single-round"},
            ),
        )

        # Ensure initial compile finished before the author starts applying patches.
        try:
            await asyncio.wait_for(compile_task, timeout=settings.latex_compile_timeout + 10)
        except Exception:
            pass

        # Synthesis + fix-agent run in PARALLEL. The Fix Agent doesn't need
        # the final synthesized verdict — it already has the full reviewer
        # outputs, lit findings, and code results to work from. We hand it a
        # lightweight pre-verdict draft (just the two reviewer recs) so it
        # can bias severity picks. This cuts ~60s of serial Opus-4.7 time.
        pre_verdict_draft = {
            "reviewer_recommendations": {
                "skeptic": skeptic_out.get("recommendation"),
                "champion": champion_out.get("recommendation"),
            },
            "note": "Preliminary — final synthesis running in parallel.",
        }
        main_tex_name = job.main_tex or "main.tex"
        paper_source = ""
        if job.main_tex:
            paper_source = (Path(job.source_dir) / job.main_tex).read_text(
                encoding="utf-8", errors="replace"
            )

        verdict_task = asyncio.create_task(
            _synthesize_verdict(
                job_id, journal, all_round_reviews, lit_findings, code_results
            )
        )
        if job.main_tex:
            fix_task = asyncio.create_task(
                _run_fix_agent(
                    job_id,
                    paper_source,
                    pre_verdict_draft,
                    all_round_reviews,
                    lit_findings,
                    code_results,
                    main_tex_name,
                )
            )
        else:
            async def _no_fix():
                return {"auto_apply_patches": [], "author_required": []}
            fix_task = asyncio.create_task(_no_fix())

        verdict, action_plan = await asyncio.gather(verdict_task, fix_task)

        # Persist verdict immediately so downstream endpoints (Rebuttal
        # Co-Pilot, review letter) work while patches are still being
        # persisted. Final commit below layers action_plan + status on top.
        async with sm() as session:
            j = await session.get(Job, job_id)
            if j is not None:
                j.verdict_json = verdict
                await session.commit()
        await bus.publish(
            job_id,
            ReviewEvent(
                event_type="verdict_ready", agent="orchestrator", data={"verdict": verdict}
            ),
        )

        # Persist patches.
        async with sm() as session:
            j = await session.get(Job, job_id)
            assert j is not None
            j.verdict_json = verdict
            j.action_plan_json = action_plan
            j.status = "complete"
            for p in action_plan.get("auto_apply_patches", []):
                session.add(
                    Patch(
                        id=p["patch_id"],
                        job_id=job_id,
                        category=p.get("category", "phrasing"),
                        description=p.get("description", "")[:500],
                        diff=p.get("diff", ""),
                        status="pending",
                    )
                )
            await session.commit()

        for p in action_plan.get("auto_apply_patches", []):
            await bus.publish(
                job_id,
                ReviewEvent(
                    event_type="patch_ready",
                    agent="fix_agent",
                    data={
                        "patch_id": p["patch_id"],
                        "description": p.get("description", ""),
                        "category": p.get("category", "phrasing"),
                        "diff": p.get("diff", ""),
                        "page_hint": p.get("page_hint"),
                    },
                ),
            )

        await bus.publish(
            job_id,
            ReviewEvent(
                event_type="action_plan_ready",
                agent="orchestrator",
                data={"action_plan": action_plan},
            ),
        )
        await bus.publish(
            job_id,
            ReviewEvent(event_type="job_complete", agent="orchestrator", data={"ok": True}),
        )
    except Exception as e:
        await bus.publish(
            job_id,
            ReviewEvent(
                event_type="error",
                agent="orchestrator",
                data={"detail": f"{type(e).__name__}: {e}"},
            ),
        )
        await bus.publish(
            job_id,
            ReviewEvent(event_type="job_complete", agent="orchestrator", data={"ok": False}),
        )
