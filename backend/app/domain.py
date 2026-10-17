"""Cross-module domain helpers: cycles, trade/skill resolution (C-4, C-5), scorer inputs, progress."""

import uuid
from collections.abc import Iterable
from datetime import UTC, datetime

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.errors import AppError, invalid_state, not_found
from app.db import models as M
from app.db.enums import CycleStatus, SubmissionStatus, TraineeProgress
from spa_ai.scoring import ProjectInput, TraineeInput

ACTIVE = (CycleStatus.draft, CycleStatus.published)
# ADR-017: assignments become visible as soon as they are made (no separate publish step).
VISIBLE_ALLOC = (CycleStatus.draft, CycleStatus.published, CycleStatus.archived)


# ---------------------------------------------------------------- cycles


def active_cycle(db: Session) -> M.Cycle | None:
    return db.scalar(select(M.Cycle).where(M.Cycle.status.in_(ACTIVE)))


def resolve_cycle(db: Session, cycle_id: uuid.UUID | None) -> M.Cycle | None:
    """List filter semantics: default active cycle; unknown id → None (lists return empty)."""
    return db.get(M.Cycle, cycle_id) if cycle_id else active_cycle(db)


def lock_cycle(db: Session, cycle_id: uuid.UUID, update: bool = False) -> M.Cycle:
    stmt = select(M.Cycle).where(M.Cycle.id == cycle_id)
    stmt = stmt.with_for_update() if update else stmt.with_for_update(read=True)
    cycle = db.scalar(stmt)
    if cycle is None:
        raise not_found("Cycle")
    return cycle


def require_not_archived(cycle: M.Cycle) -> None:
    if cycle.status == CycleStatus.archived:
        raise invalid_state("Cycle is archived (read-only)")


# ---------------------------------------------------------------- reference data


def clean_names(names: Iterable[str], limit: int, field: str) -> list[str]:
    out: list[str] = []
    seen: set[str] = set()
    for raw in names:
        name = " ".join(str(raw).split())
        if not name:
            continue
        if len(name) > 80:
            raise AppError(
                422,
                "VALIDATION_ERROR",
                "Validation failed",
                [{"field": field, "message": f"'{name[:20]}…' is longer than 80 characters"}],
            )
        if name.lower() not in seen:
            seen.add(name.lower())
            out.append(name)
    if len(out) > limit:
        raise AppError(
            422, "VALIDATION_ERROR", "Validation failed", [{"field": field, "message": f"at most {limit} entries"}]
        )
    return out


def resolve_skill_names(db: Session, names: list[str]) -> tuple[list[M.Skill], list[str]]:
    """Case-insensitive reuse; creates missing skills. Returns (skills in input order, created names)."""
    if not names:
        return [], []
    existing = {
        s.name.lower(): s
        for s in db.scalars(select(M.Skill).where(func.lower(M.Skill.name).in_([n.lower() for n in names])))
    }
    created: list[str] = []
    out: list[M.Skill] = []
    for n in names:
        s = existing.get(n.lower())
        if s is None:
            s = M.Skill(name=n)
            db.add(s)
            db.flush()
            existing[n.lower()] = s
            created.append(n)
        out.append(s)
    return out, created


def resolve_trade_names(db: Session, names: list[str], create_missing: bool) -> tuple[dict[str, M.Trade], list[str]]:
    existing = (
        {
            t.name.lower(): t
            for t in db.scalars(select(M.Trade).where(func.lower(M.Trade.name).in_([n.lower() for n in names])))
        }
        if names
        else {}
    )
    created: list[str] = []
    if create_missing:
        for n in names:
            if n.lower() not in existing:
                t = M.Trade(name=n)
                db.add(t)
                db.flush()
                existing[n.lower()] = t
                created.append(n)
    return existing, created


# ---------------------------------------------------------------- scorer inputs (no PII by construction)


def _num(v: object) -> float | None:
    return None if v is None else float(v)  # type: ignore[arg-type]


def trainee_input(t: M.Trainee) -> TraineeInput:
    """Only verified/imported marks are scorer inputs; resume-reported marks never are (ADR-017)."""
    trades = t.all_trades
    return TraineeInput(
        id=str(t.id),
        trade_id=str(t.trade_id),
        trade_name=t.trade.name,
        theory=_num(t.theory_score),
        practical=_num(t.practical_score),
        safety=_num(t.safety_score),
        skills=tuple(s.name for s in t.skills),
        career_interest=t.career_interest,
        background=t.background,
        trade_ids=tuple(str(x.id) for x in trades),
        trade_names=tuple(x.name for x in trades),
    )


def project_input(p: M.Project) -> ProjectInput:
    trades = p.all_trades
    return ProjectInput(
        id=str(p.id),
        project_code=p.project_code,
        title=p.title,
        category=p.category,
        description=p.description,
        difficulty=p.difficulty.value if p.difficulty else "intermediate",
        target_trade_id=str(p.target_trade_id) if p.target_trade_id else "",
        target_trade_name=p.target_trade.name if p.target_trade else "",
        min_practical_score=float(p.min_practical_score),
        skills=tuple(s.name for s in p.skills),
        target_trade_ids=tuple(str(x.id) for x in trades),
        target_trade_names=tuple(x.name for x in trades),
        min_match_score=float(p.min_match_score or 0),
    )


def set_trainee_trades(t: M.Trainee, trades: list[M.Trade]) -> None:
    """First trade is the primary (legacy single column); all trades go to the join table."""
    if trades:
        t.trade_id = trades[0].id
        t.trade = trades[0]
    t.trades = trades


def set_project_trades(p: M.Project, trades: list[M.Trade]) -> None:
    p.target_trade_id = trades[0].id if trades else None
    p.target_trade = trades[0] if trades else None
    p.trades = trades


def effective_deadline(project: M.Project, cycle: M.Cycle) -> datetime:
    """Explicit project deadline overrides the cycle default (ADR-017)."""
    return project.deadline or cycle.submission_deadline


def active_allocation(db: Session, trainee_id: uuid.UUID) -> M.Allocation | None:
    from app.db.enums import AllocationStatus

    return db.scalar(
        select(M.Allocation).where(
            M.Allocation.trainee_id == trainee_id, M.Allocation.status == AllocationStatus.active
        )
    )


def person_key(t: M.Trainee) -> str:
    """Stable person identity for rejection exclusions: the canonical trainee code."""
    return t.trainee_code.upper()


# ---------------------------------------------------------------- runs


def latest_completed_run(db: Session, cycle_id: uuid.UUID) -> M.RecommendationRun | None:
    from app.db.enums import RunStatus

    return db.scalar(
        select(M.RecommendationRun)
        .where(M.RecommendationRun.cycle_id == cycle_id, M.RecommendationRun.status == RunStatus.completed)
        .order_by(M.RecommendationRun.created_at.desc())
        .limit(1)
    )


# ---------------------------------------------------------------- progress (single derivation, PROG-01 / RPT-01)


def latest_submissions(db: Session, allocation_ids: list[uuid.UUID]) -> dict[uuid.UUID, M.Submission]:
    if not allocation_ids:
        return {}
    rows = (
        db.scalars(
            select(M.Submission)
            .where(M.Submission.allocation_id.in_(allocation_ids))
            .order_by(M.Submission.allocation_id, M.Submission.version.desc())
        )
        .unique()
        .all()
    )
    out: dict[uuid.UUID, M.Submission] = {}
    for s in rows:
        out.setdefault(s.allocation_id, s)
    return out


def derive_progress(
    allocation: M.Allocation | None, latest: M.Submission | None, cycle: M.Cycle, admin: bool
) -> TraineeProgress:
    if allocation is None or (not admin and cycle.status not in VISIBLE_ALLOC):
        return TraineeProgress.unallocated
    if latest is None:
        return TraineeProgress.allocated
    return {
        SubmissionStatus.submitted: TraineeProgress.submitted,
        SubmissionStatus.rework_requested: TraineeProgress.rework_requested,
        SubmissionStatus.evaluated: TraineeProgress.evaluated,
    }[latest.status]


def now_utc() -> datetime:
    return datetime.now(UTC)
