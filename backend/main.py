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
from fastapi.responses import FileResponse, JSONResponse
from sqlalchemy import select
from sse_starlette.sse import EventSourceResponse

from .agents.orchestrator import run_review_pipeline
from .config import get_settings
from .event_bus import bus
from .models.database import Job, Patch, get_sessionmaker, init_db
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

    if arxiv_id:
        info = await fetch_arxiv_source(arxiv_id.strip(), src)
        source_type = "arxiv"
        main_tex_rel = info.main_tex_rel
        resolved_title = info.title or resolved_title
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
        )
        session.add(job)
        await session.commit()

    return JobCreateResponse(
        job_id=job_id,
        title=job.title,
        source_type=source_type,  # type: ignore[arg-type]
        has_source=main_tex_rel is not None,
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
    asyncio.create_task(run_review_pipeline(job_id=job_id, journal_id=req.journal))
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


async def _apply_patch_and_recompile(job_id: str, patch: Patch) -> dict[str, Any]:
    job = await _get_job(job_id)
    if not job.main_tex:
        return {"applied": False, "reason": "no_source"}

    tex_path = Path(job.source_dir) / job.main_tex
    await bus.publish(
        job_id,
        ReviewEvent(
            event_type="compile_started",
            agent="fix_agent",
            data={"patch_id": patch.id},
        ),
    )
    result = apply_unified_diff(tex_path, patch.diff)
    if not result.applied:
        return {"applied": False, "reason": result.reason, "detail": result.log}

    compiled = await compile_latex(Path(job.source_dir), main_tex=job.main_tex)
    if not compiled.success:
        # Rollback: restore snapshot.
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


@app.get("/api/journals")
async def list_journals() -> JSONResponse:
    path = Path(__file__).parent / "journal_profiles" / "profiles.json"
    return JSONResponse(json.loads(path.read_text()))


@app.get("/api/health")
async def health() -> dict[str, Any]:
    return {"ok": True, "service": "peermind"}
