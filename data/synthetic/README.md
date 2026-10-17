# Synthetic ITI matching dataset

**Every record is synthetic.** Trainees, names, centres, projects, submissions and evaluations are generated;
none of them is real Tata STRIVE data. Labels come from the production scorer (`scoring-2`) and
the ADR-017 allocation rules (`adr017-best-eligible+ranked-replacement`), not from an LLM.

- Generator: `synthetic-1`, seed `42`
- Size: 1000 trainees, 100 projects, 30 scenarios
- Validation: **PASSED** (see `validation_report.json`)
- Reproduce: `cd backend && uv run python -m scripts.generate_synthetic_data --trainees 1000 \
  --projects 100 --scenarios 30 --seed 42 --force`
- Documentation: `docs/synthetic-data.md` in the repository

| File | Rows |
|---|---|
| `trainees.csv` | 1000 |
| `projects.csv` | 100 |
| `scenarios.csv` | 30 |
| `scenario_projects.csv` | 633 |
| `candidate_pairs.csv` | 118325 |
| `recommendations.csv` | 25835 |
| `allocations.csv` | 2985 |
| `rejections.csv` | 151 |
| `allocation_results.csv` | 5167 |
| `submissions.csv` | 1854 |
| `evaluations.csv` | 1607 |
| `llm/rank_projects/train.jsonl` | 3989 |
| `llm/rank_projects/validation.jsonl` | 564 |
| `llm/rank_projects/test.jsonl` | 614 |
| `llm/explain_allocation/train.jsonl` | 3989 |
| `llm/explain_allocation/validation.jsonl` | 564 |
| `llm/explain_allocation/test.jsonl` | 614 |
| `llm/decision_output/train.jsonl` | 3989 |
| `llm/decision_output/validation.jsonl` | 564 |
| `llm/decision_output/test.jsonl` | 614 |
| `ingest/supervisors.csv` | 13 |
| `ingest/admins.csv` | 2 |
| `ingest/trainees.csv` | 1000 |
| `ingest/projects.csv` | 100 |
| `ingest/scenarios/SCN-0001_trainees.csv` | 252 |
| `ingest/scenarios/SCN-0001_projects.csv` | 32 |
| `ingest/scenarios/SCN-0002_trainees.csv` | 154 |
| `ingest/scenarios/SCN-0002_projects.csv` | 14 |
| `ingest/scenarios/SCN-0003_trainees.csv` | 241 |
| `ingest/scenarios/SCN-0003_projects.csv` | 28 |
| `ingest/scenarios/SCN-0004_trainees.csv` | 109 |
| `ingest/scenarios/SCN-0004_projects.csv` | 14 |
| `ingest/scenarios/SCN-0005_trainees.csv` | 201 |
| `ingest/scenarios/SCN-0005_projects.csv` | 22 |
| `ingest/scenarios/SCN-0006_trainees.csv` | 149 |
| `ingest/scenarios/SCN-0006_projects.csv` | 23 |
| `ingest/scenarios/SCN-0007_trainees.csv` | 121 |
| `ingest/scenarios/SCN-0007_projects.csv` | 12 |
| `ingest/scenarios/SCN-0008_trainees.csv` | 137 |
| `ingest/scenarios/SCN-0008_projects.csv` | 15 |
| `ingest/scenarios/SCN-0009_trainees.csv` | 134 |
| `ingest/scenarios/SCN-0009_projects.csv` | 14 |
| `ingest/scenarios/SCN-0010_trainees.csv` | 221 |
| `ingest/scenarios/SCN-0010_projects.csv` | 13 |
| `ingest/scenarios/SCN-0011_trainees.csv` | 117 |
| `ingest/scenarios/SCN-0011_projects.csv` | 14 |
| `ingest/scenarios/SCN-0012_trainees.csv` | 216 |
| `ingest/scenarios/SCN-0012_projects.csv` | 32 |
| `ingest/scenarios/SCN-0013_trainees.csv` | 226 |
| `ingest/scenarios/SCN-0013_projects.csv` | 29 |
| `ingest/scenarios/SCN-0014_trainees.csv` | 133 |
| `ingest/scenarios/SCN-0014_projects.csv` | 11 |
| `ingest/scenarios/SCN-0015_trainees.csv` | 208 |
| `ingest/scenarios/SCN-0015_projects.csv` | 35 |
| `ingest/scenarios/SCN-0016_trainees.csv` | 100 |
| `ingest/scenarios/SCN-0016_projects.csv` | 10 |
| `ingest/scenarios/SCN-0017_trainees.csv` | 151 |
| `ingest/scenarios/SCN-0017_projects.csv` | 26 |
| `ingest/scenarios/SCN-0018_trainees.csv` | 134 |
| `ingest/scenarios/SCN-0018_projects.csv` | 12 |
| `ingest/scenarios/SCN-0019_trainees.csv` | 113 |
| `ingest/scenarios/SCN-0019_projects.csv` | 13 |
| `ingest/scenarios/SCN-0020_trainees.csv` | 226 |
| `ingest/scenarios/SCN-0020_projects.csv` | 22 |
| `ingest/scenarios/SCN-0021_trainees.csv` | 146 |
| `ingest/scenarios/SCN-0021_projects.csv` | 26 |
| `ingest/scenarios/SCN-0022_trainees.csv` | 183 |
| `ingest/scenarios/SCN-0022_projects.csv` | 24 |
| `ingest/scenarios/SCN-0023_trainees.csv` | 190 |
| `ingest/scenarios/SCN-0023_projects.csv` | 32 |
| `ingest/scenarios/SCN-0024_trainees.csv` | 108 |
| `ingest/scenarios/SCN-0024_projects.csv` | 11 |
| `ingest/scenarios/SCN-0025_trainees.csv` | 106 |
| `ingest/scenarios/SCN-0025_projects.csv` | 15 |
| `ingest/scenarios/SCN-0026_trainees.csv` | 197 |
| `ingest/scenarios/SCN-0026_projects.csv` | 9 |
| `ingest/scenarios/SCN-0027_trainees.csv` | 239 |
| `ingest/scenarios/SCN-0027_projects.csv` | 34 |
| `ingest/scenarios/SCN-0028_trainees.csv` | 211 |
| `ingest/scenarios/SCN-0028_projects.csv` | 25 |
| `ingest/scenarios/SCN-0029_trainees.csv` | 238 |
| `ingest/scenarios/SCN-0029_projects.csv` | 34 |
| `ingest/scenarios/SCN-0030_trainees.csv` | 206 |
| `ingest/scenarios/SCN-0030_projects.csv` | 32 |

These examples show that a model reproduces the deterministic engine. They say nothing about real-world
placement quality.
