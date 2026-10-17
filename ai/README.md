# ai — `spa_ai` package

A pure Python library imported by `backend/` (ADR-014). It is **not** a service, and it never imports the database, Storage or FastAPI.

| Module (planned) | Purpose | Doc |
|---|---|---|
| `spa_ai/llm/` | `GroqClient` (httpx, JSON mode, timeout, 1 retry) + `FakeAIClient` for tests | architecture.md §1 |
| `spa_ai/text.py` | Shared tokenizer | api.md C-13 |
| `spa_ai/scoring.py` | Rule scorer + `eligibility()`: Σ factor points = score | ADR-003, api.md REC-01 |
| `spa_ai/refiner.py` | Groq refinement + explanation, with rule-only fallback | ADR-003 |
| `spa_ai/resume/` | Resume text extraction, PII redaction, Groq/rule skill and project extraction | ADR-015, api.md RES |

Never send name, trainee code, centre, gender, email or phone to Groq.
