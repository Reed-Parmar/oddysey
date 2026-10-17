"""PRJ-01..06 (admin writes; visibility per auth.md §7)."""

import uuid
from decimal import Decimal
from typing import Annotated, Literal

from fastapi import APIRouter, Query, Response
from pydantic import Field
from sqlalchemy import Select, delete, func, or_, select

from app import audit
from app.core.deps import DB, Admin, AnyRole
from app.core.errors import AppError, conflict, field_error, invalid_state, not_found
from app.core.responses import (
    Envelope,
    In,
    Meta,
    Page,
    PageEnvelope,
    check_sort,
    clean_q,
    empty_page,
    paginate,
)
from app.db import models as M
from app.db.enums import CycleStatus, Difficulty, ProjectStatus, UserRole, UserStatus
from app.domain import (
    VISIBLE_ALLOC,
    active_cycle,
    clean_names,
    latest_completed_run,
    lock_cycle,
    project_input,
    require_not_archived,
    resolve_cycle,
    resolve_skill_names,
    trainee_input,
)
from app.schemas import ProjectOut, ProjectStats, project_out
from spa_ai.scoring import eligibility

router = APIRouter(tags=["projects"])

SORTS = {"title": M.Project.title, "project_code": M.Project.project_code, "-created_at": M.Project.created_at.desc()}


def project_stats(
    db: DB, projects: list[M.Project], viewer: M.User, cycles: dict[uuid.UUID, M.Cycle]
) -> dict[uuid.UUID, ProjectStats | None]:
    if viewer.role == UserRole.student or not projects:
        return {p.id: None for p in projects}
    ids = [p.id for p in projects]
    alloc = dict(
        db.execute(
            select(M.Allocation.project_id, func.count())
            .where(M.Allocation.project_id.in_(ids))
            .group_by(M.Allocation.project_id)
        ).all()
    )
    eligible: dict[uuid.UUID, int] = {}
    for cycle_id in {p.cycle_id for p in projects}:
        run = latest_completed_run(db, cycle_id)
        if run is not None:
            eligible.update(
                dict(
                    db.execute(
                        select(M.Recommendation.project_id, func.count())
                        .where(
                            M.Recommendation.run_id == run.id,
                            M.Recommendation.eligible.is_(True),
                            M.Recommendation.project_id.in_(ids),
                        )
                        .group_by(M.Recommendation.project_id)
                    ).all()
                )
            )
    out: dict[uuid.UUID, ProjectStats | None] = {}
    for p in projects:
        if viewer.role == UserRole.supervisor and p.supervisor_id != viewer.id:
            out[p.id] = None
            continue
        show_alloc = viewer.role == UserRole.admin or cycles[p.cycle_id].status in VISIBLE_ALLOC
        out[p.id] = ProjectStats(
            allocated_count=alloc.get(p.id, 0) if show_alloc else None, eligible_trainee_count=eligible.get(p.id, 0)
        )
    return out


def _visible(stmt: Select, viewer: M.User, db: DB) -> Select:  # type: ignore[type-arg]
    if viewer.role == UserRole.student:
        cycle = active_cycle(db)
        return stmt.where(
            M.Project.status == ProjectStatus.published, M.Project.cycle_id == (cycle.id if cycle else None)
        )
    if viewer.role == UserRole.supervisor:
        return stmt.where(or_(M.Project.status == ProjectStatus.published, M.Project.supervisor_id == viewer.id))
    return stmt


def serialize(db: DB, projects: list[M.Project], viewer: M.User) -> list[ProjectOut]:
    cycles = {c.id: c for c in db.scalars(select(M.Cycle).where(M.Cycle.id.in_({p.cycle_id for p in projects})))}
    stats = project_stats(db, projects, viewer, cycles)
    return [project_out(p, stats[p.id]) for p in projects]


@router.get("/projects")
def list_projects(
    viewer: AnyRole,
    db: DB,
    params: Page,
    cycle_id: uuid.UUID | None = None,
    q: Annotated[str | None, Query(max_length=100)] = None,
    trade_id: uuid.UUID | None = None,
    difficulty: Difficulty | None = None,
    skill_id: uuid.UUID | None = None,
    status: ProjectStatus | None = None,
    mine: bool = False,
    supervisor_id: uuid.UUID | None = None,
    sort: str = "title",
) -> PageEnvelope[ProjectOut]:
    check_sort(sort, set(SORTS))
    cycle = resolve_cycle(db, cycle_id if viewer.role == UserRole.admin else None)
    if viewer.role != UserRole.admin and cycle_id and cycle and cycle.id != cycle_id:
        cycle = None
    if cycle is None:
        return empty_page(params)
    stmt = _visible(select(M.Project).where(M.Project.cycle_id == cycle.id), viewer, db)
    if (pattern := clean_q(q)) is not None:
        stmt = stmt.where(
            or_(
                M.Project.title.ilike(pattern, escape="\\"),
                M.Project.project_code.ilike(pattern, escape="\\"),
                M.Project.category.ilike(pattern, escape="\\"),
            )
        )
    if trade_id:
        stmt = stmt.where(M.Project.target_trade_id == trade_id)
    if difficulty:
        stmt = stmt.where(M.Project.difficulty == difficulty)
    if skill_id:
        stmt = stmt.where(
            M.Project.id.in_(select(M.ProjectSkill.project_id).where(M.ProjectSkill.skill_id == skill_id))
        )
    if status and viewer.role != UserRole.student:
        stmt = stmt.where(M.Project.status == status)
    if mine and viewer.role == UserRole.supervisor:
        stmt = stmt.where(M.Project.supervisor_id == viewer.id)
    if supervisor_id and viewer.role == UserRole.admin:
        stmt = stmt.where(M.Project.supervisor_id == supervisor_id)
    rows, meta = paginate(db, stmt.order_by(SORTS[sort], M.Project.project_code), params)
    return PageEnvelope(data=serialize(db, rows, viewer), meta=meta)


def get_visible_project(db: DB, project_id: uuid.UUID, viewer: M.User) -> M.Project:
    p = db.scalar(_visible(select(M.Project).where(M.Project.id == project_id), viewer, db))
    if p is None:
        raise not_found("Project")
    return p


@router.get("/projects/{project_id}")
def get_project(project_id: uuid.UUID, viewer: AnyRole, db: DB) -> Envelope[ProjectOut]:
    return Envelope(data=serialize(db, [get_visible_project(db, project_id, viewer)], viewer)[0])


Code = Annotated[str, Field(pattern=r"^[A-Za-z0-9-]{1,40}$")]
HttpsUrl = Annotated[str, Field(max_length=2048, pattern=r"^https://")]


class ProjectFields(In):
    title: str | None = Field(default=None, min_length=5, max_length=200)
    description: str | None = Field(default=None, max_length=5000)
    problem_doc_url: HttpsUrl | None = None
    target_trade_id: uuid.UUID | None = None
    difficulty: Difficulty | None = None
    min_practical_score: Decimal | None = Field(default=None, ge=0, le=100)
    max_trainees: int | None = Field(default=None, ge=1, le=100)
    category: str | None = Field(default=None, max_length=120)
    supervisor_id: uuid.UUID | None = None
    skills: list[str] | None = None


class ProjectCreate(ProjectFields):
    cycle_id: uuid.UUID
    project_code: Code
    title: str = Field(min_length=5, max_length=200)
    target_trade_id: uuid.UUID
    difficulty: Difficulty
    min_practical_score: Decimal = Field(default=Decimal(0), ge=0, le=100)
    max_trainees: int = Field(ge=1, le=100)


class ProjectPatch(ProjectFields):
    project_code: Code | None = None


def check_supervisor(db: DB, supervisor_id: uuid.UUID | None, field: str = "body.supervisor_id") -> None:
    if supervisor_id is None:
        return
    u = db.scalar(select(M.User).where(M.User.id == supervisor_id).with_for_update(read=True))
    if u is None or u.role != UserRole.supervisor or u.status != UserStatus.active:
        raise field_error(field, "must be an active supervisor")


def check_trade(db: DB, trade_id: uuid.UUID) -> None:
    if db.get(M.Trade, trade_id) is None:
        raise field_error("body.target_trade_id", "unknown trade")


def ineligible_allocation_warnings(db: DB, project: M.Project) -> list[str]:
    allocs = db.scalars(select(M.Allocation).where(M.Allocation.project_id == project.id)).unique().all()
    pi = project_input(project)
    n_trade = n_min = 0
    for a in allocs:
        reasons = eligibility(trainee_input(a.trainee), pi)
        n_trade += "trade_mismatch" in reasons
        n_min += "below_min_practical" in reasons
    out = []
    if n_trade:
        out.append(f"{n_trade} allocation(s) are now in a different trade")
    if n_min:
        out.append(f"{n_min} allocation(s) are now below the minimum practical score")
    return out


@router.post("/projects", status_code=201)
def create_project(body: ProjectCreate, admin: Admin, db: DB) -> Envelope[ProjectOut]:
    cycle = db.get(M.Cycle, body.cycle_id)
    if cycle is None:
        raise field_error("body.cycle_id", "unknown cycle")
    cycle = lock_cycle(db, body.cycle_id)
    require_not_archived(cycle)
    check_trade(db, body.target_trade_id)
    check_supervisor(db, body.supervisor_id)
    if db.scalar(
        select(M.Project.id).where(
            M.Project.cycle_id == cycle.id, func.upper(M.Project.project_code) == body.project_code.upper()
        )
    ):
        raise conflict("DUPLICATE_CODE", "A project with this code already exists in the cycle")
    skills, _ = resolve_skill_names(db, clean_names(body.skills or [], 15, "body.skills"))
    p = M.Project(
        cycle_id=cycle.id,
        project_code=body.project_code,
        title=body.title,
        description=body.description or None,
        problem_doc_url=body.problem_doc_url or None,
        target_trade_id=body.target_trade_id,
        difficulty=body.difficulty,
        min_practical_score=body.min_practical_score,
        max_trainees=body.max_trainees,
        category=body.category or None,
        supervisor_id=body.supervisor_id,
        created_by=admin.id,
    )
    p.skills = skills
    db.add(p)
    db.flush()
    audit.record(db, admin.id, "project.created", "project", p.id, {"project_code": p.project_code})
    db.commit()
    db.refresh(p)
    return Envelope(data=serialize(db, [p], admin)[0])


def _lock_project(db: DB, project_id: uuid.UUID) -> M.Project:
    p = db.get(M.Project, project_id)
    if p is None:
        raise not_found("Project")
    lock_cycle(db, p.cycle_id, update=True)
    p = db.scalar(select(M.Project).where(M.Project.id == project_id).with_for_update(of=M.Project))
    assert p is not None
    return p


@router.patch("/projects/{project_id}")
def patch_project(project_id: uuid.UUID, body: ProjectPatch, admin: Admin, db: DB) -> Envelope[ProjectOut]:
    p = _lock_project(db, project_id)
    cycle = db.get(M.Cycle, p.cycle_id)
    require_not_archived(cycle)  # type: ignore[arg-type]
    changes = body.model_dump(exclude_unset=True)
    if "max_trainees" in changes and changes["max_trainees"] is not None:
        used = db.scalar(select(func.count()).select_from(M.Allocation).where(M.Allocation.project_id == p.id)) or 0
        if changes["max_trainees"] < used:
            raise conflict("CAPACITY_BELOW_ALLOCATED", f"{used} trainees are already allocated")
    if "supervisor_id" in changes:
        if changes["supervisor_id"] is None and p.status == ProjectStatus.published:
            raise invalid_state("A published project needs a supervisor")
        check_supervisor(db, changes["supervisor_id"])
    if changes.get("target_trade_id"):
        check_trade(db, changes["target_trade_id"])
    if changes.get("project_code") and changes["project_code"].upper() != p.project_code.upper():
        if db.scalar(
            select(M.Project.id).where(
                M.Project.cycle_id == p.cycle_id,
                M.Project.id != p.id,
                func.upper(M.Project.project_code) == changes["project_code"].upper(),
            )
        ):
            raise conflict("DUPLICATE_CODE", "A project with this code already exists in the cycle")
    required = {"title", "target_trade_id", "difficulty", "min_practical_score", "max_trainees", "project_code"}
    changed: list[str] = []
    for field, value in changes.items():
        if field == "skills":
            names = clean_names(value or [], 15, "body.skills")
            if sorted(n.lower() for n in names) != sorted(s.name.lower() for s in p.skills):
                p.skills = resolve_skill_names(db, names)[0]
                changed.append("skills")
            continue
        if value is None and field in required:
            raise field_error(f"body.{field}", "cannot be null")
        if isinstance(value, str) and value == "":
            value = None
        if getattr(p, field) != value:
            setattr(p, field, value)
            changed.append(field)
    db.flush()
    warnings: list[str] = []
    if {"target_trade_id", "min_practical_score"} & set(changed):
        db.refresh(p)
        warnings = ineligible_allocation_warnings(db, p)
    if changed:
        audit.record(db, admin.id, "project.updated", "project", p.id, {"changed": changed})
    db.commit()
    db.refresh(p)
    return Envelope(data=serialize(db, [p], admin)[0], meta=Meta(warnings=warnings) if warnings else None)


@router.delete("/projects/{project_id}", status_code=204)
def delete_project(project_id: uuid.UUID, admin: Admin, db: DB) -> Response:
    p = _lock_project(db, project_id)
    cycle = db.get(M.Cycle, p.cycle_id)
    if p.status != ProjectStatus.draft or cycle.status == CycleStatus.archived:  # type: ignore[union-attr]
        raise invalid_state("Only draft projects in a non-archived cycle can be deleted")
    refs = db.scalar(select(func.count()).select_from(M.Recommendation).where(M.Recommendation.project_id == p.id))
    if refs:
        raise conflict("RESOURCE_IN_USE", "This project has recommendations and cannot be deleted")
    code = p.project_code
    db.execute(delete(M.ProjectSkill).where(M.ProjectSkill.project_id == p.id))
    db.delete(p)
    audit.record(db, admin.id, "project.deleted", "project", project_id, {"project_code": code})
    db.commit()
    return Response(status_code=204)


class ProjectTransition(In):
    to: Literal["draft", "published", "archived"]


@router.post("/projects/{project_id}/transition")
def transition_project(project_id: uuid.UUID, body: ProjectTransition, admin: Admin, db: DB) -> Envelope[ProjectOut]:
    p = _lock_project(db, project_id)
    cycle = db.get(M.Cycle, p.cycle_id)
    to = ProjectStatus(body.to)
    if p.status == to:
        raise invalid_state(f"Project is already {to.value}")
    if cycle.status == CycleStatus.archived:  # type: ignore[union-attr]
        raise invalid_state("Cycle is archived (read-only)")
    allocs = db.scalar(select(func.count()).select_from(M.Allocation).where(M.Allocation.project_id == p.id)) or 0
    if to == ProjectStatus.published:
        if p.status != ProjectStatus.draft:
            raise invalid_state("Only draft projects can be published")
        if p.supervisor_id is None:
            raise invalid_state(
                "Assign a supervisor before publishing",
                [{"field": "supervisor_id", "message": "Assign a supervisor before publishing"}],
            )
        check_supervisor(db, p.supervisor_id, "supervisor_id")
    elif allocs:
        raise invalid_state(f"{allocs} trainees are allocated to this project; remove them first")
    if to == ProjectStatus.draft and p.status not in (ProjectStatus.published, ProjectStatus.archived):
        raise AppError(409, "INVALID_STATE", "Invalid transition")
    old = p.status
    p.status = to
    audit.record(db, admin.id, "project.transitioned", "project", p.id, {"from": old.value, "to": to.value})
    db.commit()
    db.refresh(p)
    return Envelope(data=serialize(db, [p], admin)[0])
