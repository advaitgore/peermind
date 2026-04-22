"""Implementation of the latex-tools MCP tools.

Shared between the standalone MCP server and Managed-Agent custom tools.
"""
from __future__ import annotations

from pathlib import Path
from typing import Any

from ..config import get_settings
from ..utils.extract import extract_paper
from ..utils.latex import apply_unified_diff, compile_latex, read_source_file


def _job_paths(job_id: str) -> tuple[Path, Path]:
    settings = get_settings()
    job_dir = settings.jobs_root / job_id
    return job_dir, job_dir / "source"


async def tool_compile_latex(job_id: str, main_tex: str | None = None) -> dict[str, Any]:
    _, src = _job_paths(job_id)
    if not src.is_dir():
        return {"success": False, "error": "source_dir_missing"}
    main = main_tex
    if not main:
        from ..utils.latex import find_main_tex

        main = find_main_tex(src)
    if not main:
        return {"success": False, "error": "no_main_tex_detected"}
    result = await compile_latex(src, main_tex=main)
    return {
        "success": result.success,
        "pdf_url": f"/api/jobs/{job_id}/output.pdf" if result.success else None,
        "log": result.log[-8000:],
        "elapsed_ms": result.elapsed_ms,
    }


async def tool_apply_patch(
    job_id: str, unified_diff: str, main_tex: str | None = None
) -> dict[str, Any]:
    _, src = _job_paths(job_id)
    main = main_tex
    if not main:
        from ..utils.latex import find_main_tex

        main = find_main_tex(src)
    if not main:
        return {"applied": False, "reason": "no_main_tex_detected"}
    target = src / main
    res = apply_unified_diff(target, unified_diff)
    if not res.applied:
        return {"applied": False, "reason": res.reason, "log": res.log}
    compiled = await compile_latex(src, main_tex=main)
    if not compiled.success:
        res.rollback()
        return {
            "applied": False,
            "reason": "compile_failed",
            "log": compiled.log[-4000:],
        }
    return {
        "applied": True,
        "pdf_url": f"/api/jobs/{job_id}/output.pdf",
        "elapsed_ms": compiled.elapsed_ms,
    }


async def tool_get_pdf_url(job_id: str) -> dict[str, Any]:
    job_dir, _ = _job_paths(job_id)
    candidates = list(job_dir.rglob("*.pdf"))
    if not candidates:
        return {"url": None}
    return {"url": f"/api/jobs/{job_id}/output.pdf"}


async def tool_extract_paper_text(job_id: str, main_tex: str | None = None) -> dict[str, Any]:
    _, src = _job_paths(job_id)
    source_type = "tex"
    main = main_tex
    if not main:
        from ..utils.latex import find_main_tex

        main = find_main_tex(src)
        if not main and list(src.rglob("*.pdf")):
            source_type = "pdf"
    paper = await extract_paper(src, main, source_type=source_type)
    return {
        "full_text": paper.full_text,
        "title": paper.title,
        "code_blocks": paper.code_blocks,
        "citation_keys": paper.citation_keys,
        "section_structure": paper.section_structure,
    }


def tool_read_source(job_id: str, rel_path: str) -> dict[str, Any]:
    _, src = _job_paths(job_id)
    target = (src / rel_path).resolve()
    base = src.resolve()
    if base != target and base not in target.parents:
        return {"error": "path_traversal"}
    if not target.is_file():
        return {"error": "not_found"}
    return {"content": read_source_file(target)}
