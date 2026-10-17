# Synthetic matching dataset

A reproducible generator that expands the 12-trainee / 8-project reference workbook into a large,
internally consistent dataset for testing, evaluating and demonstrating trainee-to-project matching.
**Every generated record is fictional and marked `synthetic_record = true`.** None of it is Tata STRIVE data.

Code: `backend/scripts/synthetic/` and `backend/scripts/generate_synthetic_data.py`.
Tests: `backend/tests/unit/test_synthetic_data.py`. Output: `data/synthetic/` (git-ignored, regenerate it).

## 1. Quick start

```bash
cd backend
uv run python -m scripts.generate_synthetic_data                      # 1000 trainees, 100 projects, 30 scenarios, seed 42
uv run python -m scripts.generate_synthetic_data --trainees 60 --projects 12 --scenarios 3 --out ../data/small
uv run python -m scripts.synthetic.validate ../data/synthetic          # re-validate an existing dataset
uv run pytest tests/unit/test_synthetic_data.py
```

Windows (PowerShell), without uv:

```powershell
cd backend
.venv\Scripts\python.exe -m scripts.generate_synthetic_data --seed 42 --force
.venv\Scripts\python.exe -m scripts.synthetic.validate ..\data\synthetic
```

| Option | Default | Meaning |
|---|---|---|
| `--trainees / --projects / --scenarios` | 1000 / 100 / 30 | size (limits 30–20000 / 9–2000 / 3–500) |
| `--seed` | 42 | every random choice derives from it |
| `--out` | `data/synthetic` | output directory |
| `--formats` | `csv,jsonl` | add `xlsx` (inspection workbook) and/or `import` (importer-format files) |
| `--no-submissions`, `--no-llm`, `--no-validate` | off | skip those parts |
| `--workbook` | the dataset xlsx | reference workbook (read-only) |
| `--trainee-csv` | none | extra reference trainee CSV in dataset columns (a title and blank rows before the header are fine) |
| `--force` | off | replace a dataset this generator wrote earlier |

Exit codes: `0` valid, `1` a critical validation check failed, `2` bad arguments or inputs. The generator
refuses to write into a non-empty directory it did not create, or into a directory that holds a source file.
It never touches a database, Supabase Storage or Groq, and needs no API key.

The default run takes about 6 minutes on a laptop, about half of it validation (which re-scores all 118k pairs).

## 2. Ground truth: where labels come from

Labels are produced by the **production code**, imported directly, not re-implemented:

| Label | Source |
|---|---|
| factor points, score, `score_mode`, eligibility gates | `spa_ai.scoring.score_pair` (`scoring-2`, ADR-017) |
| recommendation ranks | `spa_ai.scoring.rank_pairs` (eligible first, score desc, project code) |
| ordinary allocation | `spa_ai.scoring.best_project` |
| replacement after a rejection | `spa_ai.scoring.rank_candidates` (one scale for the pool) |
| waiting / unallocated reasons, explanations | `app.automation.allocation.waiting_reason`, `explain`, `REASON_TEXT` |
| evaluation grade | `spa_ai.report_eval.grade_for` (same bands as the DB `grade` column) |
| reading the reference files | `app.modules.imports.parse_upload` (the IMP-01/02 parser) |

`scripts/synthetic/allocation.py` replays the ADR-017 job control flow without a database. It mirrors only
what is SQL-coupled in `app.automation.allocation`:

- `ready_projects`: published, processing `ready`, supervisor assigned.
- `unassigned_trainees` ordering: enrolment, then id.
- `allocate_cycle`: pending replacements first, then each waiting trainee's best non-rejected project.
- `replace_one`: rank the unassigned, non-excluded pool and offer the project to rank 1.

Every decision inside those loops is a call into the functions above. Groq is never used for any label.

**Capacity.** ADR-017 removed project capacity: many trainees may work on the same project individually. The
allocation problem therefore decomposes per trainee, and each trainee's best eligible project *is* the
optimum of the total-score objective. The validator checks this for every ordinary allocation
(`best_eligible_is_optimal`). The workbook's "Max Trainee Capacity" is kept as `legacy_max_trainees`
(history only, never enforced), so there are no `capacity_before/after` columns. Re-introducing a capacity
solver would contradict the approved ADR, so the generator does not.

**Recommendation ≠ allocation.** `allocation_results.assignment_source` is one of:

- `auto_best_eligible`: the trainee's own best eligible project.
- `replacement_ranked`: another trainee rejected the project, and this trainee ranked first among waiting trainees.
- `none`: no feasible assignment, with `unallocated_reason`.

`best_individual_project_*` is the pure recommendation. `why_not_best_individual` explains every difference.
There are no manual overrides: ADR-017 removed general manual allocation.

**Mode subtlety (production behaviour).** A replacement stores the score from `rank_candidates`. When the
pool contains any profile-only trainee, that score is the profile-mode score even for a fully assessed
trainee. Re-score allocations with their own `match_mode`.

## 3. How records are generated

- **Trades.** The workbook's six trades plus Electronics Mechanic, Refrigeration and Air Conditioner
  Technician, and Plumber. About 8% of trainees and some projects have two or three trades.
- **Trainees.** Each trainee draws from its own seeded stream, so trainee 17 is identical at any size.
  - Archetypes: strong, average, needs improvement, skilled with low marks, high marks with little
    evidence, and just below a common practical minimum.
  - Marks are anchored on the workbook means (theory 81.75, practical 86.25, safety 92.33), correlated but not
    identical.
  - 12% have no verified marks (profile mode) and 8% have partial marks.
  - Skills come from the trade's vocabulary, with spelling variants (`TIG` for `TIG Welding`), occasional
    adjacent-trade skills, and an evidence level (`assessed`, `project`, `self_reported`).
  - Whether a variant still matches a prerequisite is decided by the scorer, not assumed.
- **Projects.** 43 hand-written templates (the workbook's eight included), each with trade-appropriate
  prerequisites, plus a beneficiary.
  - The difficulty sets the practical minimum: beginner 0–60, intermediate 65–78, advanced 78–88.
  - 18% have an explicit minimum match.
  - Catalogue status: 80% published, 10% draft, 10% archived.
  - Brief links use the reserved `synthetic.invalid` domain.
- **Demographics.** Fictional name, gender and centre come from a separate random stream. They are never
  passed to the scorer, the allocation replay or any LLM input. Names that match a workbook name are
  rejected, and the validator re-checks this. `fairness_reporting_only` in the report shows assigned rates
  by gender. They should be flat, and they are.
- **Scenarios.** 30 synthetic cycles cycle through eight types: `balanced`, `scarce_projects`,
  `advanced_heavy`, `rejection_wave`, `projects_not_ready`, `near_threshold`, `pending_assessments` and
  `replacement_competition`. The timeline runs:
  1. Wave-1 import, then allocation.
  2. Early rejections, each followed immediately by `replace_rejection` and `allocate_cycle`.
  3. Wave-2 import, then allocation (pending replacements first).
  4. Late rejections.
  5. Wave-3 import, then allocation.
  6. A final scheduled tick.
- **Submissions and evaluations** exist only for final active allocations.
  - Dates fall after the allocation and before the deadline.
  - Rubric: workmanship 25, functional demo 25, safety/SOP 15, documentation 15, viva 20, checked against
    the DB constraints.
  - Totals are summed from the components, and grades come from `grade_for`.
  - Totals under 50 lead to `rework_requested` and a new submission version.
  - Rubric quality depends on the trainee's verified marks plus noise. It never depends on the match score,
    so outcomes are not a relabelled copy of compatibility and must not be used as compatibility labels.

## 4. Files

| File | One row per |
|---|---|
| `trainees.csv`, `projects.csv` | entity (with `home_split`) |
| `scenarios.csv` | scenario: type, split, timeline, settings, tick log |
| `scenario_projects.csv` | scenario × project: status, processing, `allocatable`, pipeline reasons, trainees working |
| `candidate_pairs.csv` | scenario × enrolled trainee × scenario project: factors, score, gates, eligibility, rank |
| `recommendations.csv` | top-5 `rank_pairs` rows per trainee per scenario, with factor details |
| `allocations.csv` | every allocation row, including rejected ones (as in `app.allocations`) |
| `rejections.csv` | rejection + replacement outcome and ranking snapshot |
| `allocation_results.csv` | final state per trainee per scenario |
| `submissions.csv`, `evaluations.csv` | optional |
| `llm/<task>/<split>.jsonl` | LLM examples (section 5) |
| `schema/*.json` | JSON Schemas for the main tables and every LLM input/target |
| `import/SCN-xxxx_{trainees,projects}.csv` | `--formats import`: dataset-format files for the admin importer |
| `inspection.xlsx` | `--formats xlsx`: convenience workbook (not canonical) |
| `manifest.json` | parameters, seed, versions, reference stats, split manifest, row counts, SHA-256 |
| `validation_report.json`, `README.md` | data-quality report and dataset card |

Conventions: UTF-8 and `\n` line endings. Empty cell = missing. Booleans are `true`/`false`. List columns
are JSON arrays.

`eligible` in `candidate_pairs` means the scorer gates pass **and** the project is allocatable.
`ineligible_reasons` merges the scorer codes with pipeline codes (`project_not_published`,
`project_archived`, `project_processing_not_ready`, `project_no_supervisor`).

## 5. LLM-ready examples

Three tasks, each with strict Pydantic input/target models (`extra="forbid"`, see `schema/`):

- **A `rank_projects`.** Input: privacy-safe profile, candidate projects (every ready project sharing a
  trade, plus two that don't), and engine facts. Target: eligible projects ranked by score, a
  factor-grounded explanation for each, and gate reasons for the others.
- **B `explain_allocation`.** Explains an allocation the rules already made, including replacement rank
  and pool, rejected projects, why it differs from the best individual match, or why the trainee is
  waiting. It never claims an optimisation the engine did not run.
- **C `decision_output`.** Strict JSON with `recommended_project_codes` (top 3 eligible) kept separate from
  `final_assignment` (project, source, allocation ref, unallocated reason), plus per-project eligibility.

Inputs never contain name, trainee code, gender, centre or email (enforced at build time and re-checked).
Builders raise on any inconsistency instead of repairing a label. Every target is reproducible from the
engine. These examples measure whether a model reproduces the deterministic engine. **They say nothing
about real placement quality.**

**Dataset D (optional fine-tuning format).**
`uv run python -m scripts.synthetic.sft_export ../data/synthetic --task rank_projects --split train`
writes `sft/<task>.<split>.chat.jsonl` (`messages`: system, user, assistant). It only writes local files,
re-validates every example, and uploads nothing. Fine-tuning needs a provider that supports training your
chosen model. Groq-hosted inference is not assumed to.

## 6. Splits and leakage

Trainees and projects are partitioned 70/15/15 (stratified by primary trade). Scenarios are assigned 20/5/5
and sample **only** from their own split's pools. A scenario, trainee or project therefore never appears in
two splits (`pair_split_consistent`, and a unit test). All pairs and examples of a scenario share its split.
The split manifest is in `manifest.json`. The validator warns when the test split has fewer than 5 scenarios
or 2,000 pairs. Labels never use Groq, demographics or later evaluation outcomes.

## 7. Validation

`validation_report.json` is written after every run. These failures are critical and exit 1:

- **Identity:** duplicate ids or codes; unknown trades; out-of-range marks or rubric scores;
  inconsistent assessment status.
- **Pairs:** broken foreign keys; duplicate pairs.
- **Scores:** a pair whose re-score with `score_pair` differs; Σ factors ≠ score; wrong ranks.
- **Allocations:**
  - an allocation to a non-allocatable or ineligible project, or to a project the trainee rejected
  - more than one active allocation per trainee
  - an ordinary allocation that is not the trainee's optimum
  - an unallocated trainee who had an eligible project, or whose reason disagrees with `waiting_reason`
  - an inconsistent replacement
- **Submissions:** submission/evaluation foreign keys and timelines; totals ≠ sum; grade ≠ `grade_for`.
- **LLM examples:** malformed JSONL; schema violations; unknown project codes; personal fields in an input.
- **Data hygiene:** split leakage; unmarked records; names or ids copied from the workbook.

The report also lists:

- row counts per file, unique entities and trade combinations
- the eligibility and reason distribution, assigned/unallocated counts and reasons
- project utilisation, score distributions, missing-value rates
- per-split counts, the seed and the generator version

## 8. Loading into a local or test environment

There is no automatic database insertion. To try a scenario in a **local/dev** stack:

1. Generate with `--formats csv,jsonl,import`.
2. As an admin, open the import screen and upload `import/SCN-0001_trainees.csv`, then
   `SCN-0001_projects.csv`, to a test cycle. Run the **dry run** first.

Notes:

- The files use the dataset's columns, including the title row the parser skips.
- `min_match_score` and scenario-specific project statuses are not importer columns.
- Projects then go through the normal ADR-017 processing; the `synthetic.invalid` brief links are not
  reachable.
- Never import into production. `scripts.seed --reset` is unrelated and is never run by the generator.

## 9. Limitations and bias risks

- The vocabulary, templates, archetype mix and score distributions are hand-designed and anchored on 12
  reference trainees. They are plausible, not measured from a real cohort.
- Labels encode the current rules (`scoring-2`, ADR-017). A model trained on them learns those rules,
  including their blind spots. For example, token overlap undervalues synonyms such as "PV" vs
  "Photovoltaic". When the scorer or policy changes, regenerate.
- Rubric outcomes come from a simple marks-plus-noise model. Do not draw conclusions about real
  performance from them.
- Demographics are independent of everything by construction. Flat fairness numbers here say nothing about
  fairness on real data.
