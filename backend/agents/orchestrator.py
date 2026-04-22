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


def _load_journal(journal_id: str) -> dict[str, Any]:
    path = Path(__file__).resolve().parent.parent / "journal_profiles" / "profiles.json"
    data = json.loads(path.read_text(encoding="utf-8"))
    if journal_id not in data:
        raise KeyError(f"Unknown journal profile: {journal_id}")
    profile = dict(data[journal_id])
    profile["id"] = journal_id
    return profile


# ---------- Initial compile ----------


async def _initial_compile(job: Job) -> None:
    if not job.main_tex:
        return
    src = Path(job.source_dir)
    await bus.publish(
        job.id,
        ReviewEvent(
            event_type="compile_started",
            agent="system",
            data={"stage": "initial"},
        ),
    )
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
                },
            ),
        )
    else:
        await bus.publish(
            job.id,
            ReviewEvent(
                event_type="compile_error",
                agent="system",
                data={"log": res.log[-4000:], "stage": "initial"},
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
    await bus.publish(
        job_id,
        ReviewEvent(event_type="literature_started", agent="scout", round=round_num, data={"claims": len(claims)}),
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
    await bus.publish(
        job_id,
        ReviewEvent(
            event_type="code_started",
            agent="code_runner",
            round=round_num,
            data={"blocks": len(code_blocks)},
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

    # Extended thinking for the synthesis step — this is where we earn the
    # extra tokens: weighing both reviewers against literature + code evidence.
    try:
        msg = await client.messages.create(
            model="claude-opus-4-7",
            max_tokens=8192,
            thinking={"type": "enabled", "budget_tokens": 4096},
            system=system,
            messages=[{"role": "user", "content": user}],
        )
        text = "".join(
            getattr(b, "text", "") for b in msg.content if getattr(b, "type", None) == "text"
        )
    except Exception:
        # Extended thinking may not be enabled on the account; fall back.
        msg = await client.messages.create(
            model="claude-opus-4-7",
            max_tokens=8192,
            system=system,
            messages=[{"role": "user", "content": user}],
        )
        text = "".join(
            getattr(b, "text", "") for b in msg.content if getattr(b, "type", None) == "text"
        )

    return extract_json(text) or {
        "recommendation": "borderline",
        "confidence": 0.3,
        "one_line_verdict": "Unable to synthesize — see individual reviews.",
        "reviewer_recommendations": {},
        "consensus_issues": [],
        "disagreements_arbitrated": [],
        "scores_synthesis": {},
    }


# ---------- Fix Agent (patches + action plan) ----------


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
    parsed = extract_json(out) or {"auto_apply_patches": [], "author_required": []}
    # Ensure patch_ids exist.
    for p in parsed.get("auto_apply_patches", []):
        if "patch_id" not in p or not p["patch_id"]:
            p["patch_id"] = "p_" + uuid.uuid4().hex[:8]
    return parsed


# ---------- Public entrypoint ----------


async def run_review_pipeline(job_id: str, journal_id: str) -> None:
    """Top-level pipeline. Publishes SSE events throughout and terminates with job_complete."""
    sm = get_sessionmaker()
    async with sm() as session:
        job = await session.get(Job, job_id)
    if job is None:
        return

    try:
        journal = _load_journal(journal_id)

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
        settings = get_settings()

        prev_claims: list[str] = []
        for round_num in range(1, settings.max_review_rounds + 1):
            await bus.publish(
                job_id,
                ReviewEvent(
                    event_type="round_started",
                    agent="orchestrator",
                    round=round_num,
                    data={"of": settings.max_review_rounds},
                ),
            )

            # Run skeptic and champion in parallel.
            skeptic_task = asyncio.create_task(
                _run_reviewer(
                    job_id,
                    "skeptic",
                    build_skeptic_spec,
                    build_skeptic_user_message,
                    journal,
                    round_num,
                    paper_text,
                    all_round_reviews,
                    lit_findings,
                    code_results,
                )
            )
            champion_task = asyncio.create_task(
                _run_reviewer(
                    job_id,
                    "champion",
                    build_champion_spec,
                    build_champion_user_message,
                    journal,
                    round_num,
                    paper_text,
                    all_round_reviews,
                    lit_findings,
                    code_results,
                )
            )
            skeptic_out, champion_out = await asyncio.gather(skeptic_task, champion_task)

            all_round_reviews.append(
                {"round": round_num, "a": skeptic_out, "b": champion_out}
            )

            # Critique delta: compare this round's combined claims against previous.
            current_claims = (skeptic_out.get("key_claims_to_verify") or []) + (
                champion_out.get("key_claims_to_verify") or []
            )
            delta = compute_critique_delta(prev_claims, current_claims) if prev_claims else 1.0
            await bus.publish(
                job_id,
                ReviewEvent(
                    event_type="critique_delta",
                    agent="orchestrator",
                    round=round_num,
                    data={"delta": delta, "threshold": settings.critique_delta_threshold},
                ),
            )

            # If round >= 2 and we've converged, break.
            if round_num >= 2 and delta < settings.critique_delta_threshold:
                await bus.publish(
                    job_id,
                    ReviewEvent(
                        event_type="round_complete",
                        agent="orchestrator",
                        round=round_num,
                        data={"converged": True, "delta": delta},
                    ),
                )
                break

            prev_claims = current_claims

            # Unless this was the last round, run scout + code_runner to enrich next round.
            if round_num < settings.max_review_rounds:
                scout_task = asyncio.create_task(
                    _run_scout(
                        job_id,
                        round_num,
                        current_claims[:15],
                        job.paper_title or job.title,
                        paper_text[:4000],
                    )
                )
                code_task = asyncio.create_task(_run_code(job_id, round_num, code_blocks_all))
                new_lit, new_code = await asyncio.gather(scout_task, code_task)
                lit_findings.extend(new_lit)
                code_results.extend(new_code)

            await bus.publish(
                job_id,
                ReviewEvent(
                    event_type="round_complete",
                    agent="orchestrator",
                    round=round_num,
                    data={"converged": False, "delta": delta},
                ),
            )

        # Ensure initial compile finished before the author starts applying patches.
        try:
            await asyncio.wait_for(compile_task, timeout=settings.latex_compile_timeout + 10)
        except Exception:
            pass

        # Synthesize the verdict with extended thinking.
        verdict = await _synthesize_verdict(journal, all_round_reviews, lit_findings, code_results)
        await bus.publish(
            job_id,
            ReviewEvent(
                event_type="verdict_ready", agent="orchestrator", data={"verdict": verdict}
            ),
        )

        # Fix agent: patches + action plan.
        main_tex_name = job.main_tex or "main.tex"
        action_plan = {"auto_apply_patches": [], "author_required": []}
        if job.main_tex:
            paper_source = (Path(job.source_dir) / job.main_tex).read_text(
                encoding="utf-8", errors="replace"
            )
            action_plan = await _run_fix_agent(
                job_id,
                paper_source,
                verdict,
                all_round_reviews,
                lit_findings,
                code_results,
                main_tex_name,
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
