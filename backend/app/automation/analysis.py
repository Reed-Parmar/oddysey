"""Per-version report analysis (ADR-017): text snapshot → originality → automated report evaluation.

Deterministic originality always runs when text is available, even if AI evaluation is unavailable or
fails. ADR-029: a model failure (rate/token limit, timeout, invalid JSON) is a soft failure: the evaluation
falls back to the deterministic rule-based rubric (`source: "rule"`) in the same run, with no retry loop, so
an analysis never ends `failed` because of the model. The academic outcome (evaluated / rework_requested) is
applied only to the LATEST version, only while it is still `submitted`, and only from a usable analysis
(completed / review_required); rework comes only from a real low AI score or a real originality decision.
"""

import logging
import re
import uuid
from collections.abc import Callable
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app import audit, jobs
from app.ai import default_ai_client
from app.automation import fetch
from app.automation.notify import notify_user
from app.core.config import get_settings
from app.db import models as M
from app.db.enums import AnalysisStatus, CycleStatus, SubmissionStatus
from app.domain import lock_cycle, now_utc, person_key
from spa_ai.documents import ExtractedDocument, binary_hash, extract_document
from spa_ai.llm import AIClient
from spa_ai.originality import PIPELINE_VERSION as ORIGINALITY_VERSION
from spa_ai.originality import AttentionBands, CorpusDoc, analyse
from spa_ai.project_gen import guide_text
from spa_ai.report_eval import REPORT_RUBRIC, ProjectContext, evaluate_report
from spa_ai.resume.extract_text import ResumeParseError

log = logging.getLogger("spa.analysis")

PIPELINE_VERSION = f"analysis-1+{ORIGINALITY_VERSION}"
MAX_EVAL_ATTEMPTS = 3
CORPUS_LIMIT = 500
MIN_TEXT_CHARS = 40

SEMANTIC_NOT_ASSESSED = {
    "status": "not_assessed",
    "reason": "No validated semantic-similarity provider is configured, so paraphrase/concept similarity "
    "was not assessed.",
}
# ADR-028: the only originality wording a trainee ever receives (no percentages, no sources).
ORIGINALITY_REWORK_REASON = (
    "Your report overlaps too much with other sources. Please rewrite it in your own words and resubmit."
)
AI_WRITING_NOT_AVAILABLE = {
    "status": "not_available",
    "reason": "AI-writing assessment not available: no validated detector is configured. The project LLM is never "
    "asked to guess authorship, and fluent writing or overlap alone does not indicate AI generation.",
}

_VIDEO_HOSTS = re.compile(
    r"^https?://(?:[a-z0-9-]+\.)*(?:youtube\.com|youtu\.be|vimeo\.com|instagram\.com|facebook\.com|fb\.watch|"
    r"tiktok\.com|dailymotion\.com)(?:[:/?#]|$)",
    re.IGNORECASE,
)
VIDEO_LINK_REASON = (
    "The report link points to a video or social media page, not a report document. Videos are welcome as "
    "supporting evidence, but the report itself must be a PDF or DOCX file (or a link to one)."
)

# Tests replace this factory with one returning a FakeAIClient.
ai_client_factory: Callable[[], AIClient | None] = default_ai_client


def snapshot_from_bytes(data: bytes, mime: str) -> tuple[ExtractedDocument | None, str | None]:
    """(document, None) or (None, user-facing reason)."""
    try:
        doc = extract_document(data, mime)
    except ResumeParseError:
        return None, "The report file could not be opened (damaged, password-protected or unsupported)."
    if len(doc.text.strip()) < MIN_TEXT_CHARS:
        return None, (
            "No text could be read from the report. It looks like a scanned image; OCR is not available, "
            "so upload a text-based PDF or DOCX."
        )
    return doc, None


def new_analysis_for_file(sub: M.Submission, data: bytes, mime: str) -> M.ReportAnalysis:
    """Built inside the submission request (the bytes are in memory there)."""
    doc, problem = snapshot_from_bytes(data, mime)
    a = M.ReportAnalysis(
        id=uuid.uuid4(),
        submission_id=sub.id,
        revision=1,
        pipeline_version=PIPELINE_VERSION,
        source_type="file",
        binary_hash=binary_hash(data),
    )
    if doc is None:
        a.status, a.status_reason = AnalysisStatus.not_analyzable, problem
    else:
        a.status = AnalysisStatus.queued
        a.text_snapshot, a.page_offsets, a.unit = doc.text, doc.page_offsets, doc.unit
        a.parser, a.input_hash = doc.parser, doc.content_hash
    return a


def _doc(a: M.ReportAnalysis) -> ExtractedDocument:
    return ExtractedDocument(
        text=a.text_snapshot or "",
        page_offsets=list(a.page_offsets or [0]),
        unit=a.unit or "page",
        parser=a.parser or "",
        content_hash=a.input_hash or "",
    )


def _corpus(db: Session, sub: M.Submission, owner: str) -> tuple[list[CorpusDoc], dict[str, Any]]:
    """Internal corpus: latest analysable text of every other submission version (all cycles)."""
    rows = db.execute(
        select(M.ReportAnalysis, M.Submission, M.Trainee, M.Project)
        .join(M.Submission, M.Submission.id == M.ReportAnalysis.submission_id)
        .join(M.Allocation, M.Allocation.id == M.Submission.allocation_id)
        .join(M.Trainee, M.Trainee.id == M.Allocation.trainee_id)
        .join(M.Project, M.Project.id == M.Allocation.project_id)
        .where(M.ReportAnalysis.text_snapshot.isnot(None), M.Submission.id != sub.id)
        .order_by(M.ReportAnalysis.created_at.desc())
        .limit(CORPUS_LIMIT)
    ).all()
    seen: set[uuid.UUID] = set()
    docs: list[CorpusDoc] = []
    for a, s, t, p in rows:
        if s.id in seen:
            continue
        seen.add(s.id)
        docs.append(
            CorpusDoc(
                id=str(s.id),
                owner=person_key(t),
                kind="submission",
                text=a.text_snapshot or "",
                binary_hash=a.binary_hash,
                label=f"{p.project_code} report v{s.version}",
            )
        )
    others = sum(1 for d in docs if d.owner != owner)
    meta = {
        "scope": "Internal submissions stored in this application (all cycles). No internet search; no external "
        "plagiarism service; no reference artifacts are configured.",
        "items": len(docs),
        "other_people_items": others,
        "reference_items": 0,
        "snapshot_at": now_utc().isoformat(),
        "limit": CORPUS_LIMIT,
    }
    return docs, meta


def _shared(project: M.Project) -> list[str]:
    parts = [project.title, project.description or "", project.document_text or ""]
    if project.generated:
        parts.append(guide_text(project.generated))
    return [p for p in parts if p and p.strip()]


def _bands() -> AttentionBands:
    s = get_settings()
    return AttentionBands(version="bands-1", medium_at=s.originality_medium_at, high_at=s.originality_high_at)


@jobs.handler("analyse_submission")
def analyse_submission(db: Session, payload: dict[str, Any]) -> dict[str, Any]:
    sid = uuid.UUID(payload["submission_id"])
    sub = db.get(M.Submission, sid)
    if sub is None:
        return {"skipped": "unknown submission"}
    alloc, trainee, project = sub.allocation, sub.allocation.trainee, sub.allocation.project
    cycle = db.get(M.Cycle, sub.cycle_id)
    if cycle is None or cycle.status == CycleStatus.archived:
        return {"skipped": "cycle archived"}
    a = db.scalar(
        select(M.ReportAnalysis)
        .where(M.ReportAnalysis.submission_id == sid)
        .order_by(M.ReportAnalysis.revision.desc())
        .limit(1)
    )
    if a is None:
        a = M.ReportAnalysis(
            id=uuid.uuid4(),
            submission_id=sid,
            revision=1,
            pipeline_version=PIPELINE_VERSION,
            source_type="url" if sub.report_url else "file",
            status=AnalysisStatus.queued,
        )
        db.add(a)
        db.flush()
    terminal = (
        AnalysisStatus.completed,
        AnalysisStatus.insufficient_evidence,
        AnalysisStatus.review_required,
        AnalysisStatus.not_analyzable,
        AnalysisStatus.failed,
    )
    if a.status in terminal:
        sub.analysis_status = a.status
        db.commit()
        return {"skipped": f"already {a.status.value}"}
    a.attempts += 1
    a.started_at = a.started_at or now_utc()

    # 1. extraction (URL submissions are fetched here; files were snapshotted at upload)
    if a.text_snapshot is None:
        a.status = sub.analysis_status = AnalysisStatus.extracting
        db.commit()
        problem = None
        doc = None
        if sub.report_url and _VIDEO_HOSTS.match(sub.report_url):
            problem = VIDEO_LINK_REASON  # never fetched: a video page has no report text
        elif sub.report_url:
            try:
                data, mime = fetch.report_fetcher(sub.report_url)
                a.binary_hash = binary_hash(data)
                doc, problem = snapshot_from_bytes(data, mime)
            except fetch.FetchError as exc:
                problem = str(exc)
            except Exception:  # noqa: BLE001 - network errors are retryable
                log.warning("report fetch failed submission_id=%s", sid)
                problem = "The report link could not be reached."
                if a.attempts < MAX_EVAL_ATTEMPTS:
                    a.status = sub.analysis_status = AnalysisStatus.retrying
                    a.status_reason = problem
                    db.commit()
                    raise jobs.RetryLater(problem, 120) from None
        else:
            problem = "No analysable report (PDF/DOCX file or report link) is attached to this version."
        if doc is None:
            a.status = sub.analysis_status = AnalysisStatus.not_analyzable
            a.status_reason = problem
            a.finished_at = now_utc()
            _notify(
                db,
                sub,
                trainee,
                project,
                "Your report could not be analysed",
                f"{problem} Your submission was received.",
            )
            db.commit()
            return {"status": "not_analyzable"}
        a.text_snapshot, a.page_offsets, a.unit = doc.text, doc.page_offsets, doc.unit
        a.parser, a.input_hash = doc.parser, doc.content_hash

    # 2. deterministic originality (reused across retries for the same input)
    a.status = sub.analysis_status = AnalysisStatus.analysing
    db.commit()
    owner = person_key(trainee)
    if a.originality is None or a.originality.get("input_hash") != a.input_hash:
        corpus, corpus_meta = _corpus(db, sub, owner)
        result = analyse(
            a.text_snapshot or "", owner, corpus, _shared(project), [], target_binary_hash=a.binary_hash, bands=_bands()
        )
        a.originality = {**result, "input_hash": a.input_hash}
        a.corpus = corpus_meta
        a.semantic = SEMANTIC_NOT_ASSESSED
        a.ai_writing = AI_WRITING_NOT_AVAILABLE
        db.commit()

    # 3. automated document evaluation
    gen = project.generated or {}
    ctx = ProjectContext(
        title=project.title,
        description=project.description,
        deliverables=list(gen.get("deliverables") or []),
        steps=[f"{s.get('title', '')}: {s.get('detail', '')}" for s in gen.get("steps") or []],
    )
    try:
        client = ai_client_factory()
    except Exception:  # noqa: BLE001 - a misconfigured client must not fail the analysis
        log.warning("AI client unavailable for report evaluation submission_id=%s", sid)
        client = None
    ev = evaluate_report(_doc(a), ctx, REPORT_RUBRIC, client)
    if ev.get("source") == "rule":
        # Soft failure (ADR-029): logged without report text, prompts or personal data.
        log.warning(
            "report evaluation used the rule fallback submission_id=%s cause=%s", sid, ev.get("fallback_reason")
        )
    a.evaluation = {**ev, "report_hash": a.input_hash, "evaluator": "automated", "attempts": a.attempts}
    status, reason = {
        "completed": (AnalysisStatus.completed, None),
        "review_required": (AnalysisStatus.review_required, ev.get("status_reason")),
        "insufficient_text": (
            AnalysisStatus.insufficient_evidence,
            ev.get("status_reason") or "The report is too short to evaluate.",
        ),
        "unavailable": (
            AnalysisStatus.review_required,
            "AI evaluation is not configured; a supervisor review is needed.",
        ),
        # Not expected since ADR-029 (model failures fall back to rules); kept as a safe, non-academic outcome.
        "failed": (
            AnalysisStatus.review_required,
            "Automated evaluation was not possible; a supervisor review is needed.",
        ),
    }[ev["status"]]
    # ADR-029: an evaluation stage that produced no usable result never leads to rework (insufficient text,
    # failure); without AI ("unavailable") the deterministic originality decision still applies.
    usable = ev["status"] in ("completed", "review_required", "unavailable")

    # 4. persist + outcome (only on the latest version, only while still submitted, cycle not archived)
    cycle = lock_cycle(db, sub.cycle_id)
    if cycle.status == CycleStatus.archived:
        db.rollback()
        return {"skipped": "cycle archived during analysis"}
    sub = db.scalar(select(M.Submission).where(M.Submission.id == sid).with_for_update(of=M.Submission))
    assert sub is not None
    a.status, a.status_reason, a.finished_at = status, reason, now_utc()
    sub.analysis_status = status
    latest_version = db.scalar(
        select(func.max(M.Submission.version)).where(M.Submission.allocation_id == sub.allocation_id)
    )
    applied = None
    # ADR-026: very high overlap (after the exclusions) or a copied file sends the latest version back for rework.
    # Never on a null overlap (insufficient text); only on the latest version while it is still submitted.
    o = a.originality or {}
    pct = o.get("overlap_pct")
    dup = o.get("exact_duplicates") or {}
    copied = bool(dup.get("binary_other_person") or dup.get("normalized_other_person"))
    threshold = get_settings().originality_rework_at
    if (
        usable  # ADR-029: never send work back from an analysis that did not complete
        and (copied or (pct is not None and pct >= threshold))
        and sub.version == latest_version
        and sub.status == SubmissionStatus.submitted
    ):
        sub.status = SubmissionStatus.rework_requested
        a.review_state = "rework_requested"
        a.originality = {
            **o,
            "decision": {
                "action": "auto_rework",
                "reason": "copied_file" if copied else "overlap_above_threshold",
                "overlap_pct": pct,
                "threshold": threshold,
                "at": now_utc().isoformat(),
            },
        }
        applied = "rework_originality"
        audit.record(
            db,
            None,
            "submission.auto_rework_originality",
            "submission",
            sub.id,
            {"actor": "system", "overlap_pct": pct, "threshold": threshold, "copied_file": copied},
        )
    if (
        applied is None
        and ev.get("total") is not None
        and ev.get("outcome") in ("evaluated", "rework_requested")
        and status == AnalysisStatus.completed
        and sub.version == latest_version
        and sub.status == SubmissionStatus.submitted
    ):
        sub.status = SubmissionStatus(ev["outcome"])
        applied = ev["outcome"]
        audit.record(
            db,
            None,
            "submission.auto_evaluated",
            "submission",
            sub.id,
            {"actor": "system", "outcome": applied, "total": ev["total"], "rubric": ev.get("rubric_version")},
        )
    if applied == "rework_originality":
        # ADR-028: the trainee never sees overlap figures or sources; staff have the detailed report.
        _notify(
            db,
            sub,
            trainee,
            project,
            f"Version {sub.version}: please revise for originality",
            f"{ORIGINALITY_REWORK_REASON} Open My Project to submit a new version.",
        )
    elif applied == "evaluated":
        _notify(
            db,
            sub,
            trainee,
            project,
            f"Version {sub.version} evaluated: grade {ev['grade']}",
            "Your report was evaluated automatically. Open My Project for the scores, evidence and improvement steps.",
        )
    elif applied == "rework_requested":
        _notify(
            db,
            sub,
            trainee,
            project,
            f"Version {sub.version}: rework requested",
            "Your report needs more work. Open My Project for what is missing and how to improve it.",
        )
    elif status != AnalysisStatus.completed:
        _notify(
            db,
            sub,
            trainee,
            project,
            f"Version {sub.version} is awaiting review",
            "Your report was received and checked; a supervisor will review it.",
        )
    if project.supervisor is not None:
        if a.originality:
            # ADR-026 as amended by ADR-028: the detailed report goes to the project's supervisor only; with
            # EMAIL_BACKEND=smtp it is emailed with the PDF attached (built when sent).
            notify_user(
                db,
                project.supervisor,
                "originality.report",
                f"Report analysed: {project.project_code} v{sub.version} (plagiarism report)",
                "A submitted report has a new automated evaluation and a Plagiarism & Originality Report. It lists "
                "every matched passage and highlights the matched words.",
                f"/supervisor/submissions/{sub.id}",
                f"originality.report:{a.id}",
            )
        else:
            notify_user(
                db,
                project.supervisor,
                "submission.analysed",
                f"Report analysed: {project.project_code} v{sub.version}",
                "A submitted report has a new automated evaluation.",
                f"/supervisor/submissions/{sub.id}",
                f"submission.analysed.sup:{a.id}",
            )
    db.commit()
    del alloc
    return {"status": status.value, "outcome": applied}


def _notify(db: Session, sub: M.Submission, trainee: M.Trainee, project: M.Project, subject: str, body: str) -> None:
    notify_user(
        db,
        trainee.user,
        "submission.analysis",
        subject,
        body,
        "/student/project",
        f"submission.analysis:{sub.id}:{subject[:40]}",
    )
    del project
