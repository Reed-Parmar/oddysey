"""AST-01 Project Assistant (ADR-020, api.md §0c): grounded, read-only, stateless answers about one allocation.

The context bundle holds only what the caller can already read, with no name, trainee code, centre, gender or
email; free text (brief, document, report feedback) is redacted. The model answers only from the bundle.
Only a usage count is audited (never the question or the answer).
"""

import uuid
from datetime import UTC, datetime, timedelta
from typing import Literal

from fastapi import APIRouter
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import func, select

from app import ai, audit
from app.core.deps import DB, CurrentUser
from app.core.errors import AppError
from app.db import models as M
from app.db.enums import AllocationStatus, UserRole
from app.domain import effective_deadline, latest_submissions, now_utc, student_trainee
from app.modules.submissions import latest_analysis
from spa_ai import assistant
from spa_ai.resume.redact import redact

router = APIRouter(tags=["assistant"])

ai_client_factory = ai.default_ai_client  # tests patch this
ASK_LIMIT = 20  # questions per user per window
ASK_WINDOW = timedelta(minutes=10)


class Turn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    role: Literal["user", "assistant"]
    content: str = Field(min_length=1, max_length=1000)


class AskIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    question: str = Field(min_length=3, max_length=500)
    allocation_id: uuid.UUID | None = None
    history: list[Turn] = Field(default_factory=list, max_length=6)


class AssistantAnswer(BaseModel):
    answer: str
    sources: list[str]
    mode: Literal["ai", "rules"]
    intent: str | None = None


def _allocation_for(db: DB, user: M.User, allocation_id: uuid.UUID | None) -> M.Allocation:
    if user.role == UserRole.student:
        _, trainee = student_trainee(db, user.id)
        a = (
            db.scalar(
                select(M.Allocation).where(
                    M.Allocation.trainee_id == trainee.id, M.Allocation.status == AllocationStatus.active
                )
            )
            if trainee
            else None
        )
        if a is None:
            raise AppError(409, "NO_ACTIVE_ALLOCATION", "You don't have an allocated project yet")
        return a
    if user.role == UserRole.supervisor and allocation_id is not None:
        a = db.get(M.Allocation, allocation_id)
        if a is not None and a.status == AllocationStatus.active and a.project.supervisor_id == user.id:
            return a
    raise AppError(404, "NOT_FOUND", "Allocation not found")


def _lines(items: object, limit: int = 15) -> str:
    return "\n".join(f"- {x}" for x in (items or [])[:limit] if isinstance(x, str) and x.strip())  # type: ignore[index]


def build_sections(db: DB, a: M.Allocation) -> dict[str, str]:
    """The context bundle (api.md §0c). Keys are the `sources` the answer may cite."""
    t, p = a.trainee, a.project
    cycle = db.get(M.Cycle, a.cycle_id)
    pii = [t.full_name, t.trainee_code, t.centre_name, t.user.email if t.user else None]
    g = p.generated or {}
    sections: dict[str, str] = {}
    trades = ", ".join(tr.name for tr in p.trades) or (p.target_trade.name if p.target_trade else "")
    skills = ", ".join(s.name for s in p.skills)
    sections["project"] = (
        f"Title: {p.title}\nCode: {p.project_code}\nTrades: {trades or 'any'}\n"
        f"Difficulty: {p.difficulty.value if p.difficulty else 'not set'}\nCategory: {p.category or 'not set'}\n"
        f"Prerequisite skills: {skills or 'none listed'}"
    )
    brief = "\n\n".join(x for x in (p.description, (p.document_text or "")[:4000]) if x)
    if brief:
        sections["brief"] = redact(brief, pii)
    guide = []
    for s in g.get("steps") or []:
        if isinstance(s, dict):
            guide.append(f"{s.get('stage', '')}: {s.get('title', '')} — {s.get('detail', '')}")
    if guide:
        sections["guide"] = "Steps:\n" + "\n".join(f"- {x}" for x in guide)
    for key, label in (("deliverables", "Deliverables"), ("tools_materials", "Tools and materials")):
        if g.get(key):
            sections["guide"] = sections.get("guide", "") + f"\n{label}:\n{_lines(g[key], 20)}"
    if g.get("timeline"):
        ms = [
            f"{m.get('milestone')} (at {m.get('offset_pct')}% of the time)"
            for m in g["timeline"]
            if isinstance(m, dict)
        ]
        sections["guide"] = sections.get("guide", "") + "\nTimeline:\n" + _lines(ms)
    if cycle is not None:
        due = effective_deadline(p, cycle)
        days = (due - now_utc()).days
        when = f"{days} days left" if days >= 0 else f"{-days} days overdue"
        sections["deadline"] = f"Submission deadline: {due:%d %b %Y %H:%M} UTC ({when})."
    why = [a.explanation or ""]
    for f in a.factors or []:
        why.append(f"- {f.get('label')}: {f.get('points')}/{f.get('max_points')} — {f.get('detail') or ''}")
    if a.match_score is not None:
        why.append(f"Match score: {float(a.match_score):.0f}/100 ({a.match_mode or 'full'} mode)")
    sections["allocation"] = "\n".join(x for x in why if x)
    sub = latest_submissions(db, [a.id]).get(a.id)
    if sub is None:
        sections["submission"] = (
            "Nothing submitted yet. A report (PDF/DOCX file or a link) is required; a video is optional. "
            "The project can still be rejected before the first submission."
        )
        return sections
    sections["submission"] = (
        f"Latest submission: version {sub.version}, status {sub.status.value}, submitted {sub.submitted_at:%d %b %Y}. "
        f"Automated analysis: {sub.analysis_status.value}."
    )
    an = latest_analysis(db, sub.id)
    fb: list[str] = []
    if an is not None and an.evaluation:
        ev = an.evaluation
        if ev.get("total") is not None:
            fb.append(f"Automated report score: {ev['total']} (grade {ev.get('grade') or '-'})")
        for c in ev.get("criteria") or []:
            if isinstance(c, dict):
                fb.append(f"- {c.get('key')}: {c.get('points')} — {c.get('explanation') or ''}")
        for s in (ev.get("suggestions") or [])[:5]:
            if isinstance(s, dict):
                fb.append(f"Improve: {s.get('issue')} — " + "; ".join(str(x) for x in (s.get("steps") or [])[:3]))
    if an is not None and an.originality:
        o = an.originality
        fb.append(f"Originality: overlap {o.get('overlap_pct')}%, band {o.get('attention_band')}")
    if sub.evaluation is not None and sub.evaluation.total_score is not None:
        fb.append(f"Verified practical evaluation: {sub.evaluation.total_score} (grade {sub.evaluation.grade})")
        if sub.evaluation.feedback:
            fb.append(f"Supervisor feedback: {sub.evaluation.feedback}")
    if fb:
        sections["feedback"] = redact("\n".join(fb), pii)
    return sections


@router.post("/assistant/ask")
def ask(body: AskIn, user: CurrentUser, db: DB) -> AssistantAnswer:
    if user.role not in (UserRole.student, UserRole.supervisor):
        raise AppError(403, "FORBIDDEN", "You do not have access to this action")
    recent = db.scalar(
        select(func.count())
        .select_from(M.AuditEvent)
        .where(
            M.AuditEvent.actor_id == user.id,
            M.AuditEvent.action == "assistant.asked",
            M.AuditEvent.created_at > datetime.now(UTC) - ASK_WINDOW,
        )
    )
    if (recent or 0) >= ASK_LIMIT:
        raise AppError(429, "RATE_LIMITED", "Too many questions. Try again in a few minutes.")
    a = _allocation_for(db, user, body.allocation_id)
    sections = build_sections(db, a)
    result = assistant.ask(ai_client_factory(), sections, body.question, [t.model_dump() for t in body.history])
    audit.record(db, user.id, "assistant.asked", "allocation", a.id, {"mode": result["mode"]})
    db.commit()
    return AssistantAnswer(**result)
