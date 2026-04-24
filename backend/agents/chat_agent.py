"""Conversational agent — user-facing chat about a specific paper review.

The chat has the paper, both reviewers' round-by-round output, the final
verdict, action plan, literature findings, and code-execution results as
grounded context. It's allowed to answer free-form questions, help the user
interpret specific weaknesses, draft rebuttal language, or discuss trade-offs
between AUTHOR_REQUIRED actions.
"""
from __future__ import annotations

import json
from typing import Any, AsyncIterator

from anthropic import AsyncAnthropic

from ..config import get_settings
from ..models.database import Job, get_sessionmaker


def _build_system_prompt(job: Job) -> str:
    verdict = job.verdict_json or {}
    action_plan = job.action_plan_json or {}
    paper_text = (job.paper_text or "")[:80_000]
    title = job.paper_title or job.title or "an untitled paper"

    # Context-stuffed system: the paper + the review artifacts. Claude reads
    # this once and can then answer without needing tool use.
    return f"""You are the research assistant inside PeerMind, an AI-powered peer review workbench. The user just ran a multi-agent review of a scientific paper and is looking at the verdict + action plan. They can ask you to explain a critique, draft rebuttal language, compare reviewers' positions, pick which action item to tackle first, or clarify anything about the paper.

RULES:
- You are grounded in the paper and the reviews. Cite specific sections or reviewer points when you answer.
- When the user asks "what should I do?", suggest based on severity, effort, and what's load-bearing for the verdict.
- Be concise. Scientist-to-scientist tone.
- If the user asks something outside the paper's scope (generic ML questions, unrelated), answer briefly but redirect to the paper.
- You do NOT edit the paper directly. If the user wants a patch, point them to the Fix Agent's queued patches.

==== PAPER ({title}) ====

{paper_text}

==== VERDICT ====

{json.dumps(verdict, indent=2)[:6000]}

==== ACTION PLAN ====

{json.dumps(action_plan, indent=2)[:6000]}
"""


async def stream_chat_response(
    job_id: str,
    history: list[dict[str, str]],
    user_message: str,
) -> AsyncIterator[str]:
    """Stream tokens from Opus 4.7 given the chat history + new user message."""
    sm = get_sessionmaker()
    async with sm() as session:
        job = await session.get(Job, job_id)
    if job is None:
        yield json.dumps({"error": "job_not_found"})
        return

    settings = get_settings()
    client = AsyncAnthropic(api_key=settings.anthropic_api_key or None)

    system_text = _build_system_prompt(job)
    # Prompt caching on the paper + verdict + action plan. The first chat
    # turn pays the full cost; every subsequent turn within the 5-minute
    # cache TTL reuses the cached tokens — faster + cheaper.
    system_blocks = [
        {
            "type": "text",
            "text": system_text,
            "cache_control": {"type": "ephemeral"},
        }
    ]
    messages: list[dict[str, Any]] = []
    for turn in history:
        if turn.get("role") in ("user", "assistant") and turn.get("content"):
            messages.append({"role": turn["role"], "content": turn["content"]})
    messages.append({"role": "user", "content": user_message})

    # Sonnet 4.5 for chat: Q&A over the paper doesn't need extended reasoning,
    # and Sonnet responds 2-3x faster, which matters for a conversational
    # loop. Opus 4.7 is reserved for the verdict synthesis and the Fix Agent.
    async with client.messages.stream(
        model="claude-sonnet-4-5",
        max_tokens=2048,
        system=system_blocks,
        messages=messages,
    ) as stream:
        async for text in stream.text_stream:
            yield text
