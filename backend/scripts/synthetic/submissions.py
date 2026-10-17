"""Synthetic submissions and verified practical evaluations for final (active) allocations.

The rubric is the dataset's five criteria (app.evaluations: 25/25/15/15/20). Totals are summed from the
components and grades use ``spa_ai.report_eval.grade_for``, which has the same bands as the generated
``grade`` column in migration 0001 (88/80/75/65/50). Rubric quality is driven by the trainee's verified
marks plus noise, never by the match score, so outcomes are not a relabelled copy of compatibility.
"""

from __future__ import annotations

from datetime import datetime, timedelta
from typing import Any

from app.db.enums import GRADE_LABELS
from scripts.synthetic.entities import SynthProject, SynthTrainee, rng
from scripts.synthetic.scenarios import Scenario, iso
from spa_ai.report_eval import grade_for

RUBRIC = (
    ("score_workmanship", 25),
    ("score_functional_demo", 25),
    ("score_safety_sop", 15),
    ("score_documentation", 15),
    ("score_viva", 20),
)
REWORK_BELOW = 50  # same threshold the automated report evaluation uses (spa_ai.report_eval.REWORK_BELOW)
HOURS = {"beginner": (20, 32), "intermediate": (26, 40), "advanced": (32, 48)}
FEEDBACK = {
    "evaluated": (
        "Work meets the brief; keep the logbook entries as detailed as this.",
        "Good workmanship. Add measured test results to the report next time.",
        "Clear demonstration and safe working practice throughout.",
    ),
    "rework_requested": (
        "Functional demo incomplete: please fix the wiring faults and resubmit with test readings.",
        "Safety checklist missing and joints need rework; resubmit after correction.",
    ),
}


def _rubric(r: Any, t: SynthTrainee, bump: float = 0.0) -> dict[str, int]:
    marks = [m for m in (t.practical, t.theory, t.safety) if m is not None]
    base = sum(marks) / len(marks) if marks else 70.0
    quality = min(1.0, max(0.0, (base - 45) / 55))
    out = {}
    for col, mx in RUBRIC:
        frac = min(1.0, max(0.15, r.gauss(0.28 + 0.62 * quality + bump, 0.12)))
        out[col] = int(round(mx * frac))
    return out


def build(
    seed: int, scenarios: list[Scenario], trainees: dict[str, SynthTrainee], projects: dict[str, SynthProject]
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    subs: list[dict[str, Any]] = []
    evals: list[dict[str, Any]] = []
    for sc in scenarios:
        assert sc.state is not None
        r = rng(seed, f"submissions:{sc.index}")
        for a in sorted((a for a in sc.state.allocations if a.status == "active"), key=lambda a: a.allocation_id):
            if r.random() >= 0.65:
                continue  # not submitted (yet)
            t, p = trainees[a.trainee_id], projects[a.project_id]
            allocated = datetime.fromisoformat(a.at)
            submitted = allocated + timedelta(days=r.randint(18, 40), hours=r.randint(0, 8))
            version = 1
            bump = 0.0
            while True:
                sub_id = f"SYN-SUB-{len(subs) + 1:06d}"
                lo, hi = HOURS[p.difficulty]
                hours = round(r.uniform(lo, hi) * (1.1 if version > 1 else 1.0), 1)
                bom = (
                    0
                    if "CP" == p.trade_codes[0] and r.random() < 0.6
                    else round(r.uniform(300, 1500 if p.difficulty == "beginner" else 4000), -1)
                )
                row = {
                    "submission_id": sub_id,
                    "scenario_id": sc.scenario_id,
                    "allocation_id": a.allocation_id,
                    "trainee_id": t.trainee_id,
                    "project_id": p.project_id,
                    "version": version,
                    "submitted_at": iso(submitted),
                    "report_url": f"https://synthetic.invalid/reports/{sub_id}.pdf",
                    "video_url": f"https://synthetic.invalid/videos/{sub_id}.mp4" if r.random() < 0.4 else None,
                    "logbook_hours": hours,
                    "bom_cost_inr": bom,
                    "status": "submitted",
                    "synthetic_record": True,
                }
                subs.append(row)
                if r.random() < 0.12:
                    break  # awaiting evaluation
                scores = _rubric(r, t, bump)
                total = sum(scores.values())
                outcome = "rework_requested" if total < REWORK_BELOW else "evaluated"
                evaluated = submitted + timedelta(days=r.randint(2, 9))
                grade = grade_for(total)
                evals.append(
                    {
                        "evaluation_id": f"SYN-EVL-{len(evals) + 1:06d}",
                        "submission_id": sub_id,
                        "scenario_id": sc.scenario_id,
                        "evaluated_at": iso(evaluated),
                        "outcome": outcome,
                        **scores,
                        "total_score": total,
                        "grade": grade,
                        "grade_label": GRADE_LABELS[grade],
                        "feedback": r.choice(FEEDBACK[outcome]),
                        "rubric": "verified_practical_rubric",
                        "synthetic_record": True,
                    }
                )
                row["status"] = outcome
                next_at = evaluated + timedelta(days=r.randint(5, 12))
                if outcome != "rework_requested" or next_at >= sc.deadline or version >= 3:
                    break
                version += 1
                submitted = next_at
                bump = 0.12 * (version - 1)
    return subs, evals
