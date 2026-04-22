"""MCP server exposing Semantic Scholar + arXiv tools to any MCP client.

Run standalone:
    python -m backend.mcp_servers.literature_search.server

This is a real MCP stdio server. In the PeerMind agent pipeline, the same
underlying functions are also exposed to Managed Agents via custom tools, so
the pipeline works even if the MCP server is not running. The MCP server
lets you plug PeerMind's literature tools into Claude Desktop, Cursor, or any
other MCP-compatible client.
"""
from __future__ import annotations

import asyncio

from mcp.server import Server
from mcp.server.stdio import stdio_server
from mcp.types import TextContent, Tool

from ...tools.literature import (
    fetch_paper_details,
    search_arxiv,
    search_semantic_scholar,
)

server: Server = Server("peermind-literature-search")


@server.list_tools()  # type: ignore[misc]
async def list_tools() -> list[Tool]:
    return [
        Tool(
            name="search_semantic_scholar",
            description=(
                "Search Semantic Scholar for papers matching a query. Returns title, "
                "year, authors, abstract, and citation count. Use this when you need "
                "well-cited prior work or when you want reliable author lists."
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "query": {"type": "string"},
                    "year_min": {"type": "integer", "description": "Optional minimum publication year"},
                    "limit": {"type": "integer", "default": 5, "minimum": 1, "maximum": 10},
                },
                "required": ["query"],
            },
        ),
        Tool(
            name="search_arxiv",
            description=(
                "Search arXiv for recent preprints matching a query. Best for work "
                "from the last 1-2 years that may not be indexed with high citation counts yet."
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "query": {"type": "string"},
                    "max_results": {"type": "integer", "default": 5, "minimum": 1, "maximum": 10},
                },
                "required": ["query"],
            },
        ),
        Tool(
            name="fetch_paper_details",
            description=(
                "Fetch detailed metadata for a paper by its Semantic Scholar paperId "
                "(or DOI), including references."
            ),
            inputSchema={
                "type": "object",
                "properties": {"paper_id": {"type": "string"}},
                "required": ["paper_id"],
            },
        ),
    ]


@server.call_tool()  # type: ignore[misc]
async def call_tool(name: str, arguments: dict) -> list[TextContent]:
    import json

    if name == "search_semantic_scholar":
        res = await search_semantic_scholar(
            arguments["query"],
            year_min=arguments.get("year_min"),
            limit=arguments.get("limit", 5),
        )
    elif name == "search_arxiv":
        res = await search_arxiv(
            arguments["query"], max_results=arguments.get("max_results", 5)
        )
    elif name == "fetch_paper_details":
        res = await fetch_paper_details(arguments["paper_id"])
    else:
        res = {"error": f"unknown_tool:{name}"}
    return [TextContent(type="text", text=json.dumps(res))]


async def _main() -> None:
    async with stdio_server() as (read_stream, write_stream):
        await server.run(read_stream, write_stream, server.create_initialization_options())


if __name__ == "__main__":
    asyncio.run(_main())
