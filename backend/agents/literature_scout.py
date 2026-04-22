"""Literature Scout — searches Semantic Scholar + arXiv for contradictions and missing prior art."""
from __future__ import annotations

import json
from typing import Any

from ..tools.literature import (
    fetch_paper_details,
    search_arxiv,
    search_semantic_scholar,
)
from .agent_factory import AgentSpec
from .skills import load_skill


def _as_int(v: Any, default: int) -> int:
    try:
        return int(v)
    except Exception:
        return default


async def _impl_search_semantic_scholar(args: dict[str, Any]) -> dict[str, Any]:
    return await search_semantic_scholar(
        query=str(args.get("query", "")),
        year_min=args.get("year_min"),
        limit=_as_int(args.get("limit", 5), 5),
    )


async def _impl_search_arxiv(args: dict[str, Any]) -> dict[str, Any]:
    return await search_arxiv(
        query=str(args.get("query", "")),
        max_results=_as_int(args.get("max_results", 5), 5),
    )


async def _impl_fetch_paper_details(args: dict[str, Any]) -> dict[str, Any]:
    return await fetch_paper_details(str(args.get("paper_id", "")))


SCOUT_TOOLS = [
    {
        "type": "custom",
        "name": "search_semantic_scholar",
        "description": (
            "Search Semantic Scholar for published papers matching a query. Returns "
            "title, year, authors, abstract, citationCount. Use for established prior art."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "query": {"type": "string"},
                "year_min": {"type": "integer"},
                "limit": {"type": "integer", "default": 5},
            },
            "required": ["query"],
        },
    },
    {
        "type": "custom",
        "name": "search_arxiv",
        "description": (
            "Search arXiv for recent preprints matching a query. Use for work from "
            "the last 1-2 years that may not be indexed elsewhere yet."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "query": {"type": "string"},
                "max_results": {"type": "integer", "default": 5},
            },
            "required": ["query"],
        },
    },
    {
        "type": "custom",
        "name": "fetch_paper_details",
        "description": "Get full details (including references) for a specific paper by Semantic Scholar ID or DOI.",
        "input_schema": {
            "type": "object",
            "properties": {"paper_id": {"type": "string"}},
            "required": ["paper_id"],
        },
    },
]

SCOUT_IMPLS = {
    "search_semantic_scholar": _impl_search_semantic_scholar,
    "search_arxiv": _impl_search_arxiv,
    "fetch_paper_details": _impl_fetch_paper_details,
}


def build_scout_spec() -> AgentSpec:
    skill = load_skill("literature")
    return AgentSpec(
        name="peermind-scout",
        model="claude-sonnet-4-5",
        system=skill.system_prompt_template,
        tools=SCOUT_TOOLS,
        custom_tool_impls=SCOUT_IMPLS,
    )


def build_scout_user_message(
    claims: list[str], paper_title: str | None, paper_abstract: str
) -> str:
    return json.dumps(
        {
            "paper_title": paper_title,
            "paper_abstract": paper_abstract[:4000],
            "claims_to_verify": claims[:25],
        },
        indent=2,
    )
