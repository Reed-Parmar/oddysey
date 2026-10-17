"""Auto-allocation solver (api.md ALLOC-02, supervisor.md §10). Pure: no DB, no I/O.

Rows are trainees (in the caller's order), columns are one per free project slot (projects
sorted by id) followed by one dummy column per trainee. Cost is ``100 - score`` for an
eligible pair, ``1e9`` for any other pair and ``1e6`` for a dummy. Because a placement saves
at least ``1e6 - 100``, the optimum first maximises the number of placed trainees, then the
total score. Capacity holds by construction (one column per free slot).
"""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np
from scipy.optimize import linear_sum_assignment

INELIGIBLE_COST = 1e9
DUMMY_COST = 1e6


@dataclass(frozen=True)
class SolverInput:
    trainee_ids: list[str]
    capacity: dict[str, int]
    scores: dict[tuple[str, str], float]


@dataclass
class SolverResult:
    assignments: dict[str, str] = field(default_factory=dict)
    unassigned: list[str] = field(default_factory=list)


def solve(inp: SolverInput) -> SolverResult:
    trainees = list(inp.trainee_ids)
    if not trainees:
        return SolverResult()

    slot_projects: list[str] = []
    for project_id in sorted(inp.capacity):
        slot_projects.extend([project_id] * max(0, int(inp.capacity[project_id])))

    n_rows, n_slots = len(trainees), len(slot_projects)
    cost = np.full((n_rows, n_slots + n_rows), INELIGIBLE_COST, dtype=np.float64)
    cost[:, n_slots:] = DUMMY_COST
    for r, trainee_id in enumerate(trainees):
        for c, project_id in enumerate(slot_projects):
            score = inp.scores.get((trainee_id, project_id))
            if score is not None:
                cost[r, c] = 100.0 - round(float(score), 2)

    rows, cols = linear_sum_assignment(cost)
    result = SolverResult()
    placed: set[int] = set()
    for r, c in zip(rows.tolist(), cols.tolist(), strict=True):
        if c < n_slots and cost[r, c] < DUMMY_COST:
            result.assignments[trainees[r]] = slot_projects[c]
            placed.add(r)
    result.unassigned = [t for r, t in enumerate(trainees) if r not in placed]
    return result
