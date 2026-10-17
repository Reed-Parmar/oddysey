"""Generate the synthetic trainee/project matching dataset (docs/synthetic-data.md).

    uv run python -m scripts.generate_synthetic_data                       # defaults: 1000 / 100 / 30, seed 42
    uv run python -m scripts.generate_synthetic_data --trainees 60 --projects 12 --scenarios 3 --out ../data/small
    uv run python -m scripts.generate_synthetic_data --formats csv,jsonl,xlsx,import --force

No database, Storage or Groq access: labels come from spa_ai.scoring and the ADR-017 allocation rules.
Exit codes: 0 generated and valid, 1 critical validation failure, 2 bad arguments or inputs.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

from scripts.synthetic.generate import FORMATS, Config, GenerationError, generate
from scripts.synthetic.validate import validate

ROOT = Path(__file__).resolve().parents[2]


def dataset_card(manifest: dict, report: dict | None) -> str:
    files = "\n".join(f"| `{rel}` | {meta['rows']} |" for rel, meta in manifest["files"].items() if meta["rows"])
    status = "not run" if report is None else ("PASSED" if report["passed"] else "FAILED")
    p = manifest["parameters"]
    return f"""# Synthetic ITI matching dataset

**Every record is synthetic.** Trainees, names, centres, projects, submissions and evaluations are generated;
none of them is real Tata STRIVE data. Labels come from the production scorer (`{manifest["scoring_version"]}`) and
the ADR-017 allocation rules (`{manifest["allocation_policy"]}`), not from an LLM.

- Generator: `{manifest["generator_version"]}`, seed `{manifest["seed"]}`
- Size: {p["trainees"]} trainees, {p["projects"]} projects, {p["scenarios"]} scenarios
- Validation: **{status}** (see `validation_report.json`)
- Reproduce: `cd backend && uv run python -m scripts.generate_synthetic_data --trainees {p["trainees"]} \\
  --projects {p["projects"]} --scenarios {p["scenarios"]} --seed {manifest["seed"]} --force`
- Documentation: `docs/synthetic-data.md` in the repository

| File | Rows |
|---|---|
{files}

These examples show that a model reproduces the deterministic engine. They say nothing about real-world
placement quality.
"""


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--trainees", type=int, default=1000)
    ap.add_argument("--projects", type=int, default=100)
    ap.add_argument("--scenarios", type=int, default=30)
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--out", type=Path, default=ROOT / "data" / "synthetic", help="output directory")
    ap.add_argument("--formats", default="csv,jsonl", help=f"comma list of {', '.join(FORMATS)} (csv is required)")
    ap.add_argument("--no-submissions", action="store_true", help="skip synthetic submissions and evaluations")
    ap.add_argument("--no-llm", action="store_true", help="skip the LLM example datasets")
    ap.add_argument("--no-validate", action="store_true", help="skip validation after generation")
    ap.add_argument("--workbook", type=Path, default=ROOT / "CSR_Hackathon_ITI_Project_Dataset.xlsx")
    ap.add_argument(
        "--trainee-csv",
        type=Path,
        default=None,
        help="optional extra reference trainee CSV (dataset columns; a title and blank rows are fine)",
    )
    ap.add_argument("--force", action="store_true", help="replace a dataset previously written by this generator")
    ap.add_argument("--quiet", action="store_true")
    args = ap.parse_args(argv)

    cfg = Config(
        trainees=args.trainees,
        projects=args.projects,
        scenarios=args.scenarios,
        seed=args.seed,
        out=args.out,
        formats=tuple(f.strip() for f in args.formats.split(",") if f.strip()),
        submissions=not args.no_submissions,
        llm=not args.no_llm,
        workbook=args.workbook,
        trainee_csv=args.trainee_csv,
        force=args.force,
        quiet=args.quiet,
    )
    started = time.perf_counter()
    try:
        manifest = generate(cfg)
    except GenerationError as e:
        print(f"error: {e}", file=sys.stderr)
        return 2
    out = cfg.out.resolve()
    report = None if args.no_validate else validate(out, cfg.workbook)
    (out / "README.md").write_text(dataset_card(manifest, report), encoding="utf-8", newline="\n")
    took = time.perf_counter() - started
    if not args.quiet:
        print(f"wrote {out} in {took:.1f}s")
        for rel, meta in manifest["files"].items():
            if meta["rows"]:
                print(f"  {rel:<48} {meta['rows']:>8} rows")
    if report is None:
        return 0
    print(f"validation: {'PASSED' if report['passed'] else 'FAILED'} ({report['checks_run']} checks)")
    for w in report["warnings"]:
        print(f"  warning: {w}")
    for name, items in report["critical_failures"].items():
        print(f"  FAILED {name}: {json.dumps(items[:3])}")
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    sys.exit(main())
