"""Fetch arXiv source tarballs and normalize them into a job's source directory."""
from __future__ import annotations

import io
import re
import tarfile
from dataclasses import dataclass
from pathlib import Path

import httpx

from .latex import find_main_tex

ARXIV_SOURCE_URL = "https://arxiv.org/e-print/{arxiv_id}"
ARXIV_ABS_URL = "https://arxiv.org/abs/{arxiv_id}"
ARXIV_PDF_URL = "https://arxiv.org/pdf/{arxiv_id}"

_ARXIV_ID_RE = re.compile(r"(?:arxiv\.org/(?:abs|pdf)/)?(\d{4}\.\d{4,6})")


def normalize_arxiv_id(raw: str) -> str:
    m = _ARXIV_ID_RE.search(raw.strip())
    return m.group(1) if m else raw.strip()


@dataclass
class ArxivFetchResult:
    arxiv_id: str
    title: str | None
    main_tex_rel: str | None
    prebuilt_pdf_rel: str | None = None


async def fetch_arxiv_source(raw_id: str, dest_dir: Path) -> ArxivFetchResult:
    """Download arXiv source and extract into dest_dir.

    arXiv serves source as a gzipped tar (or a single .tex.gz, or PDF for older
    PDF-only submissions). We try tar-first, then fall back to saving the blob.
    """
    arxiv_id = normalize_arxiv_id(raw_id)
    dest_dir.mkdir(parents=True, exist_ok=True)

    async with httpx.AsyncClient(follow_redirects=True, timeout=60.0) as client:
        src_resp = await client.get(ARXIV_SOURCE_URL.format(arxiv_id=arxiv_id))
        src_resp.raise_for_status()
        content = src_resp.content

        title = None
        try:
            abs_resp = await client.get(ARXIV_ABS_URL.format(arxiv_id=arxiv_id))
            if abs_resp.status_code == 200:
                m = re.search(r'<meta name="citation_title" content="([^"]+)"', abs_resp.text)
                if m:
                    title = m.group(1).strip()
        except Exception:
            pass

    # Try to open as tar (gzipped).
    main_rel: str | None = None
    try:
        with tarfile.open(fileobj=io.BytesIO(content), mode="r:*") as tf:
            for member in tf.getmembers():
                if not member.isreg():
                    continue
                # Reject path traversal.
                safe_name = member.name.lstrip("./")
                if ".." in Path(safe_name).parts:
                    continue
                target = dest_dir / safe_name
                target.parent.mkdir(parents=True, exist_ok=True)
                extracted = tf.extractfile(member)
                if extracted is None:
                    continue
                target.write_bytes(extracted.read())
        main_rel = find_main_tex(dest_dir)
    except tarfile.TarError:
        # Single-file PDF or other; drop it as main.pdf / main.tex by signature.
        if content[:4] == b"%PDF":
            out = dest_dir / "main.pdf"
            out.write_bytes(content)
        else:
            out = dest_dir / "main.tex"
            try:
                out.write_text(content.decode("utf-8", errors="replace"))
                main_rel = "main.tex"
            except Exception:
                out.write_bytes(content)

    # Also download the canonical pre-built PDF from arXiv. Many papers use
    # exotic LaTeX packages (minted, tikz-network, custom .sty) that fail to
    # compile in a vanilla TeX Live sandbox without shell-escape, pygmentize,
    # etc. The pre-built PDF lets us show the paper immediately while still
    # having the source for patch-apply recompiles.
    prebuilt_pdf_rel: str | None = None
    try:
        async with httpx.AsyncClient(follow_redirects=True, timeout=60.0) as client:
            pdf_resp = await client.get(ARXIV_PDF_URL.format(arxiv_id=arxiv_id))
            if pdf_resp.status_code == 200 and pdf_resp.content[:4] == b"%PDF":
                pdf_path = dest_dir / f"_prebuilt_{arxiv_id}.pdf"
                pdf_path.write_bytes(pdf_resp.content)
                prebuilt_pdf_rel = pdf_path.name
    except Exception:
        pass

    return ArxivFetchResult(
        arxiv_id=arxiv_id,
        title=title,
        main_tex_rel=main_rel,
        prebuilt_pdf_rel=prebuilt_pdf_rel,
    )
