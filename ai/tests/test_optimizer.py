import importlib.util

import pytest

from spa_ai import optimizer
from spa_ai.optimizer import Balance, optimise
from spa_ai.scoring import PairScore


def ps(t: str, p: str, score: float, eligible: bool = True) -> PairScore:
    return PairScore(t, p, p.upper(), score, eligible, [] if eligible else ["trade_mismatch"], [], 0.0, 0.0)


needs_scipy = pytest.mark.skipif(
    importlib.util.find_spec("scipy") is None, reason="scipy not installed (backend dependency)"
)

BAL = Balance(project_slack=1.0, supervisor_slack=10.0, project_penalty=8.0, supervisor_penalty=5.0)


@needs_scipy
def test_no_contention_equals_greedy():
    opts = {"t1": [ps("t1", "p1", 90), ps("t1", "p2", 70)], "t2": [ps("t2", "p2", 88), ps("t2", "p1", 60)]}
    plan = optimise(opts, n_projects=2, balance=BAL)
    assert plan.engine == "ilp" and plan.moved == {}
    assert {k: v.project_id for k, v in plan.choice.items()} == {"t1": "p1", "t2": "p2"}
    assert plan.objective == plan.greedy_objective


@needs_scipy
def test_crowded_project_is_spread_when_the_loss_is_small():
    opts = {f"t{i}": [ps(f"t{i}", "p1", 90), ps(f"t{i}", "p2", 85 - i * 0.1)] for i in range(4)}
    plan = optimise(opts, n_projects=2, balance=BAL)  # fair share = 2 per project
    counts = {p: sum(1 for c in plan.choice.values() if c.project_id == p) for p in ("p1", "p2")}
    assert counts == {"p1": 2, "p2": 2}
    assert len(plan.moved) == 2 and plan.objective > plan.greedy_objective
    # the two moved are those who lose least (highest p2 score): t0 and t1
    assert set(plan.moved) == {"t0", "t1"}
    assert all(plan.choice[k].score == 85 - int(k[1]) * 0.1 for k in plan.moved)  # scores unchanged


@needs_scipy
def test_large_loss_keeps_the_best_project():
    opts = {f"t{i}": [ps(f"t{i}", "p1", 90), ps(f"t{i}", "p2", 60)] for i in range(4)}
    plan = optimise(opts, n_projects=2, balance=BAL)
    assert plan.moved == {} and all(c.project_id == "p1" for c in plan.choice.values())


@needs_scipy
def test_supervisor_load_is_balanced():
    opts = {f"t{i}": [ps(f"t{i}", "p1", 90), ps(f"t{i}", "p2", 87)] for i in range(4)}
    bal = Balance(project_slack=10.0, supervisor_slack=1.0, project_penalty=8.0, supervisor_penalty=5.0)
    plan = optimise(opts, supervisor_of={"p1": "s1", "p2": "s2"}, n_projects=2, balance=bal)
    assert sorted(c.project_id for c in plan.choice.values()) == ["p1", "p1", "p2", "p2"]


@needs_scipy
def test_existing_load_counts_and_everyone_is_placed():
    opts = {"t1": [ps("t1", "p1", 90), ps("t1", "p2", 86), ps("t1", "p3", 99, eligible=False)]}
    plan = optimise(opts, project_load={"p1": 5}, n_projects=2, balance=BAL)
    assert plan.choice["t1"].project_id == "p2"  # p1 already over its share
    assert optimise({"t1": [ps("t1", "p1", 50, eligible=False)]}).choice == {}


def test_falls_back_to_greedy_without_solver(monkeypatch):
    def boom(*a, **k):
        raise ImportError("scipy")

    monkeypatch.setattr(optimizer, "_solve", boom)
    opts = {f"t{i}": [ps(f"t{i}", "p1", 90), ps(f"t{i}", "p2", 85)] for i in range(4)}
    plan = optimise(opts, n_projects=2, balance=BAL)
    assert plan.engine == "greedy" and plan.reason == "scipy not installed"
    assert all(c.project_id == "p1" for c in plan.choice.values())
    assert plan.summary()["engine"] == "greedy"
