"""LaTeX source utilities: locate main .tex, compile in sandbox, apply unified diffs.

Compile strategy:
- If `docker` is available, run `latexmk` inside the tagged TeX Live image.
- If not (local dev on a machine without Docker), fall back to a host `latexmk`.
  This keeps local dev easy while preserving the prod sandbox.
"""
from __future__ import annotations

import asyncio
import os
import shutil
import subprocess
import time
from dataclasses import dataclass
from pathlib import Path

try:
    from unidiff import PatchSet
except Exception:  # pragma: no cover
    PatchSet = None  # type: ignore[assignment]

from ..config import get_settings

MAIN_CANDIDATES = ("main.tex", "paper.tex", "ms.tex", "manuscript.tex", "article.tex")


def find_main_tex(source_dir: Path) -> str | None:
    source_dir = Path(source_dir)
    for cand in MAIN_CANDIDATES:
        if (source_dir / cand).exists():
            return cand
    # Pick the .tex file that contains \documentclass.
    for tex in source_dir.rglob("*.tex"):
        try:
            head = tex.read_text(encoding="utf-8", errors="replace")[:4096]
        except Exception:
            continue
        if "\\documentclass" in head:
            return str(tex.relative_to(source_dir)).replace("\\", "/")
    # Fall back to any .tex at the root.
    for tex in source_dir.glob("*.tex"):
        return tex.name
    return None


def read_source_file(path: Path) -> str:
    return Path(path).read_text(encoding="utf-8", errors="replace")


@dataclass
class CompileResult:
    success: bool
    pdf_path: Path | None
    log: str
    elapsed_ms: int


def _docker_available() -> bool:
    return shutil.which("docker") is not None


async def compile_latex(source_dir: Path, main_tex: str) -> CompileResult:
    settings = get_settings()
    source_dir = Path(source_dir).resolve()
    timeout = settings.latex_compile_timeout
    start = time.time()

    main_stem = Path(main_tex).stem

    if _docker_available():
        cmd = [
            "docker",
            "run",
            "--rm",
            "--network",
            "none",
            "-v",
            f"{source_dir}:/workspace",
            "-w",
            "/workspace",
            settings.latex_docker_image,
            "-pdf",
            "-interaction=nonstopmode",
            "-halt-on-error",
            main_tex,
        ]
    elif shutil.which("latexmk"):
        cmd = [
            "latexmk",
            "-pdf",
            "-interaction=nonstopmode",
            "-halt-on-error",
            main_tex,
        ]
    else:
        return CompileResult(
            success=False,
            pdf_path=None,
            log="Neither docker nor latexmk available on PATH",
            elapsed_ms=0,
        )

    proc = await asyncio.create_subprocess_exec(
        *cmd,
        cwd=str(source_dir) if cmd[0] != "docker" else None,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.STDOUT,
    )
    try:
        stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=timeout)
    except asyncio.TimeoutError:
        proc.kill()
        await proc.wait()
        return CompileResult(False, None, "Compile timed out", int((time.time() - start) * 1000))

    log = (stdout or b"").decode("utf-8", errors="replace")
    elapsed_ms = int((time.time() - start) * 1000)

    # Find the produced PDF.
    produced = source_dir / f"{main_stem}.pdf"
    if not produced.exists():
        # Some builds output to current working dir; try the first .pdf in source_dir
        pdfs = list(source_dir.glob("*.pdf"))
        produced = pdfs[0] if pdfs else None  # type: ignore[assignment]

    if proc.returncode == 0 and produced is not None and produced.exists():
        return CompileResult(True, produced, log, elapsed_ms)
    return CompileResult(False, None, log, elapsed_ms)


@dataclass
class PatchApplyResult:
    applied: bool
    reason: str = ""
    log: str = ""
    rollback: "callable" = lambda: None  # type: ignore[valid-type]


def apply_unified_diff(target_tex: Path, diff_text: str) -> PatchApplyResult:
    """Apply a unified diff to a single .tex file and return a rollback hook.

    Uses `unidiff` to avoid spawning the `patch` binary, which is not always
    present on Windows dev machines.
    """
    target_tex = Path(target_tex)
    original = target_tex.read_text(encoding="utf-8", errors="replace")
    snapshot_path = target_tex.with_suffix(target_tex.suffix + ".peermind-bak")
    snapshot_path.write_text(original, encoding="utf-8")

    def _rollback() -> None:
        if snapshot_path.exists():
            target_tex.write_text(
                snapshot_path.read_text(encoding="utf-8"), encoding="utf-8"
            )

    if PatchSet is None:
        return PatchApplyResult(False, "unidiff_missing", "Install `unidiff` in requirements", _rollback)

    try:
        patchset = PatchSet.from_string(diff_text)
    except Exception as e:
        return PatchApplyResult(False, "invalid_diff", str(e), _rollback)

    lines = original.splitlines(keepends=True)

    for patched_file in patchset:
        for hunk in patched_file:
            # Verify the original context matches at hunk.source_start
            src_start = hunk.source_start - 1  # 0-indexed
            src_lines = [
                line.value for line in hunk.source_lines()
            ]
            tgt_lines = [
                line.value for line in hunk.target_lines()
            ]
            current = "".join(lines[src_start : src_start + len(src_lines)])
            if current != "".join(src_lines):
                # Try a forgiving match: strip trailing whitespace on each line.
                norm_current = [ln.rstrip() for ln in current.splitlines(keepends=False)]
                norm_source = [ln.rstrip() for ln in "".join(src_lines).splitlines(keepends=False)]
                if norm_current != norm_source:
                    return PatchApplyResult(
                        False,
                        "context_mismatch",
                        f"Hunk at line {hunk.source_start} does not match current file",
                        _rollback,
                    )
            lines[src_start : src_start + len(src_lines)] = tgt_lines

    target_tex.write_text("".join(lines), encoding="utf-8")
    return PatchApplyResult(True, "", "", _rollback)
