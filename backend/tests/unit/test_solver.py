from collections import Counter

from app.modules.allocations.solver import SolverInput, SolverResult, solve


def _check_capacity(inp: SolverInput, res: SolverResult) -> None:
    used = Counter(res.assignments.values())
    for project_id, n in used.items():
        assert n <= inp.capacity.get(project_id, 0)
    for trainee_id, project_id in res.assignments.items():
        assert (trainee_id, project_id) in inp.scores
    assert set(res.assignments) | set(res.unassigned) == set(inp.trainee_ids)
    assert not set(res.assignments) & set(res.unassigned)


def test_chain_case_maximises_count_over_greedy_score():
    # supervisor.md §10.3
    inp = SolverInput(
        trainee_ids=["T1", "T2", "T3"],
        capacity={"X": 1, "Y": 1},
        scores={("T1", "X"): 90, ("T1", "Y"): 80, ("T2", "X"): 85},
    )
    res = solve(inp)
    assert res.assignments == {"T1": "Y", "T2": "X"}
    assert res.unassigned == ["T3"]
    _check_capacity(inp, res)


def test_high_scorer_does_not_block_two_others():
    # T1 is excellent on both A and B; T2 only fits A, T3 only fits B; one slot each.
    inp = SolverInput(
        trainee_ids=["T1", "T2", "T3"],
        capacity={"A": 1, "B": 1, "C": 1},
        scores={
            ("T1", "A"): 99,
            ("T1", "B"): 99,
            ("T1", "C"): 10,
            ("T2", "A"): 40,
            ("T3", "B"): 40,
        },
    )
    res = solve(inp)
    assert res.assignments == {"T1": "C", "T2": "A", "T3": "B"}
    assert res.unassigned == []


def test_capacity_respected():
    trainees = [f"T{i:02d}" for i in range(10)]
    inp = SolverInput(
        trainee_ids=trainees,
        capacity={"P1": 3, "P2": 2},
        scores={(t, p): 50 + i for i, t in enumerate(trainees) for p in ("P1", "P2")},
    )
    res = solve(inp)
    _check_capacity(inp, res)
    assert len(res.assignments) == 5
    # the five highest scorers are placed
    assert set(res.assignments) == set(trainees[5:])
    assert res.unassigned == trainees[:5]


def test_maximises_total_score_when_count_equal():
    inp = SolverInput(
        trainee_ids=["T1", "T2"],
        capacity={"A": 1, "B": 1},
        scores={("T1", "A"): 90, ("T1", "B"): 60, ("T2", "A"): 70, ("T2", "B"): 65},
    )
    assert solve(inp).assignments == {"T1": "A", "T2": "B"}


def test_tie_determinism():
    inp = SolverInput(
        trainee_ids=["T1", "T2", "T3"],
        capacity={"B": 1, "A": 1, "C": 1},
        scores={(t, p): 75.0 for t in ("T1", "T2", "T3") for p in ("A", "B", "C")},
    )
    first = solve(inp)
    for _ in range(5):
        again = solve(SolverInput(list(inp.trainee_ids), dict(inp.capacity), dict(inp.scores)))
        assert again.assignments == first.assignments
    # reordering the capacity dict must not change the answer (columns sorted by id)
    reordered = SolverInput(inp.trainee_ids, {"C": 1, "A": 1, "B": 1}, inp.scores)
    assert solve(reordered).assignments == first.assignments
    assert len(first.assignments) == 3


def test_unallocated_when_no_eligible_project():
    inp = SolverInput(trainee_ids=["T1", "T2"], capacity={"A": 5}, scores={("T1", "A"): 80})
    res = solve(inp)
    assert res.assignments == {"T1": "A"}
    assert res.unassigned == ["T2"]


def test_zero_capacity():
    inp = SolverInput(trainee_ids=["T1"], capacity={"A": 0, "B": -1}, scores={("T1", "A"): 90, ("T1", "B"): 90})
    res = solve(inp)
    assert res.assignments == {}
    assert res.unassigned == ["T1"]


def test_empty_inputs():
    assert solve(SolverInput([], {}, {})) == SolverResult({}, [])
    assert solve(SolverInput([], {"A": 2}, {})) == SolverResult({}, [])
    assert solve(SolverInput(["T1", "T2"], {}, {})) == SolverResult({}, ["T1", "T2"])


def test_score_for_unknown_project_ignored():
    inp = SolverInput(trainee_ids=["T1"], capacity={"A": 1}, scores={("T1", "Z"): 99})
    assert solve(inp).unassigned == ["T1"]
