"""Runtime configuration loaded from environment."""
from __future__ import annotations

import os
from functools import lru_cache
from pathlib import Path

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    anthropic_api_key: str = Field("", alias="ANTHROPIC_API_KEY")
    semantic_scholar_api_key: str = Field("", alias="SEMANTIC_SCHOLAR_API_KEY")

    latex_compile_timeout: int = Field(60, alias="LATEX_COMPILE_TIMEOUT")
    max_review_rounds: int = Field(3, alias="MAX_REVIEW_ROUNDS")
    critique_delta_threshold: float = Field(0.15, alias="CRITIQUE_DELTA_THRESHOLD")

    job_storage_path: str = Field("/tmp/peermind_jobs", alias="JOB_STORAGE_PATH")
    database_url: str = Field("sqlite+aiosqlite:///./peermind.db", alias="DATABASE_URL")

    managed_agents_multiagent_enabled: bool = Field(False, alias="MANAGED_AGENTS_MULTIAGENT_ENABLED")

    latex_docker_image: str = Field("peermind-latex:local", alias="LATEX_DOCKER_IMAGE")

    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    @property
    def jobs_root(self) -> Path:
        p = Path(self.job_storage_path)
        p.mkdir(parents=True, exist_ok=True)
        return p


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()
