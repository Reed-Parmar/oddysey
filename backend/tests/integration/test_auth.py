"""Authentication, provisioning, invitations and the cross-role access matrix (auth.md §7, §8)."""

import uuid

import pytest

from tests.conftest import auth, owner_sql, token_for, uid_of
from tests.helpers import create_cycle, link_student, ok, setup_dataset


def test_missing_and_invalid_tokens(client):
    assert client.get("/api/v1/me").json()["error"]["code"] == "UNAUTHENTICATED"
    assert client.get("/api/v1/me", headers={"Authorization": "Bearer nope"}).status_code == 401
    expired = token_for(uuid.uuid4(), "a@example.org", exp=1)
    assert client.get("/api/v1/me", headers={"Authorization": f"Bearer {expired}"}).status_code == 401
    wrong_aud = token_for(uuid.uuid4(), "a@example.org", aud="anon")
    assert client.get("/api/v1/me", headers={"Authorization": f"Bearer {wrong_aud}"}).status_code == 401
    anon = token_for(uuid.uuid4(), "a@example.org", is_anonymous=True)
    assert client.get("/api/v1/me", headers={"Authorization": f"Bearer {anon}"}).status_code == 401


def test_self_registration_creates_student_only(client):
    h = auth(uuid.uuid4(), "New.Person@Example.org", "New Person")
    assert client.get("/api/v1/me", headers=h).json()["error"]["code"] == "NOT_PROVISIONED"
    assert client.post("/api/v1/auth/provision", json={"role": "admin"}, headers=h).status_code == 422
    user = ok(client.post("/api/v1/auth/provision", json={}, headers=h), 201)["data"]
    assert user["role"] == "student" and user["email"] == "new.person@example.org"
    assert ok(client.post("/api/v1/auth/provision", json={}, headers=h))["data"]["id"] == user["id"]  # idempotent
    assert ok(client.get("/api/v1/me", headers=h))["data"]["full_name"] == "New Person"


def test_supervisor_invitation_bound_to_email(client, users):
    admin = users.make("admin")
    inv = ok(
        client.post(
            "/api/v1/admin/invitations", json={"email": "sup@example.org", "role": "supervisor"}, headers=admin
        ),
        201,
    )["data"]
    token = inv["invite_url"].split("invite=")[1]
    impostor = auth(uuid.uuid4(), "other@example.org")
    r = client.post("/api/v1/auth/provision", json={"invitation_token": token}, headers=impostor)
    assert r.status_code == 400 and r.json()["error"]["code"] == "INVITATION_INVALID"
    assert owner_sql("SELECT count(*) FROM app.users WHERE email='other@example.org'")[0][0] == 0  # rolled back
    sup = auth(uuid.uuid4(), "sup@example.org")
    assert (
        ok(client.post("/api/v1/auth/provision", json={"invitation_token": token}, headers=sup), 201)["data"]["role"]
        == "supervisor"
    )
    reuse = auth(uuid.uuid4(), "sup@example.org")
    assert client.post("/api/v1/auth/provision", json={"invitation_token": token}, headers=reuse).status_code in (
        400,
        409,
    )
    listed = ok(client.get("/api/v1/admin/invitations", headers=admin))["data"]
    assert listed[0]["status"] == "accepted"


def test_student_invite_requires_trainee_and_links_record(client, users):
    admin = users.make("admin")
    s = setup_dataset(client, users, admin)
    r = client.post("/api/v1/admin/invitations", json={"email": "x@example.org", "role": "student"}, headers=admin)
    assert r.status_code == 422
    t = s["trainees"]["TRN-FT-003"]
    student = link_student(client, admin, t["id"], "amit@example.org")
    assert ok(client.get("/api/v1/trainees/me", headers=student))["data"]["id"] == t["id"]
    again = client.post(
        "/api/v1/admin/invitations",
        json={"email": "y@example.org", "role": "student", "trainee_id": t["id"]},
        headers=admin,
    )
    assert again.json()["error"]["code"] == "ACCOUNT_ALREADY_LINKED"


def test_disabled_account_and_admin_guards(client, users):
    admin = users.make("admin")
    other = users.make("student")
    assert (
        client.patch(f"/api/v1/admin/users/{uid_of(admin)}", json={"status": "disabled"}, headers=admin).json()[
            "error"
        ]["code"]
        == "SELF_MODIFICATION_FORBIDDEN"
    )
    ok(client.patch(f"/api/v1/admin/users/{uid_of(other)}", json={"status": "disabled"}, headers=admin))
    assert client.get("/api/v1/me", headers=other).json()["error"]["code"] == "ACCOUNT_DISABLED"
    second = users.make("admin")
    ok(client.patch(f"/api/v1/admin/users/{uid_of(second)}", json={"role": "supervisor"}, headers=admin))
    assert client.get("/api/v1/admin/users", headers=second).status_code == 403  # role change applies immediately


ADMIN_ONLY = [
    ("get", "/api/v1/cycles"),
    ("post", "/api/v1/cycles"),
    ("get", "/api/v1/admin/users"),
    ("get", "/api/v1/admin/invitations"),
    ("get", "/api/v1/admin/reports/overview"),
    ("post", "/api/v1/projects"),
    ("post", "/api/v1/allocations"),
]


@pytest.mark.parametrize("role", ["student", "supervisor"])
@pytest.mark.parametrize("method,path", ADMIN_ONLY)
def test_non_admins_are_forbidden(client, users, role, method, path):
    h = users.make(role)
    r = getattr(client, method)(path, headers=h, **({"json": {}} if method == "post" else {}))
    assert r.status_code == 403 and r.json()["error"]["code"] == "FORBIDDEN"


def test_role_scoped_endpoints(client, users):
    admin = users.make("admin")
    cycle = create_cycle(client, admin)
    student, sup = users.make("student"), users.make("supervisor")
    assert client.post(f"/api/v1/cycles/{cycle['id']}/recommendation-runs", headers=sup).status_code == 403
    assert client.post(f"/api/v1/cycles/{cycle['id']}/allocation-runs", headers=student).status_code == 403
    assert client.get("/api/v1/trainees", headers=student).status_code == 403
    assert client.get("/api/v1/recommendations", headers=sup).status_code == 403
    assert (
        client.post(
            f"/api/v1/submissions/{uuid.uuid4()}/evaluation", headers=student, json={"outcome": "evaluated"}
        ).status_code
        == 403
    )
    assert client.post("/api/v1/submissions", headers=sup, data={"video_url": "https://x.org"}).status_code == 403
    assert client.patch("/api/v1/trainees/me", headers=student, json={"scores": {"practical": 99}}).status_code == 422


def test_object_level_visibility(client, users):
    admin = users.make("admin")
    s = setup_dataset(client, users, admin)
    student = link_student(client, admin, s["trainees"]["TRN-EL-001"]["id"], "ramesh@example.org")
    other = s["trainees"]["TRN-EL-002"]["id"]
    assert client.get(f"/api/v1/trainees/{other}", headers=student).status_code == 404
    # supervisors see no trainees until allocations are published
    assert client.get(f"/api/v1/trainees/{other}", headers=s["sup_a"]).status_code == 404
    own = ok(client.get(f"/api/v1/trainees/{s['trainees']['TRN-EL-001']['id']}", headers=student))["data"]
    assert own["gender"] is None and own["account"]["email"] == "ramesh@example.org"
    admin_view = ok(client.get(f"/api/v1/trainees/{other}", headers=admin))["data"]
    assert admin_view["gender"] == "female"
    # student project catalogue: published projects only, no stats
    projects = ok(client.get("/api/v1/projects", params={"page_size": 100}, headers=student))["data"]
    assert len(projects) == 8 and all(p["stats"] is None for p in projects)
