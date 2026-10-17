"""Builds the dataset scenario through the real API (import → supervisors → publish projects)."""

from datetime import UTC, datetime, timedelta
from typing import Any

from tests.conftest import DATASET, Users, uid_of


def ok(resp: Any, status: int = 200) -> Any:
    assert resp.status_code == status, f"{resp.status_code}: {resp.text}"
    return resp.json()


def create_cycle(client: Any, admin: dict[str, str], name: str = "Oct 2026 CSR Projects") -> dict[str, Any]:
    deadline = (datetime.now(UTC) + timedelta(days=30)).isoformat()
    return ok(client.post("/api/v1/cycles", json={"name": name, "submission_deadline": deadline}, headers=admin), 201)[
        "data"
    ]


def import_file(
    client: Any,
    admin: dict[str, str],
    kind: str,
    cycle_id: str,
    dry_run: bool,
    content: bytes | None = None,
    filename: str = "dataset.xlsx",
) -> Any:
    data = content if content is not None else DATASET.read_bytes()
    return client.post(
        f"/api/v1/admin/imports/{kind}",
        headers=admin,
        files={"file": (filename, data, "application/octet-stream")},
        data={"cycle_id": cycle_id, "dry_run": "true" if dry_run else "false"},
    )


def setup_dataset(client: Any, users: Users, admin: dict[str, str]) -> dict[str, Any]:
    cycle = create_cycle(client, admin)
    ok(import_file(client, admin, "trainees", cycle["id"], dry_run=False))
    ok(import_file(client, admin, "projects", cycle["id"], dry_run=False))
    sup_a = users.make("supervisor", "mehta@example.org", "Dr. Mehta", "Electrical")
    sup_b = users.make("supervisor", "rao@example.org", "Ms. Rao", "Mechanical")
    projects = ok(client.get("/api/v1/projects", params={"cycle_id": cycle["id"], "page_size": 100}, headers=admin))[
        "data"
    ]
    by_code = {p["project_code"]: p for p in projects}
    for p in projects:
        sup = sup_a if p["project_code"].split("-")[1] in ("EL", "CP", "SL") else sup_b
        ok(client.patch(f"/api/v1/projects/{p['id']}", json={"supervisor_id": uid_of(sup)}, headers=admin))
        ok(client.post(f"/api/v1/projects/{p['id']}/transition", json={"to": "published"}, headers=admin))
    trainees = ok(client.get("/api/v1/trainees", params={"cycle_id": cycle["id"], "page_size": 100}, headers=admin))[
        "data"
    ]
    return {
        "cycle": cycle,
        "projects": by_code,
        "trainees": {t["trainee_code"]: t for t in trainees},
        "sup_a": sup_a,
        "sup_b": sup_b,
    }


def run_recommendations(client: Any, admin: dict[str, str], cycle_id: str, use_ai: bool = False) -> dict[str, Any]:
    run = ok(
        client.post(f"/api/v1/cycles/{cycle_id}/recommendation-runs", json={"use_ai": use_ai}, headers=admin), 202
    )["data"]
    latest = ok(client.get(f"/api/v1/cycles/{cycle_id}/recommendation-runs/latest", headers=admin))["data"]
    assert latest["id"] == run["id"]
    return latest


def link_student(client: Any, admin: dict[str, str], trainee_id: str, email: str) -> dict[str, str]:
    """Real invite flow: admin invites → user signs up (token) → provision with the invitation token."""
    import uuid

    from tests.conftest import auth

    inv = ok(
        client.post(
            "/api/v1/admin/invitations",
            json={"email": email, "role": "student", "trainee_id": trainee_id},
            headers=admin,
        ),
        201,
    )["data"]
    token = inv["invite_url"].split("invite=")[1]
    uid = uuid.uuid4()
    h = auth(uid, email, "Student")
    ok(client.post("/api/v1/auth/provision", json={"invitation_token": token}, headers=h), 201)
    h["X-User-Id"] = str(uid)
    return h
