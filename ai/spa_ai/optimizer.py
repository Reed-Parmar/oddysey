"""ILP allocation optimiser (ADR-027): who goes where, over a whole batch at once.

Pure library. Every candidate pair is already scored and eligible (`spa_ai.scoring.score_pair`); the optimiser
never changes a score, so each allocation keeps its itemised factors and Σ factor points = score. It only
chooses the project, maximising

    Σ match score  −  project_penalty · Σ (trainees above a project's fair share)
                   −  supervisor_penalty · Σ (trainees above a supervisor's fair share)

subject to: each trainee gets exactly one of their eligible projects. Fair shares are soft (ADR-017 has no
capacity), so nobody is ever left waiting because of them: a trainee moves off their best project only when
that project (or its supervisor) is over its share AND the next project costs fewer points than the penalty.
Solved with scipy's MILP (HiGHS). If scipy is missing, the model is too large, or the solver fails, the
result is the greedy rule (each trainee's best project), which is also reported for comparison.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field

from spa_ai.scoring import PairScore

OPTIMIZER_VERSION = "ilp-1"
MAX_VARIABLES = 250_000  # beyond this, use greedy (keeps worker memory bounded)


@dataclass(frozen=True)
class Balance:
    project_slack: float = 1.25  # fair share = ceil(slack × trainees / projects)
    supervisor_slack: float = 1.25
    project_penalty: float = 8.0  # match points given up, at most, to move one trainee off an over-full project
    supervisor_penalty: float = 5.0
    time_limit_s: float = 20.0


@dataclass
class Plan:
    choice: dict[str, PairScore]  # trainee key -> chosen pair
    engine: str  # "ilp" | "greedy"
    reason: str | None  # why greedy was used, when it was
    objective: float
    greedy_objective: float
    total_score: float
    greedy_total_score: float
    moved: dict[str, PairScore] = field(default_factory=dict)  # trainee key -> their best (not chosen) pair
    project_cap: int = 0
    supervisor_cap: int = 0

    def summary(self) -> dict[str, object]:
        return {
            "engine": self.engine,
            "version": OPTIMIZER_VERSION,
            "fallback_reason": self.reason,
            "objective": round(self.objective, 2),
            "greedy_objective": round(self.greedy_objective, 2),
            "total_score": round(self.total_score, 2),
            "greedy_total_score": round(self.greedy_total_score, 2),
            "moved_from_best": len(self.moved),
            "project_fair_share": self.project_cap,
            "supervisor_fair_share": self.supervisor_cap,
        }


def fair_share(total: int, bins: int, slack: float) -> int:
    return max(1, math.ceil(slack * total / bins)) if bins else total


def _penalised(
    choice: dict[str, PairScore],
    project_load: dict[str, int],
    supervisor_of: dict[str, str | None],
    supervisor_load: dict[str, int],
    pcap: int,
    scap: int,
    bal: Balance,
) -> float:
    pl = dict(project_load)
    sl = dict(supervisor_load)
    for ps in choice.values():
        pl[ps.project_id] = pl.get(ps.project_id, 0) + 1
        sup = supervisor_of.get(ps.project_id)
        if sup:
            sl[sup] = sl.get(sup, 0) + 1
    # overflow only counts trainees placed in this batch beyond the share (existing load is sunk)
    over_p = sum(max(0, pl[p] - max(pcap, project_load.get(p, 0))) for p in pl)
    over_s = sum(max(0, sl[s] - max(scap, supervisor_load.get(s, 0))) for s in sl)
    return sum(ps.score for ps in choice.values()) - bal.project_penalty * over_p - bal.supervisor_penalty * over_s


def optimise(
    options: dict[str, list[PairScore]],
    project_load: dict[str, int] | None = None,
    supervisor_of: dict[str, str | None] | None = None,
    supervisor_load: dict[str, int] | None = None,
    n_projects: int | None = None,
    balance: Balance | None = None,
) -> Plan:
    """`options`: trainee key -> scored pairs (ineligible ones are ignored). Loads count active allocations."""
    bal = balance or Balance()
    project_load = project_load or {}
    supervisor_of = supervisor_of or {}
    supervisor_load = supervisor_load or {}
    elig = {
        k: sorted((ps for ps in v if ps.eligible), key=lambda ps: (-ps.score, ps.project_code))
        for k, v in options.items()
    }
    elig = {k: v for k, v in elig.items() if v}
    greedy = {k: v[0] for k, v in elig.items()}
    projects = {ps.project_id for v in elig.values() for ps in v} | set(project_load)
    sups = {s for s in supervisor_of.values() if s}
    total = len(elig) + sum(project_load.values())
    pcap = fair_share(total, n_projects or len(projects), bal.project_slack)
    scap = fair_share(len(elig) + sum(supervisor_load.values()), len(sups), bal.supervisor_slack)
    g_obj = _penalised(greedy, project_load, supervisor_of, supervisor_load, pcap, scap, bal)
    g_total = sum(ps.score for ps in greedy.values())

    def fallback(reason: str) -> Plan:
        return Plan(greedy, "greedy", reason, g_obj, g_obj, g_total, g_total, {}, pcap, scap)

    if not elig:
        return fallback("nothing to allocate")
    n_x = sum(len(v) for v in elig.values())
    if n_x + len(projects) + len(sups) > MAX_VARIABLES:
        return fallback("model too large")
    try:
        choice = _solve(elig, project_load, supervisor_of, supervisor_load, pcap, scap, bal)
    except ImportError:
        return fallback("scipy not installed")
    except Exception as exc:  # noqa: BLE001 - any solver failure falls back to the greedy rule
        return fallback(f"solver error: {type(exc).__name__}")
    if choice is None:
        return fallback("solver found no solution")
    obj = _penalised(choice, project_load, supervisor_of, supervisor_load, pcap, scap, bal)
    if obj < g_obj - 1e-6:  # never worse than greedy (guards against a time-limited, sub-optimal solve)
        return fallback("solver result worse than greedy")
    moved = {k: greedy[k] for k, ps in choice.items() if ps.project_id != greedy[k].project_id}
    return Plan(choice, "ilp", None, obj, g_obj, sum(ps.score for ps in choice.values()), g_total, moved, pcap, scap)


def _solve(
    elig: dict[str, list[PairScore]],
    project_load: dict[str, int],
    supervisor_of: dict[str, str | None],
    supervisor_load: dict[str, int],
    pcap: int,
    scap: int,
    bal: Balance,
) -> dict[str, PairScore] | None:
    import numpy as np  # lazy: API start-up never loads numpy/scipy
    from scipy.optimize import Bounds, LinearConstraint, milp  # type: ignore[import-untyped]
    from scipy.sparse import coo_matrix  # type: ignore[import-untyped]

    pairs: list[tuple[str, PairScore]] = [(k, ps) for k, v in elig.items() for ps in v]
    proj_ids = sorted({ps.project_id for _, ps in pairs})
    sup_ids = sorted({s for p in proj_ids if (s := supervisor_of.get(p))})
    p_col = {p: len(pairs) + i for i, p in enumerate(proj_ids)}
    s_col = {s: len(pairs) + len(proj_ids) + i for i, s in enumerate(sup_ids)}
    n = len(pairs) + len(proj_ids) + len(sup_ids)

    # objective (milp minimises): -(score - tiny tie-break by the trainee's own ranking) + penalties
    c = np.zeros(n)
    rank: dict[str, int] = {}
    for j, (k, ps) in enumerate(pairs):
        r = rank.get(k, 0)
        rank[k] = r + 1
        c[j] = -(ps.score - 1e-4 * r)  # equal scores: prefer the greedy order (lowest project code)
    for col in p_col.values():
        c[col] = bal.project_penalty
    for col in s_col.values():
        c[col] = bal.supervisor_penalty

    rows: list[int] = []
    cols: list[int] = []
    vals: list[float] = []
    lb: list[float] = []
    ub: list[float] = []
    r = 0
    keys = list(elig)
    by_key: dict[str, list[int]] = {k: [] for k in keys}
    by_proj: dict[str, list[int]] = {p: [] for p in proj_ids}
    by_sup: dict[str, list[int]] = {s: [] for s in sup_ids}
    for j, (k, ps) in enumerate(pairs):
        by_key[k].append(j)
        by_proj[ps.project_id].append(j)
        if sup := supervisor_of.get(ps.project_id):
            by_sup[sup].append(j)
    for k in keys:  # exactly one project per trainee
        for j in by_key[k]:
            rows.append(r)
            cols.append(j)
            vals.append(1.0)
        lb.append(1.0)
        ub.append(1.0)
        r += 1
    for p, col in p_col.items():  # Σ new on p - overflow_p ≤ max(0, share - existing load)
        for j in by_proj[p]:
            rows.append(r)
            cols.append(j)
            vals.append(1.0)
        rows.append(r)
        cols.append(col)
        vals.append(-1.0)
        lb.append(-np.inf)
        ub.append(float(max(0, pcap - project_load.get(p, 0))))
        r += 1
    for s, col in s_col.items():
        for j in by_sup[s]:
            rows.append(r)
            cols.append(j)
            vals.append(1.0)
        rows.append(r)
        cols.append(col)
        vals.append(-1.0)
        lb.append(-np.inf)
        ub.append(float(max(0, scap - supervisor_load.get(s, 0))))
        r += 1
    A = coo_matrix((vals, (rows, cols)), shape=(r, n)).tocsr()
    integrality = np.zeros(n)
    integrality[: len(pairs)] = 1
    upper = np.full(n, np.inf)
    upper[: len(pairs)] = 1.0
    res = milp(
        c,
        constraints=LinearConstraint(A, np.array(lb), np.array(ub)),
        integrality=integrality,
        bounds=Bounds(np.zeros(n), upper),
        options={"time_limit": bal.time_limit_s, "disp": False},
    )
    if res.x is None:
        return None
    choice: dict[str, PairScore] = {}
    for j, (k, ps) in enumerate(pairs):
        if res.x[j] > 0.5:
            if k in choice:
                return None
            choice[k] = ps
    return choice if len(choice) == len(keys) else None
