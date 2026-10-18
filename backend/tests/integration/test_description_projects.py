"""ADR-028: projects without a document are processed from their title + problem-statement description."""

from tests.conftest import drain, owner_sql
from tests.helpers import create_cycle, import_file, ok

DESCRIPTION = (
    "Electrician trade, intermediate level. Build an automatic street light that switches on at dusk "
    "using an LDR and a relay, and write a test log."
)


def test_created_project_without_document_uses_the_description(client, users):
    admin = users.make("admin")
    users.make("supervisor", "sup@example.org", "Mr. Das", "Electrician")
    cycle = create_cycle(client, admin)
    owner_sql("INSERT INTO app.trades (name) VALUES ('Electrician') ON CONFLICT DO NOTHING")
    p = ok(
        client.post(
            "/api/v1/projects",
            headers=admin,
            data={"cycle_id": cycle["id"], "title": "Solar Street Light Controller", "description": DESCRIPTION},
        ),
        201,
    )["data"]
    assert p["processing_status"] == "queued" and p["document"] is None
    drain()
    p = ok(client.get(f"/api/v1/projects/{p['id']}", headers=admin))["data"]
    assert p["generation_source"] == "rule" and [t["name"] for t in p["target_trades"]] == ["Electrician"]
    assert p["difficulty"] == "intermediate"
    assert len(p["generated"]["steps"]) == 9 and "street light" in p["generated"]["steps"][0]["detail"]
    assert "no_document_text" in p["generated"]["issues"]
    assert p["processing_status"] == "ready" and p["status"] == "published"


HEADER = (
    "Project ID,Project Title,Target Trade,Difficulty Level,Min Practical Score Required (%),"
    "Required Prerequisite Skills,Project Category / Sponsor Goal,Problem Statement Doc,Description\n"
)


def test_imported_project_without_document_uses_the_description_or_waits(client, users):
    admin = users.make("admin")
    users.make("supervisor", "sup@example.org", "Mr. Das", "Electrician")
    cycle = create_cycle(client, admin)
    owner_sql("INSERT INTO app.trades (name) VALUES ('Electrician') ON CONFLICT DO NOTHING")
    csv = (
        HEADER
        + f'PRJ-D-1,Solar Street Light Controller,Electrician,Intermediate,40,Relay wiring,Lighting,,"{DESCRIPTION}"\n'
        + "PRJ-D-2,Empty brief project,Electrician,Beginner,40,Relay wiring,Lighting,,\n"
    )
    ok(import_file(client, admin, "projects", cycle["id"], dry_run=False, content=csv.encode(), filename="p.csv"))
    drain()
    rows = ok(client.get("/api/v1/projects", params={"cycle_id": cycle["id"]}, headers=admin))["data"]
    by_code = {p["project_code"]: p for p in rows}
    described = by_code["PRJ-D-1"]
    assert described["processing_status"] == "ready" and described["status"] == "published"
    assert described["generated"]["steps"] and "street light" in described["generated"]["steps"][0]["detail"]
    # neither a document nor a description: today's behaviour (waits for a document)
    assert by_code["PRJ-D-2"]["processing_status"] == "awaiting_document"
