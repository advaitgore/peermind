"""Implementation of the literature-search tools.

Shared between the standalone MCP server and the Managed-Agent custom tools so
both paths hit the same well-tested functions.
"""
from __future__ import annotations

import asyncio
import xml.etree.ElementTree as ET
from typing import Any

import httpx

from ..config import get_settings

SEMANTIC_SCHOLAR_SEARCH = "https://api.semanticscholar.org/graph/v1/paper/search"
SEMANTIC_SCHOLAR_PAPER = "https://api.semanticscholar.org/graph/v1/paper/{paper_id}"
ARXIV_QUERY = "http://export.arxiv.org/api/query"

_ss_last_call: float = 0.0
_ss_lock = asyncio.Lock()
_ARXIV_NS = {"atom": "http://www.w3.org/2005/Atom"}


async def _ss_rate_limit() -> None:
    global _ss_last_call
    async with _ss_lock:
        now = asyncio.get_running_loop().time()
        wait = 0.5 - (now - _ss_last_call)
        if wait > 0:
            await asyncio.sleep(wait)
        _ss_last_call = asyncio.get_running_loop().time()


async def search_semantic_scholar(
    query: str, year_min: int | None = None, limit: int = 5
) -> dict[str, Any]:
    settings = get_settings()
    headers = {}
    if settings.semantic_scholar_api_key:
        headers["x-api-key"] = settings.semantic_scholar_api_key

    params: dict[str, Any] = {
        "query": query,
        "fields": "title,year,authors,abstract,citationCount,externalIds",
        "limit": max(1, min(limit, 10)),
    }
    if year_min:
        params["year"] = f"{year_min}-"

    await _ss_rate_limit()
    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.get(SEMANTIC_SCHOLAR_SEARCH, params=params, headers=headers)
        if resp.status_code != 200:
            return {"papers": [], "error": f"semantic_scholar_{resp.status_code}"}
        data = resp.json()
    papers = []
    for p in data.get("data", []):
        papers.append(
            {
                "id": p.get("paperId") or (p.get("externalIds", {}) or {}).get("DOI") or "",
                "title": p.get("title", ""),
                "year": p.get("year"),
                "authors": [a.get("name") for a in p.get("authors", []) if a.get("name")],
                "abstract": p.get("abstract", "") or "",
                "citationCount": p.get("citationCount") or 0,
                "source": "semantic_scholar",
            }
        )
    return {"papers": papers}


async def fetch_paper_details(paper_id: str) -> dict[str, Any]:
    settings = get_settings()
    headers = {}
    if settings.semantic_scholar_api_key:
        headers["x-api-key"] = settings.semantic_scholar_api_key

    await _ss_rate_limit()
    params = {"fields": "title,year,authors,abstract,citationCount,references.title,references.paperId"}
    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.get(
            SEMANTIC_SCHOLAR_PAPER.format(paper_id=paper_id),
            params=params,
            headers=headers,
        )
        if resp.status_code != 200:
            return {"error": f"semantic_scholar_{resp.status_code}"}
        return resp.json()


async def search_arxiv(query: str, max_results: int = 5) -> dict[str, Any]:
    params = {
        "search_query": query,
        "max_results": max(1, min(max_results, 10)),
        "sortBy": "relevance",
        "sortOrder": "descending",
    }
    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.get(ARXIV_QUERY, params=params)
        if resp.status_code != 200:
            return {"papers": [], "error": f"arxiv_{resp.status_code}"}
        text = resp.text

    papers = []
    try:
        root = ET.fromstring(text)
        for entry in root.findall("atom:entry", _ARXIV_NS):
            title_el = entry.find("atom:title", _ARXIV_NS)
            abstract_el = entry.find("atom:summary", _ARXIV_NS)
            published_el = entry.find("atom:published", _ARXIV_NS)
            id_el = entry.find("atom:id", _ARXIV_NS)
            authors = [
                (a.find("atom:name", _ARXIV_NS).text or "").strip()  # type: ignore[union-attr]
                for a in entry.findall("atom:author", _ARXIV_NS)
                if a.find("atom:name", _ARXIV_NS) is not None
            ]
            papers.append(
                {
                    "id": (id_el.text or "").rsplit("/", 1)[-1] if id_el is not None else "",
                    "title": (title_el.text or "").strip().replace("\n", " ") if title_el is not None else "",
                    "year": int((published_el.text or "0000-01-01")[:4]) if published_el is not None else None,
                    "authors": authors,
                    "abstract": (abstract_el.text or "").strip() if abstract_el is not None else "",
                    "citationCount": None,
                    "source": "arxiv",
                }
            )
    except ET.ParseError as e:
        return {"papers": [], "error": f"arxiv_parse_{e}"}
    return {"papers": papers}
