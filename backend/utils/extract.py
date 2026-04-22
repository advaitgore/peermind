"""Paper-text extraction: LaTeX source (preferred) or PDF via kreuzberg/pypdf fallback.

Returns the full text, any detected title, code blocks extracted from
``verbatim``/``lstlisting`` environments, and citation keys.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path


@dataclass
class ExtractedPaper:
    full_text: str
    title: str | None = None
    code_blocks: list[dict] = field(default_factory=list)
    citation_keys: list[str] = field(default_factory=list)
    section_structure: list[str] = field(default_factory=list)


_TITLE_RE = re.compile(r"\\title\{([^{}]+(?:\{[^{}]*\}[^{}]*)*)\}", re.DOTALL)
_SECTION_RE = re.compile(r"\\section\*?\{([^{}]+)\}")
_CITE_RE = re.compile(r"\\cite[tp]?\*?\{([^}]+)\}")
_VERB_RE = re.compile(r"\\begin\{verbatim\}(.*?)\\end\{verbatim\}", re.DOTALL)
_LST_RE = re.compile(r"\\begin\{lstlisting\}(?:\[[^\]]*\])?(.*?)\\end\{lstlisting\}", re.DOTALL)
_MINTED_RE = re.compile(
    r"\\begin\{minted\}(?:\[[^\]]*\])?\{([a-zA-Z0-9+_-]+)\}(.*?)\\end\{minted\}", re.DOTALL
)


def _parse_tex(text: str) -> ExtractedPaper:
    title = None
    m = _TITLE_RE.search(text)
    if m:
        title = re.sub(r"\s+", " ", m.group(1)).strip()

    sections = [re.sub(r"\s+", " ", s).strip() for s in _SECTION_RE.findall(text)]

    cite_keys: list[str] = []
    for match in _CITE_RE.findall(text):
        for key in match.split(","):
            key = key.strip()
            if key:
                cite_keys.append(key)

    code_blocks = []
    idx = 0
    for m in _VERB_RE.finditer(text):
        code_blocks.append({"block_id": idx, "language": "text", "code": m.group(1).strip()})
        idx += 1
    for m in _LST_RE.finditer(text):
        code_blocks.append({"block_id": idx, "language": "unknown", "code": m.group(1).strip()})
        idx += 1
    for m in _MINTED_RE.finditer(text):
        code_blocks.append({"block_id": idx, "language": m.group(1), "code": m.group(2).strip()})
        idx += 1

    return ExtractedPaper(
        full_text=text,
        title=title,
        code_blocks=code_blocks,
        citation_keys=sorted(set(cite_keys)),
        section_structure=sections,
    )


def _extract_pdf_text(pdf_path: Path) -> str:
    try:
        from kreuzberg import extract_file_sync  # type: ignore

        result = extract_file_sync(str(pdf_path))
        if isinstance(result, dict):
            return result.get("content") or result.get("text") or ""
        return getattr(result, "content", None) or getattr(result, "text", "") or ""
    except Exception:
        pass
    try:
        from pypdf import PdfReader

        reader = PdfReader(str(pdf_path))
        return "\n\n".join(page.extract_text() or "" for page in reader.pages)
    except Exception:
        return ""


async def extract_paper(
    source_dir: Path,
    main_tex: str | None,
    source_type: str,
) -> ExtractedPaper:
    source_dir = Path(source_dir)
    if main_tex and (source_dir / main_tex).exists():
        text = (source_dir / main_tex).read_text(encoding="utf-8", errors="replace")
        paper = _parse_tex(text)
        # Pull in .bib text for citation context.
        for bib in source_dir.rglob("*.bib"):
            paper.full_text += "\n\n% --- bib: " + bib.name + " ---\n" + bib.read_text(
                encoding="utf-8", errors="replace"
            )
        return paper

    # PDF path.
    for pdf in source_dir.rglob("*.pdf"):
        text = _extract_pdf_text(pdf)
        if text:
            title = None
            # Heuristic: first non-empty line under 200 chars.
            for line in text.splitlines():
                s = line.strip()
                if 5 < len(s) < 200:
                    title = s
                    break
            return ExtractedPaper(full_text=text, title=title)

    return ExtractedPaper(full_text="")
