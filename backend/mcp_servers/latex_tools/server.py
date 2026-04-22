"""MCP server exposing LaTeX compile, patch, and extraction tools for PeerMind.

Run standalone:
    python -m backend.mcp_servers.latex_tools.server
"""
from __future__ import annotations

import asyncio
import json

from mcp.server import Server
from mcp.server.stdio import stdio_server
from mcp.types import TextContent, Tool

from ...tools.latex_tools import (
    tool_apply_patch,
    tool_compile_latex,
    tool_extract_paper_text,
    tool_get_pdf_url,
    tool_read_source,
)

server: Server = Server("peermind-latex-tools")


@server.list_tools()  # type: ignore[misc]
async def list_tools() -> list[Tool]:
    return [
        Tool(
            name="compile_latex",
            description=(
                "Run latexmk in a sandbox on the job's LaTeX source. Returns success "
                "flag, compile log, elapsed ms, and — on success — the PDF URL."
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "job_id": {"type": "string"},
                    "main_tex": {"type": "string", "description": "Optional main .tex filename"},
                },
                "required": ["job_id"],
            },
        ),
        Tool(
            name="apply_patch",
            description=(
                "Apply a unified diff to the job's main .tex, then recompile. On "
                "compile failure the patch is rolled back."
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "job_id": {"type": "string"},
                    "unified_diff": {"type": "string"},
                    "main_tex": {"type": "string"},
                },
                "required": ["job_id", "unified_diff"],
            },
        ),
        Tool(
            name="get_pdf_url",
            description="Return the serve URL for the job's most recently compiled PDF.",
            inputSchema={
                "type": "object",
                "properties": {"job_id": {"type": "string"}},
                "required": ["job_id"],
            },
        ),
        Tool(
            name="extract_paper_text",
            description=(
                "Extract full text, title, code blocks, citations, and section "
                "structure from the job's uploaded .tex or PDF."
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "job_id": {"type": "string"},
                    "main_tex": {"type": "string"},
                },
                "required": ["job_id"],
            },
        ),
        Tool(
            name="read_source",
            description="Read a single source file from the job directory by relative path.",
            inputSchema={
                "type": "object",
                "properties": {
                    "job_id": {"type": "string"},
                    "rel_path": {"type": "string"},
                },
                "required": ["job_id", "rel_path"],
            },
        ),
    ]


@server.call_tool()  # type: ignore[misc]
async def call_tool(name: str, arguments: dict) -> list[TextContent]:
    if name == "compile_latex":
        res = await tool_compile_latex(arguments["job_id"], arguments.get("main_tex"))
    elif name == "apply_patch":
        res = await tool_apply_patch(
            arguments["job_id"], arguments["unified_diff"], arguments.get("main_tex")
        )
    elif name == "get_pdf_url":
        res = await tool_get_pdf_url(arguments["job_id"])
    elif name == "extract_paper_text":
        res = await tool_extract_paper_text(arguments["job_id"], arguments.get("main_tex"))
    elif name == "read_source":
        res = tool_read_source(arguments["job_id"], arguments["rel_path"])
    else:
        res = {"error": f"unknown_tool:{name}"}
    return [TextContent(type="text", text=json.dumps(res))]


async def _main() -> None:
    async with stdio_server() as (read_stream, write_stream):
        await server.run(read_stream, write_stream, server.create_initialization_options())


if __name__ == "__main__":
    asyncio.run(_main())
