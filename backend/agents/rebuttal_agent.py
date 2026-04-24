"""Rebuttal Co-Pilot — drafts an author rebuttal letter.

Streams tokens through the event bus as `rebuttal_token` events so the UI's
RebuttalPanel renders them live. Emits `rebuttal_started` before the first
token and `rebuttal_complete` (with the full text) once the stream closes.

Grounded context: verdict + full action plan + both reviewers' final
outputs + applied patches (so the rebuttal can say "this has been corrected
in the revision"). Opus 4.7 because rebuttals need careful reasoning about
concede/clarify/refute classification.
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from anthropic import AsyncAnthropic
from sqlalchemy import select

from ..config import get_settings
from ..event_bus import bus
from ..models.database import Job, Patch, get_sessionmaker
from ..models.schemas import ReviewEvent
from .skills import load_skill, render_prompt


def _load_journal_full_name(journal_id: str | None) -> str:
    if not journal_id:
        return "the target venue"
    try:
        path = Path(__file__).resolve().parent.parent / "journal_profiles" / "profiles.json"
        data = json.loads(path.read_text(encoding="utf-8"))
        return data.get(journal_id, {}).get("full_name", journal_id)
    except Exception:
        return journal_id


async def draft_rebuttal(job_id: str) -> str:
    """Stream a rebuttal draft. Publishes rebuttal_* events via the bus and
    persists the final text on the Job row. Returns the full rebuttal text."""
    sm = get_sessionmaker()
    async with sm() as session:
        job = await session.get(Job, job_id)
        if job is None:
            raise ValueError(f"Unknown job: {job_id}")
        patches = (
            await session.execute(select(Patch).where(Patch.job_id == job_id))
        ).scalars().all()
        applied = [
            {"description": p.description, "category": p.category}
            for p in patches
            if p.status == "applied"
        ]

    verdict = job.verdict_json or {}
    action_plan = job.action_plan_json or {}
    skill = load_skill("rebuttal")
    system = render_prompt(
        skill.system_prompt_template,
        {
            "journal_name": _load_journal_full_name(job.journal),
            "paper_title": (job.paper_title or job.title or "Untitled paper"),
        },
    )

    # The model works better with the critical context in the user turn
    # rather than stuffed into the system prompt.
    user_payload = {
        "verdict": verdict,
        "action_plan": action_plan,
        "applied_patches": applied,
        "paper_excerpt": (job.paper_text or "")[:20_000],
    }
    user = json.dumps(user_payload, indent=2)[:150_000]

    await bus.publish(
        job_id,
        ReviewEvent(
            event_type="rebuttal_started",
            agent="orchestrator",
            data={},
        ),
    )

    settings = get_settings()
    client = AsyncAnthropic(api_key=settings.anthropic_api_key or None)

    buf: list[str] = []
    try:
        # Sonnet 4.5 on the rebuttal: the concede/clarify/refute classification
        # + author-voice drafting are well within Sonnet's range, and the
        # ~2x speedup matters because the user watches the draft stream live.
        # Cache the heavy user payload (paper excerpt + verdict + action plan).
        # If the user hits "Re-draft" within the 5-minute TTL, the second call
        # reuses the cached tokens.
        async with client.messages.stream(
            model="claude-sonnet-4-5",
            max_tokens=8192,
            system=system,
            messages=[
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "text",
                            "text": user,
                            "cache_control": {"type": "ephemeral"},
                        }
                    ],
                }
            ],
        ) as stream:
            async for chunk in stream.text_stream:
                if not chunk:
                    continue
                buf.append(chunk)
                await bus.publish(
                    job_id,
                    ReviewEvent(
                        event_type="rebuttal_token",
                        agent="orchestrator",
                        data={"text": chunk},
                    ),
                )
    except Exception as e:
        await bus.publish(
            job_id,
            ReviewEvent(
                event_type="error",
                agent="orchestrator",
                data={"detail": f"rebuttal: {type(e).__name__}: {e}"},
            ),
        )
        raise

    full = "".join(buf).strip()

    # Persist so the UI can reload the draft without re-running the agent,
    # and the /rebuttal-letter export has something to render.
    async with sm() as session:
        j = await session.get(Job, job_id)
        if j is not None:
            j.rebuttal_text = full
            await session.commit()

    await bus.publish(
        job_id,
        ReviewEvent(
            event_type="rebuttal_complete",
            agent="orchestrator",
            data={"text": full, "word_count": len(full.split())},
        ),
    )
    return full
