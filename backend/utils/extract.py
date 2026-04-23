"""Paper-text extraction: LaTeX source (preferred) or PDF via kreuzberg/pypdf fallback.

Returns the full text, any detected title, code blocks extracted from
``verbatim``/``lstlisting`` environments, and citation keys.

For LaTeX sources we recursively resolve ``\\input{...}`` and ``\\include{...}``
so reviewers see the actual paper body, not a skeleton of include directives.
arXiv papers virtually always split sections into files under ``sections/`` and
appendices under ``sections/appendix/``; the skeleton alone is useless context.
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

# Seed-claim extraction — pick sentences from the abstract that look like
# numeric/empirical claims the Literature Scout can start hunting for before
# the reviewers finish producing claim-targeted queries.
_ABSTRACT_RE = re.compile(
    r"\\begin\{abstract\}(.*?)\\end\{abstract\}|Abstract[:\.\s]+(.{80,2000}?)(?:\n\s*\n|\\section)",
    re.DOTALL | re.IGNORECASE,
)
_SENTENCE_RE = re.compile(r"(?<=[\.\!\?])\s+(?=[A-Z])")
_CLAIM_HINTS = re.compile(
    r"(\d{1,3}(?:\.\d+)?\s*%|"  # percentages
    r"\boutperform\w*\b|\bimprov\w+\b|\bachieve\w*\b|\bbaseline\b|"
    r"\bablation\b|\bzero-shot\b|\bfew-shot\b|\bstate[- ]of[- ]the[- ]art\b|\bSOTA\b|"
    r"\bexceed\w*\b|\bsurpass\w*\b|\bbeat\w*\b)",
    re.IGNORECASE,
)


def extract_seed_claims(paper_text: str, limit: int = 4) -> list[str]:
    """Heuristically pick 3-4 claim-like sentences from the abstract.

    Strips LaTeX macros for display; keeps concrete numeric claims and
    empirical comparisons — exactly what the scout should try to verify.
    """
    if not paper_text:
        return []
    m = _ABSTRACT_RE.search(paper_text)
    abstract = (m.group(1) or m.group(2) or "") if m else paper_text[:2500]
    # Defang LaTeX for sentence splitting.
    plain = _MACRO_WITH_ARG.sub(lambda m: m.group(1), abstract)
    plain = _MACRO_NO_ARG.sub("", plain).replace("{", "").replace("}", "")
    plain = re.sub(r"\s+", " ", plain).strip()
    sentences = [s.strip() for s in _SENTENCE_RE.split(plain) if len(s.strip()) > 40]
    scored: list[tuple[int, str]] = []
    for s in sentences:
        hits = len(_CLAIM_HINTS.findall(s))
        if hits > 0:
            scored.append((hits, s))
    scored.sort(key=lambda x: (-x[0], len(x[1])))
    out = [s for _, s in scored[:limit]]
    # Fallback: if no claim-hinted sentences, just take the first 2 sentences.
    if not out and sentences:
        out = sentences[:2]
    return out
_INPUT_RE = re.compile(r"\\(?:input|include)\{([^}]+)\}")


def _resolve_inputs(
    text: str,
    base_dir: Path,
    seen: set[Path] | None = None,
    depth: int = 0,
) -> str:
    """Inline every ``\\input{...}`` / ``\\include{...}`` file into ``text``.

    Recursive, cycle-safe via ``seen``. Depth-capped at 8 to bound pathological
    projects. Missing files become a ``% missing: <name>`` comment so the
    output is still a valid tex-ish string.
    """
    if depth > 8:
        return text
    if seen is None:
        seen = set()

    def _resolve(match: re.Match[str]) -> str:
        rel = match.group(1).strip()
        # LaTeX accepts the target with or without .tex
        candidates = [rel, f"{rel}.tex"]
        for cand in candidates:
            path = (base_dir / cand).resolve()
            try:
                path.relative_to(base_dir.resolve())
            except ValueError:
                # Path escapes base_dir — ignore, treat as missing.
                continue
            if path in seen:
                return f"% peermind: cyclic input skipped ({rel})"
            if path.is_file():
                seen.add(path)
                try:
                    sub = path.read_text(encoding="utf-8", errors="replace")
                except Exception as e:
                    return f"% peermind: read failed for {rel}: {e}"
                return _resolve_inputs(sub, base_dir, seen, depth + 1)
        return f"% peermind: missing {rel}"

    return _INPUT_RE.sub(_resolve, text)

# Strip LaTeX macros for display. ``\cmd{arg}`` keeps ``arg``; ``\cmd`` alone
# drops the command; ``\\`` becomes a space (line break in a title).
_MACRO_WITH_ARG = re.compile(r"\\[a-zA-Z]+\*?\s*\{([^{}]*)\}")
_MACRO_NO_ARG = re.compile(r"\\[a-zA-Z]+\*?")


def _clean_latex_title(raw: str) -> str:
    text = raw.replace("\\\\", " ")
    # Apply macro-with-arg repeatedly to handle nested braces.
    for _ in range(4):
        new = _MACRO_WITH_ARG.sub(lambda m: m.group(1), text)
        if new == text:
            break
        text = new
    text = _MACRO_NO_ARG.sub("", text)
    text = text.replace("{", "").replace("}", "")
    text = re.sub(r"\s+", " ", text).strip().strip(":;,")
    return text
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
        title = _clean_latex_title(m.group(1))

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
        raw = (source_dir / main_tex).read_text(encoding="utf-8", errors="replace")
        # Inline every \input/\include so reviewers see the body, not a shell.
        main_path = (source_dir / main_tex).resolve()
        resolved = _resolve_inputs(raw, source_dir, seen={main_path})
        paper = _parse_tex(resolved)
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
