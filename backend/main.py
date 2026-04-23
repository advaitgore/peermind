"""PeerMind FastAPI entrypoint.

Responsibilities:
- Accept paper uploads (LaTeX source, zip, PDF, or arXiv ID).
- Persist job metadata in SQLite, store raw source under $JOB_STORAGE_PATH/{job_id}/.
- Kick off the Managed-Agents review pipeline in a background task.
- Expose an SSE stream that relays every orchestrator/reviewer event to the browser.
- Expose patch apply/reject endpoints that trigger `latexmk` recompile.
"""
from __future__ import annotations

import asyncio
import json
import uuid
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, StreamingResponse
from sqlalchemy import select
from sse_starlette.sse import EventSourceResponse

from .agents.chat_agent import stream_chat_response
from .agents.orchestrator import run_review_pipeline
from .agents.venue_detector import detect_venue
from .config import get_settings
from .event_bus import bus
from .models.database import ChatMessage, Job, Patch, get_sessionmaker, init_db
from .models.schemas import JobCreateResponse, ReviewEvent, StartJobRequest, StartJobResponse
from .utils.arxiv import fetch_arxiv_source
from .utils.extract import extract_paper
from .utils.latex import (
    apply_unified_diff,
    compile_latex,
    find_main_tex,
    read_source_file,
)

settings = get_settings()


@asynccontextmanager
async def lifespan(app: FastAPI):
    await init_db()
    settings.jobs_root.mkdir(parents=True, exist_ok=True)
    yield


app = FastAPI(title="PeerMind API", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


def _job_dir(job_id: str) -> Path:
    return settings.jobs_root / job_id


def _source_dir(job_id: str) -> Path:
    return _job_dir(job_id) / "source"


async def _get_job(job_id: str) -> Job:
    sm = get_sessionmaker()
    async with sm() as session:
        res = await session.execute(select(Job).where(Job.id == job_id))
        job = res.scalar_one_or_none()
    if not job:
        raise HTTPException(404, f"Job {job_id} not found")
    return job


# ---------- Job creation ----------


@app.post("/api/jobs/create", response_model=JobCreateResponse)
async def create_job(
    file: UploadFile | None = File(default=None),
    arxiv_id: str | None = Form(default=None),
    title: str | None = Form(default=None),
) -> JobCreateResponse:
    if not file and not arxiv_id:
        raise HTTPException(400, "Provide either a file upload or an arxiv_id")

    job_id = uuid.uuid4().hex[:12]
    src = _source_dir(job_id)
    src.mkdir(parents=True, exist_ok=True)

    source_type = "tex"
    resolved_title = title or "Untitled paper"
    main_tex_rel: str | None = None
    prebuilt_pdf_abs: str | None = None

    if arxiv_id:
        info = await fetch_arxiv_source(arxiv_id.strip(), src)
        source_type = "arxiv"
        main_tex_rel = info.main_tex_rel
        resolved_title = info.title or resolved_title
        if info.prebuilt_pdf_rel:
            prebuilt_pdf_abs = str(src / info.prebuilt_pdf_rel)
    else:
        assert file is not None
        name = file.filename or "upload.bin"
        target = src / name
        content = await file.read()
        with open(target, "wb") as f:
            f.write(content)
        lower = name.lower()
        if lower.endswith(".pdf"):
            source_type = "pdf"
        elif lower.endswith(".zip"):
            from zipfile import ZipFile
            with ZipFile(target) as zf:
                zf.extractall(src)
            target.unlink(missing_ok=True)
            source_type = "zip"
            main_tex_rel = find_main_tex(src)
        elif lower.endswith(".tex"):
            source_type = "tex"
            main_tex_rel = name
        else:
            source_type = "tex"
            main_tex_rel = name

    # Extract text + cache.
    extracted = await extract_paper(src, main_tex_rel, source_type=source_type)

    # Detect likely target venue (Haiku 4.5, ~1-2s). Best-effort; errors
    # fall back to arxiv so create_job never hangs on this.
    detected = await detect_venue(
        extracted.title or resolved_title,
        extracted.full_text,
    )

    sm = get_sessionmaker()
    async with sm() as session:
        job = Job(
            id=job_id,
            title=extracted.title or resolved_title,
            source_type=source_type,
            status="created",
            source_dir=str(src),
            main_tex=main_tex_rel,
            paper_text=extracted.full_text,
            paper_title=extracted.title,
            pdf_path=prebuilt_pdf_abs,
            detected_journal_id=detected.get("journal_id"),
            detected_display_name=detected.get("display_name"),
            detected_rationale=detected.get("rationale"),
            detected_confidence=detected.get("confidence"),
        )
        session.add(job)
        await session.commit()

    return JobCreateResponse(
        job_id=job_id,
        title=job.title,
        source_type=source_type,  # type: ignore[arg-type]
        has_source=main_tex_rel is not None,
        detected_venue={
            "journal_id": detected.get("journal_id", "arxiv"),
            "display_name": detected.get("display_name", "arXiv"),
            "rationale": detected.get("rationale", ""),
            "confidence": detected.get("confidence", 0.5),
        },  # type: ignore[arg-type]
    )


# ---------- Start pipeline ----------


@app.post("/api/jobs/{job_id}/start", response_model=StartJobResponse)
async def start_job(job_id: str, req: StartJobRequest) -> StartJobResponse:
    job = await _get_job(job_id)
    if job.status not in ("created", "errored"):
        raise HTTPException(409, f"Job {job_id} already in state {job.status}")

    sm = get_sessionmaker()
    async with sm() as session:
        j = await session.get(Job, job_id)
        assert j is not None
        j.status = "running"
        j.journal = req.journal
        await session.commit()

    # Kick off pipeline without awaiting.
    asyncio.create_task(
        run_review_pipeline(
            job_id=job_id,
            journal_id=req.journal,
            custom_venue_name=req.custom_venue_name,
        )
    )
    return StartJobResponse(job_id=job_id, status="started")


# ---------- SSE stream ----------


@app.get("/api/jobs/{job_id}/stream")
async def stream_job(job_id: str) -> EventSourceResponse:
    await _get_job(job_id)  # 404 if missing

    async def gen():
        async for ev in bus.subscribe(job_id):
            # Emit as a default "message" event so EventSource.onmessage fires.
            # The event_type is on the payload itself (ev.event_type).
            yield {"data": ev.model_dump_json()}

    return EventSourceResponse(gen(), ping=15)


# ---------- Static-ish job outputs ----------


@app.get("/api/jobs/{job_id}/output.pdf")
async def get_pdf(job_id: str) -> FileResponse:
    job = await _get_job(job_id)
    if not job.pdf_path or not Path(job.pdf_path).is_file():
        raise HTTPException(404, "PDF not compiled yet")
    return FileResponse(job.pdf_path, media_type="application/pdf")


@app.get("/api/jobs/{job_id}/source/{rel_path:path}")
async def get_source(job_id: str, rel_path: str) -> FileResponse:
    job = await _get_job(job_id)
    base = Path(job.source_dir).resolve()
    target = (base / rel_path).resolve()
    if base not in target.parents and base != target.parent:
        raise HTTPException(400, "Path traversal rejected")
    if not target.is_file():
        raise HTTPException(404, "Source file not found")
    return FileResponse(target, media_type="text/plain")


@app.get("/api/jobs/{job_id}/source-text")
async def get_source_text(job_id: str) -> JSONResponse:
    job = await _get_job(job_id)
    if not job.main_tex:
        return JSONResponse({"content": "", "available": False, "filename": None})
    path = Path(job.source_dir) / job.main_tex
    if not path.is_file():
        return JSONResponse({"content": "", "available": False, "filename": job.main_tex})
    content = read_source_file(path)
    return JSONResponse({"content": content, "available": True, "filename": job.main_tex})


# ---------- Patch apply / reject ----------


def _first_diff_line(diff: str) -> int | None:
    import re as _re
    m = _re.search(r"@@\s*-(\d+)", diff or "")
    return int(m.group(1)) if m else None


def _diff_line_count(diff: str) -> int:
    return sum(
        1
        for ln in (diff or "").splitlines()
        if (ln.startswith("+") and not ln.startswith("+++"))
        or (ln.startswith("-") and not ln.startswith("---"))
    )


async def _apply_patch_and_recompile(job_id: str, patch: Patch) -> dict[str, Any]:
    """Apply one patch with a narrated 4-step sub-timeline.

    Emits: patch_locating → patch_diffing → patch_compiling → patch_reloading
    plus the canonical compile_started/compile_success/patch_applied.
    """
    job = await _get_job(job_id)
    if not job.main_tex:
        return {"applied": False, "reason": "no_source"}

    tex_path = Path(job.source_dir) / job.main_tex

    # Step 1 — locating.
    await bus.publish(
        job_id,
        ReviewEvent(
            event_type="patch_locating",
            agent="fix_agent",
            data={
                "patch_id": patch.id,
                "file": job.main_tex,
                "line": _first_diff_line(patch.diff),
            },
        ),
    )
    await bus.publish(
        job_id,
        ReviewEvent(event_type="compile_started", agent="fix_agent", data={"patch_id": patch.id}),
    )

    # Step 2 — diffing.
    await bus.publish(
        job_id,
        ReviewEvent(
            event_type="patch_diffing",
            agent="fix_agent",
            data={"patch_id": patch.id, "lines_changed": _diff_line_count(patch.diff)},
        ),
    )
    result = apply_unified_diff(tex_path, patch.diff)
    if not result.applied:
        return {"applied": False, "reason": result.reason, "detail": result.log}

    # Step 3 — compiling.
    await bus.publish(
        job_id,
        ReviewEvent(event_type="patch_compiling", agent="fix_agent", data={"patch_id": patch.id}),
    )
    compiled = await compile_latex(Path(job.source_dir), main_tex=job.main_tex)
    if not compiled.success:
        result.rollback()
        await bus.publish(
            job_id,
            ReviewEvent(
                event_type="compile_error",
                agent="fix_agent",
                data={"patch_id": patch.id, "log": compiled.log[-4000:]},
            ),
        )
        return {"applied": False, "reason": "compile_failed", "log": compiled.log[-4000:]}

    # Step 4 — reloading the PDF.
    await bus.publish(
        job_id,
        ReviewEvent(
            event_type="patch_reloading",
            agent="fix_agent",
            data={"patch_id": patch.id, "elapsed_ms": compiled.elapsed_ms},
        ),
    )

    sm = get_sessionmaker()
    async with sm() as session:
        j = await session.get(Job, job_id)
        p = await session.get(Patch, patch.id)
        assert j is not None and p is not None
        j.pdf_path = str(compiled.pdf_path)
        p.status = "applied"
        await session.commit()

    await bus.publish(
        job_id,
        ReviewEvent(
            event_type="compile_success",
            agent="fix_agent",
            data={
                "patch_id": patch.id,
                "pdf_url": f"/api/jobs/{job_id}/output.pdf?v={patch.id}",
                "elapsed_ms": compiled.elapsed_ms,
            },
        ),
    )
    await bus.publish(
        job_id,
        ReviewEvent(event_type="patch_applied", agent="fix_agent", data={"patch_id": patch.id}),
    )
    return {"applied": True, "pdf_url": f"/api/jobs/{job_id}/output.pdf?v={patch.id}"}


@app.post("/api/jobs/{job_id}/patch/apply")
async def apply_patch(job_id: str, body: dict[str, str]) -> JSONResponse:
    patch_id = body.get("patch_id")
    if not patch_id:
        raise HTTPException(400, "patch_id required")
    sm = get_sessionmaker()
    async with sm() as session:
        patch = await session.get(Patch, patch_id)
    if not patch or patch.job_id != job_id:
        raise HTTPException(404, "Patch not found")
    if patch.status != "pending":
        raise HTTPException(409, f"Patch already {patch.status}")
    return JSONResponse(await _apply_patch_and_recompile(job_id, patch))


@app.post("/api/jobs/{job_id}/patch/reject")
async def reject_patch(job_id: str, body: dict[str, str]) -> JSONResponse:
    patch_id = body.get("patch_id")
    if not patch_id:
        raise HTTPException(400, "patch_id required")
    sm = get_sessionmaker()
    async with sm() as session:
        patch = await session.get(Patch, patch_id)
        if not patch or patch.job_id != job_id:
            raise HTTPException(404, "Patch not found")
        patch.status = "rejected"
        await session.commit()
    await bus.publish(
        job_id,
        ReviewEvent(event_type="patch_rejected", agent="fix_agent", data={"patch_id": patch_id}),
    )
    return JSONResponse({"rejected": True})


@app.post("/api/jobs/{job_id}/patch/adhoc-apply")
async def adhoc_apply(job_id: str, body: dict[str, Any]) -> JSONResponse:
    """Apply a one-off patch that wasn't part of the auto_apply_patches queue.

    Used by the ActionPlan 'Fix now' flow: when an author-required item
    carries a ``fix_hint`` diff, the frontend POSTs it here. We persist it
    as a new Patch row (so it's tracked in export-review), run the full
    narrated apply+recompile cycle, and emit the same events a queued patch
    would.
    """
    await _get_job(job_id)
    diff = (body.get("diff") or "").strip()
    description = (body.get("description") or "ad-hoc fix")[:500]
    category = body.get("category", "phrasing")
    source_action_id = body.get("source_action_id")
    if not diff:
        raise HTTPException(400, "diff required")
    patch_id = "ah_" + uuid.uuid4().hex[:8]
    sm = get_sessionmaker()
    async with sm() as session:
        session.add(
            Patch(
                id=patch_id,
                job_id=job_id,
                category=category,
                description=description,
                diff=diff,
                status="pending",
            )
        )
        await session.commit()
        patch = await session.get(Patch, patch_id)
    assert patch is not None
    # Let the UI know this patch exists so ReviewerStream / PatchQueue can pick it up.
    await bus.publish(
        job_id,
        ReviewEvent(
            event_type="patch_ready",
            agent="fix_agent",
            data={
                "patch_id": patch_id,
                "description": description,
                "category": category,
                "diff": diff,
                "source_action_id": source_action_id,
            },
        ),
    )
    result = await _apply_patch_and_recompile(job_id, patch)
    return JSONResponse({"patch_id": patch_id, **result})


@app.post("/api/jobs/{job_id}/patch/apply-all")
async def apply_all_patches(job_id: str) -> JSONResponse:
    sm = get_sessionmaker()
    async with sm() as session:
        patches = (
            await session.execute(select(Patch).where(Patch.job_id == job_id, Patch.status == "pending"))
        ).scalars().all()
    applied = []
    for p in patches:
        result = await _apply_patch_and_recompile(job_id, p)
        applied.append({"patch_id": p.id, **result})
    return JSONResponse({"results": applied})


# ---------- Verdict / action plan ----------


@app.get("/api/jobs/{job_id}/verdict")
async def get_verdict(job_id: str) -> JSONResponse:
    job = await _get_job(job_id)
    if not job.verdict_json:
        raise HTTPException(404, "Verdict not ready")
    return JSONResponse(job.verdict_json)


@app.get("/api/jobs/{job_id}/action-plan")
async def get_action_plan(job_id: str) -> JSONResponse:
    job = await _get_job(job_id)
    if not job.action_plan_json:
        raise HTTPException(404, "Action plan not ready")
    return JSONResponse(job.action_plan_json)


# ---------- Chat ----------


@app.get("/api/jobs/{job_id}/chat/messages")
async def list_chat_messages(job_id: str) -> JSONResponse:
    await _get_job(job_id)
    sm = get_sessionmaker()
    async with sm() as session:
        rows = (
            await session.execute(
                select(ChatMessage)
                .where(ChatMessage.job_id == job_id)
                .order_by(ChatMessage.created_at.asc())
            )
        ).scalars().all()
    return JSONResponse(
        {
            "messages": [
                {
                    "id": m.id,
                    "role": m.role,
                    "content": m.content,
                    "created_at": m.created_at.isoformat(),
                }
                for m in rows
            ]
        }
    )


@app.post("/api/jobs/{job_id}/chat")
async def chat(job_id: str, body: dict[str, Any]) -> EventSourceResponse:
    """Stream a chat turn from Opus 4.7. Body: {"message": str}."""
    await _get_job(job_id)
    user_message = (body.get("message") or "").strip()
    if not user_message:
        raise HTTPException(400, "message required")

    # Load history, persist the user turn immediately.
    sm = get_sessionmaker()
    async with sm() as session:
        history_rows = (
            await session.execute(
                select(ChatMessage)
                .where(ChatMessage.job_id == job_id)
                .order_by(ChatMessage.created_at.asc())
            )
        ).scalars().all()
        user_msg_id = uuid.uuid4().hex[:16]
        session.add(
            ChatMessage(
                id=user_msg_id,
                job_id=job_id,
                role="user",
                content=user_message,
            )
        )
        await session.commit()

    history = [{"role": m.role, "content": m.content} for m in history_rows]

    async def gen():
        parts: list[str] = []
        yield {"data": json.dumps({"type": "user_saved", "id": user_msg_id})}
        try:
            async for chunk in stream_chat_response(job_id, history, user_message):
                parts.append(chunk)
                yield {"data": json.dumps({"type": "delta", "text": chunk})}
        except Exception as e:
            yield {"data": json.dumps({"type": "error", "detail": f"{type(e).__name__}: {e}"})}
            return
        # Persist the completed assistant turn.
        assistant_id = uuid.uuid4().hex[:16]
        full = "".join(parts)
        sm2 = get_sessionmaker()
        async with sm2() as session:
            session.add(
                ChatMessage(
                    id=assistant_id,
                    job_id=job_id,
                    role="assistant",
                    content=full,
                )
            )
            await session.commit()
        yield {"data": json.dumps({"type": "done", "id": assistant_id})}

    return EventSourceResponse(gen(), ping=15)


# File patterns to exclude from the exported zip. Snapshot backups from the
# patch apply flow + transient latexmk artefacts. We keep .tex, .bib, .sty,
# .cls, figure files, and the final PDF.
_EXCLUDE_SUFFIXES = {
    ".aux",
    ".log",
    ".fls",
    ".fdb_latexmk",
    ".out",
    ".blg",
    ".synctex.gz",
    ".pyg",
    ".pygtex",
    ".pygstyle",
    ".chktex",
    ".pdfxref",
    ".peermind-bak",
}


def _is_excluded(path: Path) -> bool:
    name = path.name
    # Explicit excludes
    if name.startswith("_prebuilt_") and name.endswith(".pdf"):
        return True
    # Extension-based
    for suf in _EXCLUDE_SUFFIXES:
        if name.endswith(suf):
            return True
    return False


def _build_report_md(job: Job, patches: list[Patch]) -> str:
    v = job.verdict_json or {}
    ap = job.action_plan_json or {}
    venue = (job.journal or "—").upper()
    created = (
        job.created_at.isoformat(timespec="minutes")
        if getattr(job, "created_at", None)
        else ""
    )
    applied = [p for p in patches if p.status == "applied"]
    pending = [p for p in patches if p.status == "pending"]
    rejected = [p for p in patches if p.status == "rejected"]

    def _rec(s: Any) -> str:
        return (s or "—").replace("_", " ").title()

    rr = v.get("reviewer_recommendations") or {}
    ci = v.get("consensus_issues") or []

    def _sev_heading(s: str) -> str:
        return {"critical": "🔴 Critical", "major": "🟡 Major", "minor": "⚪ Minor"}.get(
            s, s.title()
        )

    ar = ap.get("author_required") or []
    ar_by_sev: dict[str, list[dict[str, Any]]] = {"critical": [], "major": [], "minor": []}
    for a in ar:
        ar_by_sev.setdefault(a.get("severity", "minor"), []).append(a)

    lines: list[str] = []
    lines.append(f"# PeerMind Review Report")
    lines.append("")
    lines.append(f"**Paper:** {job.paper_title or job.title or 'Untitled'}")
    lines.append(f"**Target venue:** {venue}")
    lines.append(f"**Review date:** {created}")
    lines.append("")
    lines.append("---")
    lines.append("")
    lines.append("## Verdict")
    lines.append("")
    lines.append(f"**{_rec(v.get('recommendation'))}** — confidence {int(float(v.get('confidence') or 0) * 100)}%")
    lines.append("")
    if v.get("one_line_verdict"):
        lines.append(f"> {v.get('one_line_verdict')}")
        lines.append("")
    if rr:
        lines.append(f"- **Reviewer 1:** {_rec(rr.get('skeptic'))}")
        lines.append(f"- **Reviewer 2:** {_rec(rr.get('champion'))}")
        lines.append("")
    if ci:
        lines.append("### Consensus issues")
        for c in ci:
            sev = c.get("severity", "minor")
            lines.append(f"- **[{sev}]** {c.get('issue', '')}")
        lines.append("")
    lines.append("---")
    lines.append("")
    lines.append("## Patches applied to this project")
    lines.append("")
    if applied:
        for p in applied:
            lines.append(f"- [x] **{p.description}** — `{p.category}`")
    else:
        lines.append("_No patches applied. The source in this zip matches your upload._")
    lines.append("")
    if rejected:
        lines.append("### Rejected")
        for p in rejected:
            lines.append(f"- [ ] ~~{p.description}~~ — `{p.category}` (rejected)")
        lines.append("")
    if pending:
        lines.append("### Still pending (not applied)")
        for p in pending:
            lines.append(f"- [ ] {p.description} — `{p.category}`")
        lines.append("")
    lines.append("---")
    lines.append("")
    lines.append("## Author-required revisions")
    lines.append("")
    if not ar:
        lines.append("_None._")
    else:
        for sev in ("critical", "major", "minor"):
            items = ar_by_sev.get(sev) or []
            if not items:
                continue
            lines.append(f"### {_sev_heading(sev)} · {len(items)} item{'s' if len(items) != 1 else ''}")
            lines.append("")
            for item in items:
                lines.append(
                    f"**{item.get('title', '')}**"
                    + (f" — _p.{item.get('page_hint')}_" if item.get("page_hint") else "")
                )
                if item.get("affected_claim"):
                    lines.append(f"- *Claim:* {item['affected_claim']}")
                if item.get("evidence"):
                    lines.append(f"- *Evidence:* {item['evidence']}")
                if item.get("suggested_action"):
                    lines.append(f"- *Do:* {item['suggested_action']}")
                if item.get("estimated_effort"):
                    lines.append(f"- *Effort:* {item['estimated_effort']}")
                lines.append("")
    lines.append("---")
    lines.append("")
    lines.append(
        "_Generated by PeerMind · Opus 4.7 orchestrator + reviewers, Haiku 4.5 venue classifier, Sonnet 4.5 scout + code runner, Fix Agent patches._"
    )
    lines.append("")
    return "\n".join(lines)


@app.get("/api/jobs/{job_id}/export.zip")
async def export_project_zip(job_id: str) -> StreamingResponse:
    """Stream the job's source directory (with applied patches) + a review
    report as a single zip. Users drop this into Overleaf as a new project
    (Menu → New Project → Upload Project)."""
    import io
    import zipfile

    job = await _get_job(job_id)
    source_dir = Path(job.source_dir)
    if not source_dir.is_dir():
        raise HTTPException(404, "Source directory missing on disk")

    sm = get_sessionmaker()
    async with sm() as session:
        patches = (
            await session.execute(select(Patch).where(Patch.job_id == job_id))
        ).scalars().all()

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        # 1. Source tree
        for path in source_dir.rglob("*"):
            if not path.is_file():
                continue
            if _is_excluded(path):
                continue
            arcname = str(path.relative_to(source_dir)).replace("\\", "/")
            zf.write(path, arcname=arcname)

        # 2. Latest compiled PDF (if any) at the root
        if job.pdf_path:
            pdf_path = Path(job.pdf_path)
            if pdf_path.is_file() and not pdf_path.name.startswith("_prebuilt_"):
                zf.write(pdf_path, arcname=pdf_path.name)

        # 3. The human-readable report
        zf.writestr("PEERMIND_REPORT.md", _build_report_md(job, list(patches)))

    buf.seek(0)
    filename = f"peermind-{job_id}.zip"
    return StreamingResponse(
        iter([buf.getvalue()]),
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@app.get("/api/jobs/{job_id}/review-letter", response_class=HTMLResponse)
async def review_letter(job_id: str) -> HTMLResponse:
    """Render the full review as a printable HTML letter.

    User can Ctrl+P → Save as PDF to get a proper review letter they can
    drop into a submission response. Styled to mimic the format real
    journal reviews are delivered in.
    """
    job = await _get_job(job_id)
    verdict = job.verdict_json or {}
    action_plan = job.action_plan_json or {}

    # Pull all rounds' reviews from the DB via event history is lossy; we
    # rely on verdict + action_plan + patch list here.
    sm = get_sessionmaker()
    async with sm() as session:
        patches = (
            await session.execute(select(Patch).where(Patch.job_id == job_id))
        ).scalars().all()

    paper_title = (job.paper_title or job.title or "Untitled paper").strip()
    venue = (job.journal or "").upper() or "—"

    def _esc(s: Any) -> str:
        import html

        return html.escape(str(s or ""))

    def _sev_color(s: str) -> str:
        return {"critical": "#b8432c", "major": "#b07a14", "minor": "#6a685f"}.get(s, "#6a685f")

    def _render_weaknesses(reviewer_key: str) -> str:
        # We don't persist per-round reviews in the current schema; fall back
        # to consensus_issues which are in the verdict.
        return ""

    consensus = verdict.get("consensus_issues") or []
    disagreements = verdict.get("disagreements_arbitrated") or []
    scores = verdict.get("scores_synthesis") or {}

    author_required = action_plan.get("author_required") or []
    applied_patches = [p for p in patches if p.status == "applied"]
    pending_patches = [p for p in patches if p.status == "pending"]

    def _pretty_rec(s: str) -> str:
        return s.replace("_", " ").title()

    consensus_html = "\n".join(
        f'<li><span class="sev" style="color:{_sev_color(ci.get("severity","minor"))}">'
        f'{_esc(ci.get("severity","minor")).upper()}</span> {_esc(ci.get("issue"))}</li>'
        for ci in consensus
    )
    disagreements_html = "\n".join(
        f"""<li>
          <strong>{_esc(d.get("topic"))}</strong><br/>
          <span class="reviewer-tag r1">Reviewer 1:</span> {_esc(d.get("skeptic_view"))}<br/>
          <span class="reviewer-tag r2">Reviewer 2:</span> {_esc(d.get("champion_view"))}<br/>
          <em>Resolved:</em> {_esc(d.get("resolution"))}
        </li>"""
        for d in disagreements
    )
    author_required_html = "\n".join(
        f"""<li>
          <strong style="color:{_sev_color(a.get("severity","minor"))}">[{_esc(a.get("severity","minor")).upper()}]</strong>
          {_esc(a.get("title"))}
          <div class="detail"><em>Affected claim:</em> {_esc(a.get("affected_claim"))}</div>
          <div class="detail"><em>Evidence:</em> {_esc(a.get("evidence"))}</div>
          <div class="detail"><em>Suggested action:</em> {_esc(a.get("suggested_action"))}</div>
          <div class="detail"><em>Estimated effort:</em> {_esc(a.get("estimated_effort","—"))}</div>
        </li>"""
        for a in author_required
    )
    applied_patches_html = "\n".join(
        f"<li>{_esc(p.description)} <span class='muted'>({_esc(p.category)})</span></li>"
        for p in applied_patches
    )
    pending_patches_html = "\n".join(
        f"<li>{_esc(p.description)} <span class='muted'>({_esc(p.category)})</span></li>"
        for p in pending_patches
    )
    scores_html = (
        "<table class='scores'><thead><tr><th>Criterion</th><th>Score</th></tr></thead><tbody>"
        + "".join(
            f"<tr><td>{_esc(k)}</td><td>{_esc(v)}</td></tr>"
            for k, v in (scores.items() if isinstance(scores, dict) else [])
        )
        + "</tbody></table>"
        if scores
        else ""
    )

    html_doc = f"""<!doctype html>
<html lang="en"><head>
<meta charset="utf-8" />
<title>Peer Review — {_esc(paper_title)}</title>
<style>
  :root {{
    --fg: #1a1917; --dim: #4a4944; --faint: #8a8982;
    --border: rgba(0,0,0,0.12); --accent: #01696f;
    --paper: #fbfbf9;
  }}
  * {{ box-sizing: border-box; }}
  html, body {{ margin: 0; padding: 0; background: #f3f1ec; color: var(--fg);
    font-family: 'Georgia','Times New Roman',serif; line-height: 1.55; }}
  .letter {{ max-width: 780px; margin: 40px auto; background: var(--paper);
    padding: 56px 72px; border: 1px solid var(--border); box-shadow: 0 1px 8px rgba(0,0,0,0.04); }}
  h1 {{ font-size: 18px; letter-spacing: 0.18em; text-transform: uppercase; margin: 0 0 6px;
    font-weight: 600; color: var(--dim); }}
  h2 {{ font-size: 15px; margin: 24px 0 8px; letter-spacing: 0.06em; text-transform: uppercase;
    color: var(--dim); font-weight: 600; border-bottom: 1px solid var(--border); padding-bottom: 4px; }}
  h3 {{ font-size: 14px; margin: 16px 0 6px; color: var(--fg); }}
  .meta {{ font-size: 13px; color: var(--dim); margin-bottom: 24px; }}
  .verdict {{ display: flex; gap: 32px; align-items: baseline; margin: 8px 0 20px; }}
  .verdict .rec {{ font-size: 22px; font-weight: 600; color: var(--accent); }}
  .verdict .conf {{ font-size: 12px; color: var(--faint); font-family: ui-monospace, monospace; }}
  .one-liner {{ font-size: 15px; font-style: italic; color: var(--dim); margin: 4px 0 20px; }}
  ul {{ padding-left: 22px; margin: 8px 0; }}
  li {{ margin-bottom: 8px; }}
  .sev {{ font-family: ui-monospace, monospace; font-size: 10.5px; letter-spacing: 0.05em; margin-right: 6px; font-weight: 700; }}
  .detail {{ font-size: 13px; color: var(--dim); margin-top: 2px; margin-left: 12px; }}
  .reviewer-tag {{ font-family: ui-monospace, monospace; font-size: 11px; font-weight: 600; margin-right: 4px; }}
  .reviewer-tag.r1 {{ color: #c0392b; }}
  .reviewer-tag.r2 {{ color: #27ae60; }}
  .muted {{ color: var(--faint); font-size: 12px; }}
  table.scores {{ border-collapse: collapse; margin: 8px 0 16px; font-size: 13px; }}
  table.scores th, table.scores td {{ border: 1px solid var(--border); padding: 4px 12px; text-align: left; }}
  .footer {{ margin-top: 36px; border-top: 1px solid var(--border); padding-top: 12px; font-size: 11px;
    color: var(--faint); text-align: center; font-family: ui-monospace, monospace; letter-spacing: 0.08em; text-transform: uppercase; }}
  @media print {{
    body {{ background: white; }}
    .letter {{ box-shadow: none; border: none; margin: 0; padding: 40px 56px; }}
  }}
  .print-btn {{ position: fixed; top: 16px; right: 16px; background: var(--accent); color: white;
    border: none; padding: 8px 14px; border-radius: 4px; font-family: ui-monospace, monospace;
    font-size: 11px; letter-spacing: 0.1em; text-transform: uppercase; cursor: pointer; }}
  @media print {{ .print-btn {{ display: none; }} }}
</style>
</head>
<body>
<button class="print-btn" onclick="window.print()">Save as PDF</button>
<div class="letter">

<h1>Peer Review Letter</h1>
<div class="meta">
  <strong>Paper:</strong> {_esc(paper_title)}<br/>
  <strong>Target venue:</strong> {_esc(venue)}<br/>
  <strong>Generated by:</strong> PeerMind — adversarial multi-agent peer review
</div>

<h2>Recommendation</h2>
<div class="verdict">
  <span class="rec">{_esc(_pretty_rec(verdict.get("recommendation","—")))}</span>
  <span class="conf">Confidence {int(float(verdict.get("confidence") or 0) * 100)}%</span>
</div>
{f'<div class="one-liner">{_esc(verdict.get("one_line_verdict",""))}</div>' if verdict.get("one_line_verdict") else ''}
{f'<div class="detail"><em>Reviewer 1 recommendation:</em> {_esc(_pretty_rec(verdict.get("reviewer_recommendations",{}).get("skeptic","—")))} · <em>Reviewer 2:</em> {_esc(_pretty_rec(verdict.get("reviewer_recommendations",{}).get("champion","—")))}</div>' if verdict.get("reviewer_recommendations") else ''}

{('<h2>Consensus Issues</h2><ul>' + consensus_html + '</ul>') if consensus_html else ''}

{('<h2>Disagreements Arbitrated</h2><ul>' + disagreements_html + '</ul>') if disagreements_html else ''}

{'<h2>Synthesized Scores</h2>' + scores_html if scores_html else ''}

{('<h2>Action Plan — Author Required</h2><ul>' + author_required_html + '</ul>') if author_required_html else ''}

{('<h2>Minor Revisions Applied (by Fix Agent)</h2><ul>' + applied_patches_html + '</ul>') if applied_patches_html else ''}

{('<h2>Minor Revisions Queued (Pending Author Approval)</h2><ul>' + pending_patches_html + '</ul>') if pending_patches_html else ''}

<div class="footer">
  Generated by PeerMind · 6 Managed Agents · Claude Opus 4.7 · Sonnet 4.5
</div>

</div>
</body></html>"""
    return HTMLResponse(content=html_doc)


@app.get("/api/journals")
async def list_journals() -> JSONResponse:
    path = Path(__file__).parent / "journal_profiles" / "profiles.json"
    return JSONResponse(json.loads(path.read_text()))


@app.get("/api/health")
async def health() -> dict[str, Any]:
    return {"ok": True, "service": "peermind"}
