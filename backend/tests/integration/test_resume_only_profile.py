"""ADR-025: a trainee's skills and career interest change only to values from their latest resume (TRN-02)."""

from spa_ai.resume.testing import make_pdf
from tests.helpers import ok
from tests.integration.test_resumes import ai_on, ramesh, upload  # noqa: F401  (fixtures)


def patch(client, headers, body):
    return client.patch("/api/v1/trainees/me", headers=headers, json=body)


def errors(r) -> set[str]:
    return {d["field"] for d in r.json()["error"]["details"]}


def test_skills_and_interest_only_come_from_the_resume(client, ramesh, ai_on, resume_storage):  # noqa: F811
    st = ramesh["student"]
    me = ok(client.get("/api/v1/trainees/me", headers=st))["data"]
    current = [s["name"] for s in me["skills"]]

    # without a resume: typed skills and a typed interest are refused; keeping or removing is fine
    r = patch(client, st, {"skills": [*current, "Welding"], "career_interest": "Anything I type"})
    assert r.status_code == 422 and errors(r) == {"body.skills", "body.career_interest"}
    ok(patch(client, st, {"skills": current, "career_interest": me["career_interest"] or ""}))
    if current:
        ok(patch(client, st, {"skills": current[:-1]}))

    # after a resume: its skills and its interest hint can be applied, nothing else
    ai_on({"skills": ["Solar Wiring", "Inverter Setup"], "career_interest_hint": "Rooftop solar installation"})
    ok(upload(client, st, make_pdf(["Skills", "Solar Wiring, Inverter Setup"])), 201)
    ok(
        patch(
            client, st, {"skills": ["Solar Wiring", "inverter setup"], "career_interest": "Rooftop solar installation"}
        )
    )
    me = ok(client.get("/api/v1/trainees/me", headers=st))["data"]
    assert {s["name"].lower() for s in me["skills"]} == {"solar wiring", "inverter setup"}
    assert me["career_interest"] == "Rooftop solar installation"
    r = patch(client, st, {"skills": ["Solar Wiring", "Plumbing"]})
    assert r.status_code == 422 and errors(r) == {"body.skills"}

    # trades and background stay freely editable
    ok(patch(client, st, {"background": "Two years of site work"}))
