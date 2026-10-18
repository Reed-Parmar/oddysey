"""ADR-029: allocation every minute; scheduled runs skip cheaply when nothing changed; job rows do not pile up."""

from datetime import UTC, datetime, timedelta

from app.db.session import get_sessionmaker
from tests.conftest import drain, owner_sql
from tests.helpers import setup_dataset
from tests.integration.test_rejection import add_trainee


def scheduled_run(cycle_id: str, n: int) -> dict:
    owner_sql(
        "INSERT INTO app.jobs (kind, payload, dedupe_key, trigger) VALUES ('allocate_cycle', %s, %s, 'schedule')",
        (f'{{"cycle_id": "{cycle_id}"}}', f"test-schedule-{n}"),
    )
    drain()
    return owner_sql("SELECT result FROM app.jobs WHERE dedupe_key = %s", (f"test-schedule-{n}",))[0][0]


def test_scheduled_runs_skip_when_nothing_changed(client, users):
    admin = users.make("admin")
    s = setup_dataset(client, users, admin)
    cid = s["cycle"]["id"]
    waiting = owner_sql(
        """SELECT count(*) FROM app.trainees t WHERE t.cycle_id = %s AND NOT EXISTS (
             SELECT 1 FROM app.allocations a WHERE a.trainee_id = t.id AND a.status = 'active')""",
        (cid,),
    )[0][0]
    if waiting == 0:  # everyone placed: a scheduled run returns after one cheap query
        assert scheduled_run(cid, 1)["skipped"] == "no unassigned trainees"
    # a new waiting trainee changes the fingerprint → full run that allocates them
    tid = add_trainee(cid, "TRN-EL-301", ["Solar Wiring", "Circuit Design", "Microcontrollers"])
    full = scheduled_run(cid, 2)
    assert "skipped" not in full and full["allocated"] >= 1 and full["full_run_at"]
    assert (
        owner_sql("SELECT count(*) FROM app.allocations WHERE trainee_id = %s AND status = 'active'", (tid,))[0][0] == 1
    )
    # someone who can never be placed keeps waiting; the next scheduled runs see no change and skip
    add_trainee(cid, "TRN-EL-302", [], practical=10)
    first = scheduled_run(cid, 3)
    assert "skipped" not in first and sum(first["waiting"].values()) >= 1
    again = scheduled_run(cid, 4)
    assert again["skipped"] == "unchanged since the last run"
    assert again["allocated"] == 0 and again["waiting"] == first["waiting"]
    # an event-triggered run never skips on "unchanged"
    owner_sql(
        "INSERT INTO app.jobs (kind, payload, dedupe_key, trigger) VALUES ('allocate_cycle', %s, 'test-manual', 'manual')",
        (f'{{"cycle_id": "{cid}", "trigger": "manual"}}',),
    )
    drain()
    manual = owner_sql("SELECT result FROM app.jobs WHERE dedupe_key = 'test-manual'")[0][0]
    assert "skipped" not in manual
    # a full re-score still happens after FULL_RUN_MINUTES, even if unchanged
    owner_sql(
        "UPDATE app.jobs SET result = jsonb_set(result, '{full_run_at}', to_jsonb(%s::text)) WHERE kind = 'allocate_cycle'",
        ((datetime.now(UTC) - timedelta(minutes=30)).isoformat(),),
    )
    assert "skipped" not in scheduled_run(cid, 5)


def test_schedule_tick_enqueues_once_per_minute_and_prunes_old_runs(client, users):
    from app.core.config import get_settings
    from app.worker import schedule_tick

    assert get_settings().allocation_interval_minutes == 1
    admin = users.make("admin")
    s = setup_dataset(client, users, admin)
    cid = s["cycle"]["id"]
    owner_sql("DELETE FROM app.jobs")
    t0 = datetime.now(UTC).replace(second=5, microsecond=0)
    factory = get_sessionmaker()
    with factory() as db:
        schedule_tick(db, t0)
        schedule_tick(db, t0 + timedelta(seconds=30))  # same 1-minute bucket: deduplicated
    assert owner_sql("SELECT count(*) FROM app.jobs WHERE kind = 'allocate_cycle'")[0][0] == 1
    drain()
    with factory() as db:
        schedule_tick(db, t0 + timedelta(seconds=60))  # next bucket: a new run
    assert owner_sql("SELECT count(*) FROM app.jobs WHERE kind = 'allocate_cycle'")[0][0] == 2
    drain()
    # finished scheduled runs older than a day are pruned on the next tick
    owner_sql("UPDATE app.jobs SET created_at = now() - interval '2 days' WHERE kind = 'allocate_cycle'")
    with factory() as db:
        schedule_tick(db, t0 + timedelta(seconds=120))
    rows = owner_sql("SELECT status FROM app.jobs WHERE kind = 'allocate_cycle'")
    assert rows == [("queued",)]
    del cid
