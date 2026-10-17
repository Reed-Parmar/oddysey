"""REC-01..03 and the in-process recommendation worker (ADR-003, api.md REC, supervisor.md §9).

The worker snapshots inputs, scores with spa_ai.scoring, optionally refines with Groq (spa_ai.refiner),
and writes rows per trainee. Readers only use `completed` runs, so partial results are never visible."""

import logging
import uuid
from collections.abc import Callable
from concurrent.futures import Future, ThreadPoolExecutor
from typing import Annotated, Literal

from fastapi import APIRouter, Query
from pydantic import BaseModel
from sqlalchemy import select, update
from sqlalchemy.orm import Session

from app import audit
from app.core.config import get_settings
from app.core.deps import DB, Admin, StudentOrAdmin
from app.core.errors import conflict, invalid_state, not_found
from app.core.responses import Envelope, In, Page, PageEnvelope, check_sort, empty_page, paginate
from app.db import models as M
from app.db.enums import ProjectStatus, RecommendationSource, RunStatus, UserRole
from app.db.session import get_sessionmaker
from app.domain import ACTIVE, latest_completed_run, now_utc, project_input, resolve_cycle, trainee_input
from app.schemas import RecommendationOut, RunOut, recommendation_out, run_out
from spa_ai.llm import AIClient, GroqClient
from spa_ai.refiner import RefineOutcome, refine_trainee
from spa_ai.scoring import (
    PairScore,
    ProjectInput,
    TraineeInput,
    apply_ai,
    assessment_complete,
    rank_pairs,
    score_pair,
    select_stored,
)

log = logging.getLogger("spa.recommendations")
router = APIRouter(tags=["recommendations"])

_executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="rec-run")


def default_ai_client() -> AIClient | None:
    s = get_settings()
    if not s.groq_api_key:
        return None
    return GroqClient(api_key=s.groq_api_key, model=s.groq_model, timeout=s.ai_timeout_seconds)


# Tests replace this factory with one returning a FakeAIClient.
ai_client_factory: Callable[[], AIClient | None] = default_ai_client


# ---------------------------------------------------------------- worker


def fail_stale_runs(db: Session) -> int:
    """C-16: at boot every queued/running run is orphaned (single instance)."""
    n = db.execute(
        update(M.RecommendationRun)
        .where(M.RecommendationRun.status.in_((RunStatus.queued, RunStatus.running)))
        .values(status=RunStatus.failed, error_message="Interrupted by server restart", finished_at=now_utc())
    ).rowcount
    db.commit()
    return n or 0


def _rows_for_trainee(
    t: TraineeInput, projects: list[ProjectInput], outcome: RefineOutcome | None
) -> list[tuple[int, PairScore]]:
    pairs = [score_pair(t, p) for p in projects]
    if outcome is not None and outcome.refined:
        pairs = [
            apply_ai(pr, *outcome.refined[pr.project_id]) if pr.project_id in outcome.refined else pr for pr in pairs
        ]
    ranked = rank_pairs(pairs)
    matching = {p.id for p in projects if p.target_trade_id == t.trade_id}
    return select_stored(ranked, matching)


def _candidates(t: TraineeInput, projects: list[ProjectInput]) -> list[ProjectInput]:
    by_id = {p.id: p for p in projects}
    ranked = rank_pairs([score_pair(t, p) for p in projects])
    return [by_id[pr.project_id] for _, pr in ranked if pr.eligible][:5]


def execute_run(run_id: uuid.UUID) -> None:
    Session_ = get_sessionmaker()
    with Session_() as db:
        try:
            _execute(db, run_id)
        except Exception:
            log.exception("recommendation run failed run_id=%s", run_id)
            db.rollback()
            db.execute(
                update(M.RecommendationRun)
                .where(M.RecommendationRun.id == run_id)
                .values(
                    status=RunStatus.failed,
                    error_message="The run failed unexpectedly. Please try again.",
                    finished_at=now_utc(),
                )
            )
            run = db.get(M.RecommendationRun, run_id)
            if run is not None:
                audit.record(
                    db,
                    run.started_by,
                    "recommendation.run_finished",
                    "recommendation_run",
                    run_id,
                    {
                        "status": "failed",
                        "trainee_count": run.trainee_count,
                        "ai_used_count": run.ai_used_count,
                        "ai_failed_count": run.ai_failed_count,
                    },
                )
            db.commit()


def _execute(db: Session, run_id: uuid.UUID) -> None:
    run = db.get(M.RecommendationRun, run_id)
    if run is None or run.status != RunStatus.queued:
        return
    trainees_orm = (
        db.scalars(select(M.Trainee).where(M.Trainee.cycle_id == run.cycle_id).order_by(M.Trainee.trainee_code))
        .unique()
        .all()
    )
    projects_orm = (
        db.scalars(
            select(M.Project)
            .where(M.Project.cycle_id == run.cycle_id, M.Project.status == ProjectStatus.published)
            .order_by(M.Project.project_code)
        )
        .unique()
        .all()
    )
    trainees = [trainee_input(t) for t in trainees_orm]
    projects = [project_input(p) for p in projects_orm]
    assessed = [t for t in trainees if assessment_complete(t)]
    run.status, run.started_at = RunStatus.running, now_utc()
    run.trainee_count = len(assessed)
    run.skipped_pending_count = len(trainees) - len(assessed)
    run.scored_pairs = len(assessed) * len(projects)
    db.commit()

    client = ai_client_factory() if run.use_ai else None
    futures: dict[str, Future[RefineOutcome]] = {}
    pool: ThreadPoolExecutor | None = None
    if client is not None and projects:
        pool = ThreadPoolExecutor(max_workers=max(1, get_settings().ai_concurrency), thread_name_prefix="rec-ai")
        for t in assessed:
            cands = _candidates(t, projects)
            if cands:
                futures[t.id] = pool.submit(refine_trainee, client, t, cands)
    try:
        for t in assessed:
            outcome = None
            if t.id in futures:
                try:
                    outcome = futures[t.id].result()
                except Exception:
                    outcome = RefineOutcome(used=False, failed=True, refined={})
                run.ai_used_count += int(outcome.used)
                run.ai_failed_count += int(outcome.failed)
            for rank, pr in _rows_for_trainee(t, projects, outcome):
                db.add(
                    M.Recommendation(
                        run_id=run.id,
                        cycle_id=run.cycle_id,
                        trainee_id=uuid.UUID(pr.trainee_id),
                        project_id=uuid.UUID(pr.project_id),
                        score=pr.score,
                        rank=rank,
                        eligible=pr.eligible,
                        ineligible_reasons=list(pr.ineligible_reasons),
                        factors=[f.to_dict() for f in pr.factors],
                        source=RecommendationSource(pr.source),
                        ai_explanation=pr.ai_explanation,
                    )
                )
            run.progress_done += 1
            db.commit()
    finally:
        if pool is not None:
            pool.shutdown(wait=False, cancel_futures=True)
    run.status, run.finished_at = RunStatus.completed, now_utc()
    audit.record(
        db,
        run.started_by,
        "recommendation.run_finished",
        "recommendation_run",
        run.id,
        {
            "status": "completed",
            "trainee_count": run.trainee_count,
            "ai_used_count": run.ai_used_count,
            "ai_failed_count": run.ai_failed_count,
        },
    )
    db.commit()
    log.info(
        "recommendation run completed run_id=%s trainees=%s ai_used=%s ai_failed=%s",
        run.id,
        run.trainee_count,
        run.ai_used_count,
        run.ai_failed_count,
    )


# ---------------------------------------------------------------- endpoints


class RunIn(In):
    use_ai: bool = True


@router.post("/cycles/{cycle_id}/recommendation-runs", status_code=202)
def start_run(cycle_id: uuid.UUID, admin: Admin, db: DB, body: RunIn | None = None) -> Envelope[RunOut]:
    body = body or RunIn()
    cycle = db.scalar(select(M.Cycle).where(M.Cycle.id == cycle_id).with_for_update(read=True))
    if cycle is None:
        raise not_found("Cycle")
    if cycle.status not in ACTIVE:
        raise invalid_state("Recommendations can only run for a planning or published cycle")
    if db.scalar(
        select(M.RecommendationRun.id).where(
            M.RecommendationRun.cycle_id == cycle.id,
            M.RecommendationRun.status.in_((RunStatus.queued, RunStatus.running)),
        )
    ):
        raise conflict("RUN_IN_PROGRESS", "A recommendation run is already in progress")
    settings = get_settings()
    use_ai = body.use_ai and settings.ai_configured
    run = M.RecommendationRun(
        cycle_id=cycle.id, use_ai=use_ai, ai_model=settings.groq_model if use_ai else None, started_by=admin.id
    )
    db.add(run)
    db.flush()
    audit.record(db, admin.id, "recommendation.run_started", "recommendation_run", run.id, {"use_ai": use_ai})
    db.commit()
    if settings.run_inline:
        execute_run(run.id)
    else:
        _executor.submit(execute_run, run.id)
    db.refresh(run)
    return Envelope(data=run_out(run))


class RunMeta(BaseModel):
    ai_configured: bool


class RunEnvelope(BaseModel):
    data: RunOut | None
    meta: RunMeta


@router.get("/cycles/{cycle_id}/recommendation-runs/latest")
def latest_run(cycle_id: uuid.UUID, _: Admin, db: DB, status: Literal["completed"] | None = None) -> RunEnvelope:
    if db.get(M.Cycle, cycle_id) is None:
        raise not_found("Cycle")
    if status == "completed":
        run = latest_completed_run(db, cycle_id)
    else:
        run = db.scalar(
            select(M.RecommendationRun)
            .where(M.RecommendationRun.cycle_id == cycle_id)
            .order_by(M.RecommendationRun.created_at.desc())
            .limit(1)
        )
    return RunEnvelope(data=run_out(run) if run else None, meta=RunMeta(ai_configured=get_settings().ai_configured))


SORTS = {"rank", "-score", "trainee_name"}


@router.get("/recommendations")
def list_recommendations(
    viewer: StudentOrAdmin,
    db: DB,
    params: Page,
    cycle_id: uuid.UUID | None = None,
    run_id: uuid.UUID | None = None,
    trainee_id: uuid.UUID | None = None,
    project_id: uuid.UUID | None = None,
    eligible_only: bool = False,
    sort: Annotated[str, Query()] = "rank",
) -> PageEnvelope[RecommendationOut]:
    check_sort(sort, SORTS)
    is_student = viewer.role == UserRole.student
    cycle = resolve_cycle(db, None if is_student else cycle_id)
    if cycle is None:
        return empty_page(params)
    run = latest_completed_run(db, cycle.id)
    if not is_student and run_id is not None:
        run = db.get(M.RecommendationRun, run_id)
        if run is None or run.status != RunStatus.completed or run.cycle_id != cycle.id:
            return empty_page(params)
    if run is None:
        return empty_page(params)
    stmt = select(M.Recommendation).where(M.Recommendation.run_id == run.id)
    if is_student:
        mine = db.scalar(select(M.Trainee.id).where(M.Trainee.cycle_id == cycle.id, M.Trainee.user_id == viewer.id))
        if mine is None:
            return empty_page(params)
        stmt = stmt.where(
            M.Recommendation.trainee_id == mine, M.Recommendation.eligible.is_(True), M.Recommendation.rank <= 5
        )
    else:
        if trainee_id:
            stmt = stmt.where(M.Recommendation.trainee_id == trainee_id)
        if project_id:
            stmt = stmt.where(M.Recommendation.project_id == project_id)
        if eligible_only:
            stmt = stmt.where(M.Recommendation.eligible.is_(True))
    stmt = stmt.join(M.Trainee, M.Trainee.id == M.Recommendation.trainee_id).join(
        M.Project, M.Project.id == M.Recommendation.project_id
    )
    order = {
        "rank": (M.Recommendation.rank,),
        "-score": (M.Recommendation.score.desc(),),
        "trainee_name": (M.Trainee.full_name, M.Recommendation.rank),
    }[sort]
    stmt = stmt.order_by(*order, M.Trainee.trainee_code, M.Project.project_code)
    rows, meta = paginate(db, stmt, params)
    return PageEnvelope(data=[recommendation_out(r) for r in rows], meta=meta)
