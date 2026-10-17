"""Database-free replay of the ADR-017 allocation jobs in ``app.automation.allocation``.

Every decision is delegated to production functions: ``best_project`` (ordinary allocation),
``rank_candidates`` (ranked replacement), ``score_pair`` (eligibility counts), ``waiting_reason`` and
``explain``. This module only mirrors the job control flow that is coupled to SQL there:

- ``ready_projects``: published + processing ``ready`` + supervisor assigned, ordered by project code.
- ``unassigned_trainees``: enrolled, no active allocation, ordered by enrolment time then id.
- ``allocate_cycle``: pending replacements first (rejection time, then id), then every waiting trainee
  gets ``best_project`` over the ready projects they have not rejected.
- ``replace_one``: rank the unassigned, non-excluded pool for the rejected project; offer it to rank 1.

There is no capacity (ADR-017), so per-trainee best is also the optimum of the total-score objective.
Row locks, savepoints and notifications have no equivalent without a database and are omitted.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from app.automation.allocation import MODE_LABEL, explain, waiting_reason
from spa_ai.scoring import (
    MODE_FULL,
    SCORING_VERSION,
    PairScore,
    ProjectInput,
    TraineeInput,
    best_project,
    rank_candidates,
    score_pair,
)

ALLOCATION_POLICY = "adr017-best-eligible+ranked-replacement"


@dataclass
class ScenarioProject:
    project_id: str
    project_code: str
    status: str  # draft | published | archived
    processing_status: str
    supervisor_assigned: bool
    pinput: ProjectInput

    @property
    def allocatable(self) -> bool:
        """Mirror of app.automation.allocation.ready_projects."""
        return self.status == "published" and self.processing_status == "ready" and self.supervisor_assigned

    def pipeline_reasons(self) -> list[str]:
        reasons: list[str] = []
        if self.status == "archived":
            reasons.append("project_archived")
        elif self.status != "published":
            reasons.append("project_not_published")
        if self.processing_status != "ready":
            reasons.append("project_processing_not_ready")
        if not self.supervisor_assigned:
            reasons.append("project_no_supervisor")
        return reasons


@dataclass
class Allocation:
    allocation_id: str
    trainee_id: str
    project_id: str
    project_code: str
    trigger: str
    score: float
    mode: str
    factors: list[dict[str, Any]]
    explanation: str
    event_seq: int
    at: str
    status: str = "active"
    source: str = "auto"  # AllocationSource: every automatic insert, including replacements, is "auto"
    assignment_kind: str = "best_eligible"  # or "replacement"
    rejection_id: str | None = None  # the rejection this allocation replaced
    replacement_rank: int | None = None
    scoring_version: str = SCORING_VERSION


@dataclass
class Rejection:
    rejection_id: str
    allocation_id: str
    trainee_id: str
    project_id: str
    project_code: str
    reason: str
    at: str
    event_seq: int
    previous_score: float
    previous_mode: str
    replacement_status: str = "queued"
    replacement_attempts: int = 0
    replacement_allocation_id: str | None = None
    selected_trainee_id: str | None = None
    selected_rank: int | None = None
    ranking_mode: str | None = None
    candidate_count: int = 0
    eligible_count: int = 0
    candidates: list[dict[str, Any]] = field(default_factory=list)
    explanation: str | None = None


class CycleState:
    """One synthetic cycle. ``enrol``, ``reject`` and ``allocate_cycle`` are called in event order."""

    def __init__(self, scenario_id: str, projects: list[ScenarioProject]) -> None:
        self.scenario_id = scenario_id
        self.projects = sorted(projects, key=lambda p: p.project_code)
        self.ready = [p for p in self.projects if p.allocatable]
        self.trainees: dict[str, TraineeInput] = {}
        self.enrolled: list[tuple[int, str]] = []  # (enrolment seq, trainee id): waiting order
        self.allocations: list[Allocation] = []
        self.rejections: list[Rejection] = []
        self.excluded: dict[str, set[str]] = {}  # trainee id -> rejected project ids
        self.seq = 0
        self.tick_log: list[dict[str, Any]] = []

    # -------------------------------------------------------------- queries

    def active(self, trainee_id: str) -> Allocation | None:
        return next((a for a in self.allocations if a.trainee_id == trainee_id and a.status == "active"), None)

    def unassigned(self) -> list[str]:
        busy = {a.trainee_id for a in self.allocations if a.status == "active"}
        return [tid for _, tid in sorted(self.enrolled) if tid not in busy]

    def allowed(self, trainee_id: str) -> list[ProjectInput]:
        ex = self.excluded.get(trainee_id, set())
        return [p.pinput for p in self.ready if p.project_id not in ex]

    # -------------------------------------------------------------- events

    def _next(self) -> int:
        self.seq += 1
        return self.seq

    def enrol(self, trainee: TraineeInput) -> None:
        self.trainees[trainee.id] = trainee
        self.enrolled.append((self._next(), trainee.id))

    def _insert(self, tid: str, ps: PairScore, trigger: str, explanation: str, at: str, **kw: Any) -> Allocation:
        a = Allocation(
            allocation_id=f"{self.scenario_id}-ALC-{len(self.allocations) + 1:05d}",
            trainee_id=tid,
            project_id=ps.project_id,
            project_code=ps.project_code,
            trigger=trigger,
            score=ps.score,
            mode=ps.mode,
            factors=[f.to_dict() for f in ps.factors],
            explanation=explanation,
            event_seq=self._next(),
            at=at,
            **kw,
        )
        self.allocations.append(a)
        return a

    def allocate_cycle(self, trigger: str, at: str) -> dict[str, Any]:
        replaced = sum(self.replace_one(r, at)["status"] == "completed" for r in self._pending())
        allocated = 0
        waiting: dict[str, int] = {}
        for tid in self.unassigned():
            ti = self.trainees[tid]
            allowed = self.allowed(tid)
            best = best_project(ti, allowed) if allowed else None
            if best is None:
                key = waiting_reason(ti, allowed, bool(self.excluded.get(tid)))
                waiting[key] = waiting.get(key, 0) + 1
                continue
            n_eligible = sum(1 for p in allowed if score_pair(ti, p).eligible)
            self._insert(tid, best, trigger, explain(best, n_eligible, "Allocated"), at)
            allocated += 1
        out = {
            "at": at,
            "trigger": trigger,
            "allocated": allocated,
            "replacements": replaced,
            "waiting": waiting,
            "ready_projects": len(self.ready),
        }
        self.tick_log.append(out)
        return out

    def _pending(self) -> list[Rejection]:
        return sorted(
            (r for r in self.rejections if r.replacement_status in ("queued", "waiting_for_eligible_trainee")),
            key=lambda r: (r.event_seq, r.rejection_id),
        )

    def reject(self, allocation: Allocation, reason: str, at: str) -> Rejection:
        assert allocation.status == "active"
        allocation.status = "rejected"
        self.excluded.setdefault(allocation.trainee_id, set()).add(allocation.project_id)
        r = Rejection(
            rejection_id=f"{self.scenario_id}-REJ-{len(self.rejections) + 1:04d}",
            allocation_id=allocation.allocation_id,
            trainee_id=allocation.trainee_id,
            project_id=allocation.project_id,
            project_code=allocation.project_code,
            reason=reason,
            at=at,
            event_seq=self._next(),
            previous_score=allocation.score,
            previous_mode=allocation.mode,
        )
        self.rejections.append(r)
        # Production enqueues replace_rejection (higher priority) and allocate_cycle; run them in that order.
        self.replace_one(r, at)
        self.allocate_cycle("rejection", at)
        return r

    def replace_one(self, r: Rejection, at: str) -> dict[str, Any]:
        if r.replacement_status in ("completed", "cancelled"):
            return {"status": r.replacement_status}
        r.replacement_attempts += 1
        project = next((p for p in self.ready if p.project_id == r.project_id), None)
        if project is None:
            r.replacement_status = "waiting_for_eligible_trainee"
            return {"status": r.replacement_status}
        pool = [tid for tid in self.unassigned() if r.project_id not in self.excluded.get(tid, set())]
        mode, ranked, ineligible = rank_candidates(project.pinput, [self.trainees[t] for t in pool])
        r.ranking_mode = mode
        r.candidate_count, r.eligible_count = len(pool), len(ranked)
        r.candidates = [
            {"trainee_id": s.trainee_id, "rank": i, "score": s.score, "eligible": True}
            for i, s in enumerate(ranked, start=1)
        ] + [
            {
                "trainee_id": s.trainee_id,
                "rank": None,
                "score": s.score,
                "eligible": False,
                "reasons": s.ineligible_reasons,
            }
            for s in ineligible
        ]
        if not ranked:
            r.replacement_status = "waiting_for_eligible_trainee"
            return {"status": r.replacement_status}
        ps = ranked[0]  # no concurrent workers here, so the top candidate is always still free
        # Same wording as app.automation.allocation.replace_one.
        explanation = (
            f"Offered as the replacement for a rejected allocation: ranked 1 of {len(ranked)} eligible "
            f"waiting trainees ({MODE_LABEL[mode]}, score {ps.score:g}/100)."
        )
        a = self._insert(
            ps.trainee_id,
            ps,
            "replacement",
            explanation,
            at,
            assignment_kind="replacement",
            rejection_id=r.rejection_id,
            replacement_rank=1,
        )
        r.replacement_status = "completed"
        r.replacement_allocation_id = a.allocation_id
        r.selected_trainee_id, r.selected_rank, r.explanation = ps.trainee_id, 1, explanation
        return {"status": "completed"}

    def final_waiting_reason(self, trainee_id: str) -> str:
        return waiting_reason(self.trainees[trainee_id], self.allowed(trainee_id), bool(self.excluded.get(trainee_id)))


def ranking_note(mode: str) -> str:
    return (
        "all candidates had verified assessments (full score)"
        if mode == MODE_FULL
        else "the pool included profile-only candidates (60/40 skill/interest score for everyone)"
    )
