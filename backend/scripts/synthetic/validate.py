"""Validate a generated dataset from its files alone and write ``validation_report.json``.

The checks rebuild scorer inputs from the CSVs and re-score every candidate pair with the production
scorer, then re-check the allocation invariants independently of the generator's in-memory state.
Critical failures make the CLI exit non-zero.

    uv run python -m scripts.synthetic.validate ../data/synthetic
"""

from __future__ import annotations

import csv
import json
import statistics
import sys
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any

from app.automation.allocation import waiting_reason
from scripts.synthetic import GENERATOR_VERSION, catalog
from scripts.synthetic.llm import validate_example
from scripts.synthetic.reference import load_reference
from scripts.synthetic.submissions import RUBRIC
from spa_ai.report_eval import grade_for
from spa_ai.scoring import ProjectInput, TraineeInput, score_pair

MAX_LISTED = 25


class Report:
    def __init__(self) -> None:
        self.critical: dict[str, list[str]] = defaultdict(list)
        self.warnings: list[str] = []
        self.checks: dict[str, int] = Counter()

    def check(self, name: str, ok: bool, detail: str = "") -> None:
        self.checks[name] += 1
        if not ok:
            bucket = self.critical[name]
            if len(bucket) < MAX_LISTED:
                bucket.append(detail)
            else:
                self.checks[f"{name}__more_failures"] += 1


def read_csv(path: Path) -> list[dict[str, str]]:
    with path.open(encoding="utf-8", newline="") as f:
        return list(csv.DictReader(f))


def fnum(v: str) -> float | None:
    return None if v == "" else float(v)


def fbool(v: str) -> bool:
    return v == "true"


def trainee_input(r: dict[str, str]) -> TraineeInput:
    ids, names = json.loads(r["trade_ids"]), json.loads(r["trade_names"])
    return TraineeInput(
        id=r["trainee_id"],
        trade_id=ids[0],
        trade_name=names[0],
        theory=fnum(r["theory_score"]),
        practical=fnum(r["practical_score"]),
        safety=fnum(r["safety_score"]),
        skills=tuple(json.loads(r["skills"])),
        career_interest=r["career_interest"] or None,
        background=r["background"] or None,
        trade_ids=tuple(ids),
        trade_names=tuple(names),
    )


def project_input(r: dict[str, str]) -> ProjectInput:
    ids, names = json.loads(r["target_trade_ids"]), json.loads(r["target_trade_names"])
    return ProjectInput(
        id=r["project_id"],
        project_code=r["project_code"],
        title=r["title"],
        category=r["category"] or None,
        description=r["description"] or None,
        difficulty=r["difficulty"],
        target_trade_id=ids[0],
        target_trade_name=names[0],
        min_practical_score=float(r["min_practical_score"]),
        skills=tuple(json.loads(r["required_skills"])),
        target_trade_ids=tuple(ids),
        target_trade_names=tuple(names),
        min_match_score=float(r["min_match_score"]),
    )


def _dist(values: list[float]) -> dict[str, float] | None:
    if not values:
        return None
    q = statistics.quantiles(values, n=4) if len(values) > 1 else [values[0]] * 3
    return {
        "n": len(values),
        "mean": round(statistics.fmean(values), 2),
        "min": min(values),
        "p25": round(q[0], 2),
        "median": round(q[1], 2),
        "p75": round(q[2], 2),
        "max": max(values),
    }


def validate(out: Path, workbook: Path | None = None) -> dict[str, Any]:
    rep = Report()
    manifest = json.loads((out / "manifest.json").read_text(encoding="utf-8"))
    files = manifest["files"]
    rows_per_file: dict[str, int] = {}
    for rel, meta in files.items():
        path = out / rel
        rep.check("file_exists", path.is_file(), rel)
        if rel.endswith(".csv") and path.is_file() and not rel.startswith("import/"):
            rows_per_file[rel] = len(read_csv(path))
            rep.check("manifest_row_count", rows_per_file[rel] == meta["rows"], rel)
        elif rel.endswith(".jsonl") and path.is_file():
            rows_per_file[rel] = sum(1 for _ in path.open(encoding="utf-8"))

    T = read_csv(out / "trainees.csv")
    P = read_csv(out / "projects.csv")
    S = read_csv(out / "scenarios.csv")
    SP = read_csv(out / "scenario_projects.csv")
    CP = read_csv(out / "candidate_pairs.csv")
    REC = read_csv(out / "recommendations.csv")
    AL = read_csv(out / "allocations.csv")
    RJ = read_csv(out / "rejections.csv")
    RES = read_csv(out / "allocation_results.csv")

    # ------------------------------------------------ synthetic marking, ids, ranges
    for name, rows in (
        ("trainees", T),
        ("projects", P),
        ("scenarios", S),
        ("scenario_projects", SP),
        ("candidate_pairs", CP),
        ("recommendations", REC),
        ("allocations", AL),
        ("rejections", RJ),
        ("allocation_results", RES),
    ):
        rep.check("synthetic_record_marked", all(r["synthetic_record"] == "true" for r in rows), name)
    t_ids = [r["trainee_id"] for r in T]
    rep.check("unique_trainee_ids", len(t_ids) == len(set(t_ids)), "duplicate trainee ids")
    rep.check("unique_project_ids", len({r["project_id"] for r in P}) == len(P), "duplicate project ids")
    rep.check("unique_project_codes", len({r["project_code"] for r in P}) == len(P), "duplicate project codes")
    trades = {t.id for t in catalog.TRADES}
    t_by = {r["trainee_id"]: r for r in T}
    p_by = {r["project_id"]: r for r in P}
    code_to_pid = {r["project_code"]: r["project_id"] for r in P}
    for r in T:
        tid = r["trainee_id"]
        rep.check("valid_trade_reference", set(json.loads(r["trade_ids"])) <= trades, tid)
        marks = [fnum(r[k]) for k in ("theory_score", "practical_score", "safety_score")]
        rep.check("score_range", all(m is None or 0 <= m <= 100 for m in marks), tid)
        complete = all(m is not None for m in marks)
        rep.check(
            "assessment_status_consistent",
            (r["assessment_status"] == "complete") == complete
            and int(r["marks_on_record"]) == sum(m is not None for m in marks),
            tid,
        )
        rep.check("required_fields", bool(r["career_interest"] and json.loads(r["skills"])), tid)
    for r in P:
        pid = r["project_id"]
        rep.check("valid_trade_reference", set(json.loads(r["target_trade_ids"])) <= trades, pid)
        rep.check(
            "project_fields",
            r["difficulty"] in ("beginner", "intermediate", "advanced")
            and 0 <= float(r["min_practical_score"]) <= 100
            and 1 <= int(r["legacy_max_trainees"]) <= 10
            and r["catalog_status"] in ("draft", "published", "archived")
            and bool(json.loads(r["required_skills"])),
            pid,
        )

    # ------------------------------------------------ privacy: nothing copied from the reference data
    if workbook is not None and workbook.is_file():
        ref = load_reference(workbook)
        names = ref.personal_names
        rep.check("no_reference_names", not any(r["full_name"].lower() in names for r in T), "reference name reused")
        ids = ref.identifiers
        rep.check("no_reference_ids", not ({*t_ids, *(r["project_code"] for r in P)} & ids), "reference id reused")
    else:
        rep.warnings.append("reference workbook not available: reference-copy checks skipped")

    # ------------------------------------------------ splits
    scen = {r["scenario_id"]: r for r in S}
    split_of = {sid: r["split"] for sid, r in scen.items()}
    rep.check("splits_match_manifest", split_of == manifest["splits"]["scenarios"], "scenario split mismatch")
    for r in CP:
        sid = r["scenario_id"]
        rep.check(
            "pair_split_consistent",
            r["split"] == split_of.get(sid)
            and t_by[r["trainee_id"]]["home_split"] == r["split"]
            and p_by[r["project_id"]]["home_split"] == r["split"],
            f"{sid}/{r['trainee_id']}/{r['project_id']}",
        )

    # ------------------------------------------------ candidate pairs: FK, uniqueness, engine agreement
    t_in = {tid: trainee_input(r) for tid, r in t_by.items()}
    p_in = {pid: project_input(r) for pid, r in p_by.items()}
    sp = {(r["scenario_id"], r["project_id"]): r for r in SP}
    seen: set[tuple[str, str, str]] = set()
    by_st: dict[tuple[str, str], list[dict[str, str]]] = defaultdict(list)
    reason_counts: Counter[str] = Counter()
    scores: dict[str, list[float]] = defaultdict(list)
    for r in CP:
        key = (r["scenario_id"], r["trainee_id"], r["project_id"])
        tag = "/".join(key)
        rep.check(
            "pair_foreign_keys", key[0] in scen and key[1] in t_by and key[2] in p_by and (key[0], key[2]) in sp, tag
        )
        rep.check("no_duplicate_pairs", key not in seen, tag)
        seen.add(key)
        ps = score_pair(t_in[key[1]], p_in[key[2]])
        total = float(r["total_compatibility_score"])
        factor_sum = sum(float(r[c]) for c in r if c.startswith("factor_") and r[c] != "")
        rep.check("factor_sum_equals_score", abs(round(factor_sum, 2) - total) < 0.005, tag)
        rep.check(
            "rescored_matches_engine",
            abs(ps.score - total) < 1e-9
            and ps.eligible == fbool(r["scorer_eligible"])
            and ps.ineligible_reasons == json.loads(r["scorer_reasons"])
            and ps.mode == r["score_mode"],
            tag,
        )
        alloc_ok = fbool(sp[(key[0], key[2])]["allocatable"]) if (key[0], key[2]) in sp else False
        rep.check(
            "eligibility_label_consistent",
            fbool(r["eligible"]) == (ps.eligible and alloc_ok) and fbool(r["project_allocatable"]) == alloc_ok,
            tag,
        )
        for reason in json.loads(r["ineligible_reasons"]):
            reason_counts[reason] += 1
        scores[r["score_mode"]].append(total)
        by_st[(key[0], key[1])].append(r)

    # ranks: contiguous over allocatable projects, eligible first, score desc, then project code
    for (sid, tid), rows in by_st.items():
        ranked = sorted((r for r in rows if r["recommendation_rank"]), key=lambda r: int(r["recommendation_rank"]))
        expect = sorted(
            (r for r in rows if fbool(r["project_allocatable"])),
            key=lambda r: (not fbool(r["scorer_eligible"]), -float(r["total_compatibility_score"]), r["project_code"]),
        )
        rep.check(
            "recommendation_ranks_valid",
            [r["project_id"] for r in ranked] == [r["project_id"] for r in expect]
            and [int(r["recommendation_rank"]) for r in ranked] == list(range(1, len(ranked) + 1)),
            f"{sid}/{tid}",
        )
    for r in REC:
        pair = next((x for x in by_st[(r["scenario_id"], r["trainee_id"])] if x["project_id"] == r["project_id"]), None)
        rep.check(
            "recommendations_match_pairs",
            pair is not None
            and pair["recommendation_rank"] == r["rank"]
            and float(pair["total_compatibility_score"]) == float(r["score"]),
            f"{r['scenario_id']}/{r['trainee_id']}/{r['rank']}",
        )

    # ------------------------------------------------ allocations and the ADR-017 rules
    active: Counter[tuple[str, str]] = Counter()
    rejections_by: dict[tuple[str, str], list[dict[str, str]]] = defaultdict(list)
    for r in RJ:
        rejections_by[(r["scenario_id"], r["trainee_id"])].append(r)
    alloc_by_id = {r["allocation_id"]: r for r in AL}
    ready_by_s: dict[str, list[str]] = defaultdict(list)
    for x in SP:
        if fbool(x["allocatable"]):
            ready_by_s[x["scenario_id"]].append(x["project_id"])
    for a in AL:
        sid, tid, pid = a["scenario_id"], a["trainee_id"], a["project_id"]
        tag = a["allocation_id"]
        if a["status"] == "active":
            active[(sid, tid)] += 1
        rep.check("allocation_project_allocatable", fbool(sp[(sid, pid)]["allocatable"]), tag)
        ps = score_pair(t_in[tid], p_in[pid], a["match_mode"])  # replacements keep the pool-mode score
        rep.check("allocation_project_eligible", ps.eligible and abs(ps.score - float(a["match_score"])) < 1e-9, tag)
        prior = [x for x in rejections_by[(sid, tid)] if int(x["event_seq"]) < int(a["event_seq"])]
        excluded = {x["project_id"] for x in prior}
        rep.check("no_allocation_after_rejection", pid not in excluded, tag)
        if a["assignment_kind"] == "best_eligible":
            allowed_scores = [score_pair(t_in[tid], p_in[q]) for q in ready_by_s[sid] if q not in excluded]
            best = max((x.score for x in allowed_scores if x.eligible), default=None)
            rep.check("best_eligible_is_optimal", best is not None and abs(best - ps.score) < 1e-9, tag)
    rep.check("one_active_allocation_per_trainee", all(v == 1 for v in active.values()), "multiple active allocations")
    for r in RJ:
        tag = r["rejection_id"]
        rejected = alloc_by_id.get(r["allocation_id"])
        rep.check(
            "rejection_references_rejected_allocation",
            rejected is not None and rejected["status"] == "rejected" and rejected["trainee_id"] == r["trainee_id"],
            tag,
        )
        if r["replacement_status"] == "completed":
            rep_alloc = alloc_by_id.get(r["replacement_allocation_id"])
            snap = json.loads(r["ranking_snapshot"])
            rep.check(
                "replacement_consistent",
                rep_alloc is not None
                and rep_alloc["assignment_kind"] == "replacement"
                and rep_alloc["project_id"] == r["project_id"]
                and rep_alloc["trainee_id"] == r["selected_trainee_id"]
                and r["selected_rank"] == "1"
                and bool(snap)
                and snap[0]["trainee_id"] == r["selected_trainee_id"],
                tag,
            )

    # ------------------------------------------------ allocation results
    unalloc_reasons: Counter[str] = Counter()
    sources: Counter[str] = Counter()
    fairness: dict[str, Counter[str]] = defaultdict(Counter)
    actives = {(a["scenario_id"], a["trainee_id"]): a for a in AL if a["status"] == "active"}
    for r in RES:
        sid, tid = r["scenario_id"], r["trainee_id"]
        tag = f"{sid}/{tid}"
        active_row = actives.get((sid, tid))
        assigned = fbool(r["assigned"])
        rep.check(
            "result_matches_allocations",
            assigned == (active_row is not None)
            and (
                active_row is None
                or (
                    active_row["project_id"] == r["assigned_project_id"]
                    and active_row["allocation_id"] == r["allocation_id"]
                )
            ),
            tag,
        )
        rep.check("unallocated_reason_iff_unassigned", assigned != bool(r["unallocated_reason"]), tag)
        excluded = {x["project_id"] for x in rejections_by[(sid, tid)]}
        allowed = [p_in[q] for q in sorted(ready_by_s[sid], key=lambda q: p_by[q]["project_code"]) if q not in excluded]
        if not assigned:
            rep.check(
                "unallocated_has_no_eligible_project", not any(score_pair(t_in[tid], p).eligible for p in allowed), tag
            )
            rep.check(
                "unallocated_reason_matches_engine",
                waiting_reason(t_in[tid], allowed, bool(excluded)) == r["unallocated_reason"],
                tag,
            )
            unalloc_reasons[r["unallocated_reason"]] += 1
        rep.check("why_not_best_known", r["why_not_best_individual"] != "other", tag)
        sources[r["assignment_source"]] += 1
        fairness[t_by[tid]["gender"] or "undisclosed"]["assigned" if assigned else "unassigned"] += 1
    rep.check("results_cover_cohorts", len(RES) == len(by_st), "results do not cover every enrolled trainee")

    # ------------------------------------------------ submissions and evaluations
    sub_stats: dict[str, Any] = {}
    if (out / "submissions.csv").is_file():
        SUB = read_csv(out / "submissions.csv")
        EV = read_csv(out / "evaluations.csv")
        ev_by_sub = {e["submission_id"]: e for e in EV}
        rep.check("unique_evaluation_per_submission", len(ev_by_sub) == len(EV), "duplicate evaluation")
        versions: dict[str, list[int]] = defaultdict(list)
        for s in SUB:
            sa = alloc_by_id.get(s["allocation_id"])
            tag = s["submission_id"]
            rep.check(
                "submission_foreign_keys",
                sa is not None
                and sa["status"] == "active"
                and sa["trainee_id"] == s["trainee_id"]
                and sa["project_id"] == s["project_id"],
                tag,
            )
            deadline = scen[s["scenario_id"]]["submission_deadline"]
            rep.check("submission_timeline", sa is not None and sa["created_at"] < s["submitted_at"] < deadline, tag)
            versions[s["allocation_id"]].append(int(s["version"]))
            ev = ev_by_sub.get(s["submission_id"])
            rep.check(
                "submission_status_consistent",
                (ev is None and s["status"] == "submitted") or (ev is not None and ev["outcome"] == s["status"]),
                tag,
            )
            if ev is not None:
                rep.check("evaluation_after_submission", ev["evaluated_at"] > s["submitted_at"], ev["evaluation_id"])
        for alloc_id, vs in versions.items():
            rep.check("submission_versions_sequential", vs == list(range(1, len(vs) + 1)), alloc_id)
        sub_ids = {s["submission_id"] for s in SUB}
        for e in EV:
            tag = e["evaluation_id"]
            rep.check("evaluation_foreign_key", e["submission_id"] in sub_ids, tag)
            parts = [int(e[col]) for col, _ in RUBRIC]
            rep.check("rubric_ranges", all(0 <= v <= mx for v, (_, mx) in zip(parts, RUBRIC, strict=True)), tag)
            rep.check("total_is_sum", sum(parts) == int(e["total_score"]), tag)
            rep.check("grade_mapping", grade_for(int(e["total_score"])) == e["grade"], tag)
        sub_stats = {
            "submissions": len(SUB),
            "evaluations": len(EV),
            "status": dict(Counter(s["status"] for s in SUB)),
            "grades": dict(sorted(Counter(e["grade"] for e in EV).items())),
            "total_score": _dist([float(e["total_score"]) for e in EV]),
        }

    # ------------------------------------------------ LLM examples
    known_codes = set(code_to_pid)
    llm_counts: dict[str, dict[str, int]] = defaultdict(dict)
    for rel in files:
        if not rel.startswith("llm/"):
            continue
        task, split = rel.split("/")[1], rel.split("/")[2].removesuffix(".jsonl")
        n = 0
        with (out / rel).open(encoding="utf-8") as f:
            for line_no, line in enumerate(f, start=1):
                n += 1
                try:
                    ex = json.loads(line)
                except ValueError:
                    rep.check("jsonl_well_formed", False, f"{rel}:{line_no}")
                    continue
                rep.check("jsonl_well_formed", True)
                for err in validate_example(ex, known_codes):
                    rep.check("llm_example_valid", False, f"{rel}:{line_no}: {err}")
                rep.check("llm_example_valid", True)
                rep.check(
                    "llm_split_consistent",
                    ex.get("split") == split
                    and ex.get("task") == task
                    and split_of.get(ex.get("scenario_id")) == split,
                    f"{rel}:{line_no}",
                )
        llm_counts[task][split] = n

    # ------------------------------------------------ summary statistics
    allocatable = [x for x in SP if fbool(x["allocatable"])]
    working = [int(x["trainees_working_individually"]) for x in allocatable]
    eligible_counts = Counter((r["scenario_id"], r["trainee_id"]) for r in CP if fbool(r["eligible"]))
    pair_split = Counter(r["split"] for r in CP)
    scen_split = Counter(r["split"] for r in S)
    if scen_split.get("test", 0) < 5 or pair_split.get("test", 0) < 2000:
        rep.warnings.append(
            f"test split is small ({scen_split.get('test', 0)} scenarios, {pair_split.get('test', 0)} "
            "pairs): metrics on it will be noisy"
        )
    missing = {
        c: round(sum(1 for r in T if r[c] == "") / len(T), 4)
        for c in ("theory_score", "practical_score", "safety_score", "background", "gender")
    }
    total_checks = sum(v for k, v in rep.checks.items() if not k.endswith("__more_failures"))
    failed = {k: v for k, v in rep.critical.items() if v}
    report = {
        "generator_version": manifest["generator_version"],
        "validator_version": GENERATOR_VERSION,
        "seed": manifest["seed"],
        "passed": not failed,
        "checks_run": total_checks,
        "check_names": sorted(k for k in rep.checks if not k.endswith("__more_failures")),
        "critical_failures": failed,
        "warnings": rep.warnings,
        "rows_per_file": rows_per_file,
        "unique": {
            "trainees": len(T),
            "projects": len(P),
            "scenarios": len(S),
            "trainees_in_any_scenario": len({r["trainee_id"] for r in RES}),
            "projects_in_any_scenario": len({r["project_id"] for r in SP}),
            "trade_combinations": len({(r["trade_names"],) for r in T}),
            "trade_category_combinations": len(
                {(p_by[x["project_id"]]["target_trade_names"], p_by[x["project_id"]]["domain"]) for x in SP}
            ),
        },
        "eligibility": {
            "pairs": len(CP),
            "eligible_pairs": sum(1 for r in CP if fbool(r["eligible"])),
            "scorer_eligible_pairs": sum(1 for r in CP if fbool(r["scorer_eligible"])),
            "ineligible_reason_counts": dict(reason_counts.most_common()),
            "trainees_eligible_for_exactly_one_project": sum(1 for v in eligible_counts.values() if v == 1),
            "trainees_with_no_eligible_project": len(by_st) - len(eligible_counts),
            "allocatable_projects_with_no_eligible_trainee": sum(
                1 for x in allocatable if x["eligible_trainees"] == "0"
            ),
        },
        "allocation": {
            "trainee_scenario_rows": len(RES),
            "assigned": sum(1 for r in RES if fbool(r["assigned"])),
            "unallocated": sum(1 for r in RES if not fbool(r["assigned"])),
            "assignment_source": dict(sources),
            "unallocated_reasons": dict(unalloc_reasons.most_common()),
            "assignment_differs_from_best_individual": sum(
                1 for r in RES if fbool(r["assigned"]) and not fbool(r["assignment_matches_best_individual"])
            ),
            "rejections": len(RJ),
            "replacement_status": dict(Counter(r["replacement_status"] for r in RJ)),
        },
        "project_utilization": {
            "allocatable_project_slots": len(allocatable),
            "trainees_working_individually": _dist([float(w) for w in working]),
            "allocatable_projects_unused": sum(1 for w in working if w == 0),
        },
        "score_distribution": {mode: _dist(v) for mode, v in scores.items()},
        "missing_value_rates_trainees": missing,
        "fairness_reporting_only": {
            g: {**c, "assigned_rate": round(c["assigned"] / max(1, sum(c.values())), 4)}
            for g, c in sorted(fairness.items())
        },
        "splits": {
            "scenarios": dict(scen_split),
            "candidate_pairs": dict(pair_split),
            "llm_examples": {k: dict(v) for k, v in llm_counts.items()},
        },
        "submissions": sub_stats,
    }
    (out / "validation_report.json").write_text(
        json.dumps(report, indent=2, ensure_ascii=False) + "\n", encoding="utf-8", newline="\n"
    )
    return report


def main(argv: list[str] | None = None) -> int:
    import argparse

    ap = argparse.ArgumentParser(description="Validate a generated synthetic dataset")
    ap.add_argument("dir", type=Path)
    ap.add_argument(
        "--workbook", type=Path, default=Path(__file__).resolve().parents[3] / "CSR_Hackathon_ITI_Project_Dataset.xlsx"
    )
    args = ap.parse_args(argv)
    if not (args.dir / "manifest.json").is_file():
        print(f"error: {args.dir} has no manifest.json")
        return 2
    report = validate(args.dir, args.workbook)
    print(f"validation: {'PASSED' if report['passed'] else 'FAILED'} ({report['checks_run']} checks)")
    for name, items in report["critical_failures"].items():
        print(f"  {name}: {items[:3]}")
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    sys.exit(main())
