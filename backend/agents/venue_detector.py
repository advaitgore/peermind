"""Venue auto-detection — quick Haiku 4.5 classification from title + abstract.

Returns a preset journal_id when the paper clearly fits one of the six
pre-registered profiles (NeurIPS, ICML, ICLR, Nature, Science, arXiv),
otherwise returns `custom` with a natural-language `display_name` (e.g.
"EMNLP", "CVPR", "PNAS", "Cell"). The detection runs inline during
create_job so the landing page can pre-fill the venue selector.
"""
from __future__ import annotations

import json
from typing import Any

from anthropic import AsyncAnthropic

from ..config import get_settings
from .agent_factory import extract_json


_SYSTEM = """You are a venue classifier for scientific papers. Given a paper's title and abstract, classify which peer-review venue the work appears targeted at.

Pick exactly ONE of these preset ids when the paper clearly fits:
- neurips — ML research emphasizing empirical + theoretical contribution
- icml — ML research, methodology focus, strong empirical
- iclr — representation-learning / deep-learning focus, open peer review
- nature — major cross-disciplinary scientific advance, broad interest
- science — exceptional scientific importance + broad interdisciplinary appeal
- arxiv — preprint with no clear target venue yet

For papers that don't fit those six (NLP → EMNLP/ACL, vision → CVPR/ICCV, biology → PNAS/Cell, physics → PRL, etc.), pick id "custom" and set display_name to the venue you'd actually suggest.

Output ONLY a single JSON object, no prose:
{"journal_id": "<one of the 7 ids above>", "display_name": "<canonical short name, e.g. 'ICML' or 'EMNLP'>", "rationale": "<one sentence on why you picked it>", "confidence": <0.0-1.0>}

If the abstract is empty or the paper's subject is unclear, return journal_id="arxiv" with confidence < 0.4."""


async def detect_venue(
    paper_title: str | None,
    paper_text: str | None,
    *,
    max_abstract_chars: int = 3500,
) -> dict[str, Any]:
    """Classify a paper's likely target venue. Best-effort; errors return arxiv."""
    settings = get_settings()
    title = (paper_title or "").strip() or "(no title)"
    abstract = (paper_text or "")[:max_abstract_chars].strip()

    user = (
        f"Title: {title}\n\n"
        f"Abstract / beginning of paper:\n{abstract[:max_abstract_chars] or '(empty)'}"
    )

    try:
        client = AsyncAnthropic(api_key=settings.anthropic_api_key or None)
        msg = await client.messages.create(
            model="claude-haiku-4-5-20251001",
            max_tokens=400,
            system=_SYSTEM,
            messages=[{"role": "user", "content": user}],
        )
        text = "".join(
            getattr(b, "text", "") for b in msg.content if getattr(b, "type", None) == "text"
        )
    except Exception as e:
        return {
            "journal_id": "arxiv",
            "display_name": "arXiv",
            "rationale": f"Detection unavailable ({type(e).__name__}); defaulted to arXiv.",
            "confidence": 0.2,
        }

    parsed = extract_json(text) or {}
    jid = parsed.get("journal_id") or "arxiv"
    if jid not in {"neurips", "icml", "iclr", "nature", "science", "arxiv", "custom"}:
        jid = "arxiv"
    display = parsed.get("display_name") or (
        {
            "neurips": "NeurIPS",
            "icml": "ICML",
            "iclr": "ICLR",
            "nature": "Nature",
            "science": "Science",
            "arxiv": "arXiv",
        }.get(jid, "the target venue")
    )
    rationale = parsed.get("rationale") or ""
    confidence = parsed.get("confidence")
    try:
        confidence = max(0.0, min(1.0, float(confidence))) if confidence is not None else 0.5
    except Exception:
        confidence = 0.5

    return {
        "journal_id": jid,
        "display_name": display,
        "rationale": rationale[:400],
        "confidence": confidence,
    }
