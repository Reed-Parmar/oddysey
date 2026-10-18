"""Typed settings (pydantic-settings). The app refuses to boot when a required variable is missing."""

from functools import lru_cache
from pathlib import Path

from pydantic import field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

ENV_FILE = Path(__file__).resolve().parents[2] / ".env"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=ENV_FILE, extra="ignore")

    app_env: str = "development"
    database_url: str
    supabase_url: str
    supabase_secret_key: str = ""
    supabase_jwt_secret: str = ""  # legacy HS256 projects and tests only
    auth_jwt_audience: str = "authenticated"
    storage_bucket: str = "submissions"
    resume_bucket: str = "resumes"
    project_doc_bucket: str = "project-docs"
    # ADR-024: local-disk storage without a valid Supabase key (never in production). Empty: backend/.local-storage
    local_storage_dir: str = ""
    api_public_url: str = "http://localhost:8000"  # absolute base for locally signed download links
    max_upload_bytes: int = 10 * 1024 * 1024
    max_import_bytes: int = 5 * 1024 * 1024
    max_resume_bytes: int = 5 * 1024 * 1024
    resume_uploads_per_hour: int = 5
    cors_allowed_origins: str = "http://localhost:5173"
    cors_allowed_origin_regex: str = ""
    frontend_base_url: str = "http://localhost:5173"
    log_level: str = "INFO"
    groq_api_key: str = ""
    groq_model: str = "openai/gpt-oss-20b"
    # Project Assistant (ADR-023): its own Groq models, so chat has a daily token budget separate from background jobs.
    assistant_model: str = "openai/gpt-oss-120b"
    assistant_fallback_model: str = "qwen/qwen3.8-27b"
    ai_timeout_seconds: float = 10.0
    # ADR-022: optional local Ollama, used when Groq is not configured or a Groq call fails. Empty = off.
    ollama_base_url: str = ""
    ollama_model: str = "llama3.1:8b"
    ollama_timeout_seconds: float = 120.0
    ai_concurrency: int = 4
    run_inline: bool = False  # tests: jobs are drained synchronously after each request
    # ADR-017 automation
    allocation_interval_minutes: int = 15
    # ADR-027 ILP optimiser: "ilp" balances project/supervisor load; "greedy" = each trainee's best project
    allocation_engine: str = "ilp"
    allocation_fair_share_slack: float = 1.25
    allocation_project_penalty: float = 8.0  # max match points traded to move one trainee off an over-full project
    allocation_supervisor_penalty: float = 5.0
    allocation_solver_seconds: float = 20.0
    archive_grace_days: int = 7
    run_worker_in_api: bool = False  # single-instance demos: run the job worker inside the API process
    worker_poll_seconds: float = 2.0
    job_lease_seconds: int = 300
    email_backend: str = "disabled"  # disabled | console | smtp
    smtp_host: str = ""
    smtp_port: int = 587
    smtp_username: str = ""
    smtp_password: str = ""
    smtp_from: str = ""
    report_url_fetch_enabled: bool = True
    max_report_fetch_bytes: int = 10 * 1024 * 1024
    originality_medium_at: float = 15.0
    originality_high_at: float = 40.0
    originality_rework_at: float = 50.0  # ADR-026: overlap % (after exclusions) that sends the work back for rework

    @field_validator("database_url")
    @classmethod
    def _require_db(cls, v: str) -> str:
        if not v:
            raise ValueError("DATABASE_URL is required")
        return v

    @field_validator("supabase_jwt_secret")
    @classmethod
    def _strong_secret(cls, v: str) -> str:
        if v and len(v) < 32:
            raise ValueError("SUPABASE_JWT_SECRET must be empty (JWKS projects) or at least 32 characters")
        return v

    @property
    def cors_origins(self) -> list[str]:
        return [o.strip() for o in self.cors_allowed_origins.split(",") if o.strip()]

    @property
    def ai_configured(self) -> bool:
        return bool(self.groq_api_key or self.ollama_base_url)

    @property
    def jwt_issuer(self) -> str:
        return f"{self.supabase_url.rstrip('/')}/auth/v1"


@lru_cache
def get_settings() -> Settings:
    return Settings()  # type: ignore[call-arg]
