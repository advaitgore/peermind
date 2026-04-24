"""Async SQLAlchemy models and session management for PeerMind jobs."""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from sqlalchemy import JSON, DateTime, ForeignKey, String, Text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship

from ..config import get_settings


class Base(DeclarativeBase):
    pass


class Job(Base):
    __tablename__ = "jobs"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    title: Mapped[str] = mapped_column(String(512), default="Untitled paper")
    journal: Mapped[str | None] = mapped_column(String(32), default=None)
    source_type: Mapped[str] = mapped_column(String(16))  # tex | zip | pdf | arxiv
    status: Mapped[str] = mapped_column(String(32), default="created")
    # Filesystem paths relative to jobs_root:
    source_dir: Mapped[str] = mapped_column(String(512))
    main_tex: Mapped[str | None] = mapped_column(String(512), default=None)
    pdf_path: Mapped[str | None] = mapped_column(String(512), default=None)
    # Persisted results:
    verdict_json: Mapped[dict[str, Any] | None] = mapped_column(JSON, default=None)
    action_plan_json: Mapped[dict[str, Any] | None] = mapped_column(JSON, default=None)
    # Cached extraction:
    paper_text: Mapped[str | None] = mapped_column(Text, default=None)
    paper_title: Mapped[str | None] = mapped_column(String(512), default=None)

    # Auto-detected venue suggestion (Haiku 4.5 classifier at upload time).
    # Used to pre-fill the landing page's venue selector. User can override.
    detected_journal_id: Mapped[str | None] = mapped_column(String(32), default=None)
    detected_display_name: Mapped[str | None] = mapped_column(String(120), default=None)
    detected_rationale: Mapped[str | None] = mapped_column(String(600), default=None)
    detected_confidence: Mapped[float | None] = mapped_column(default=None)

    # Cached Rebuttal Co-Pilot output — latest draft the user generated.
    # Persisted so the panel survives reloads and the /rebuttal-letter
    # export endpoint can produce a printable version without re-running
    # the agent.
    rebuttal_text: Mapped[str | None] = mapped_column(Text, default=None)

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
    )

    patches: Mapped[list["Patch"]] = relationship(back_populates="job", cascade="all, delete-orphan")


class Patch(Base):
    __tablename__ = "patches"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    job_id: Mapped[str] = mapped_column(ForeignKey("jobs.id"))
    category: Mapped[str] = mapped_column(String(32))  # citation|typo|notation|caption|phrasing
    description: Mapped[str] = mapped_column(String(512))
    diff: Mapped[str] = mapped_column(Text)
    status: Mapped[str] = mapped_column(String(32), default="pending")
    # pending | applied | rejected | requires_manual_review
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )

    job: Mapped[Job] = relationship(back_populates="patches")


class ChatMessage(Base):
    """One message in the per-job chat thread. Persisted so the conversation
    survives reloads."""
    __tablename__ = "chat_messages"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    job_id: Mapped[str] = mapped_column(ForeignKey("jobs.id"), index=True)
    role: Mapped[str] = mapped_column(String(16))  # user | assistant
    content: Mapped[str] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc), index=True
    )


_engine = None
_sessionmaker: async_sessionmaker[AsyncSession] | None = None


def get_engine():
    global _engine, _sessionmaker
    if _engine is None:
        settings = get_settings()
        _engine = create_async_engine(settings.database_url, echo=False, future=True)
        _sessionmaker = async_sessionmaker(_engine, expire_on_commit=False)
    return _engine


def get_sessionmaker() -> async_sessionmaker[AsyncSession]:
    get_engine()
    assert _sessionmaker is not None
    return _sessionmaker


async def _has_column(conn, table: str, column: str) -> bool:
    rows = await conn.exec_driver_sql(f"PRAGMA table_info({table})")
    for row in rows.fetchall():
        if row[1] == column:
            return True
    return False


async def init_db() -> None:
    engine = get_engine()
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
        # Lightweight idempotent migration for columns added after the
        # initial schema was created. SQLAlchemy's create_all won't add
        # columns to an existing table, and we'd rather not ask users to
        # drop their local DB every time we extend Job.
        if not await _has_column(conn, "jobs", "rebuttal_text"):
            await conn.exec_driver_sql("ALTER TABLE jobs ADD COLUMN rebuttal_text TEXT")
