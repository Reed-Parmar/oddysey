"""Optional: convert validated examples to chat-format JSONL for supervised fine-tuning (Dataset D).

    uv run python -m scripts.synthetic.sft_export ../data/synthetic --task rank_projects --split train

Writes ``<dir>/sft/<task>.<split>.chat.jsonl`` with ``{"messages": [system, user, assistant]}`` records (the
shape most chat fine-tuning APIs accept). It only writes local files and never uploads anything. Check that
your training provider supports fine-tuning the model you choose; Groq-hosted inference is not assumed to.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from scripts.synthetic.llm import validate_example

SYSTEM = {
    "rank_projects": (
        "You rank ITI trainee projects. Use only the engine facts provided: rank eligible projects by score "
        "(ties by project code), explain each with its factors, and list the gate reasons for ineligible ones. "
        "Reply with JSON only."
    ),
    "explain_allocation": (
        "You explain an allocation that the deterministic allocation rules already made. Do not change the "
        "decision and do not claim to have run any optimisation. Reply with JSON only."
    ),
    "decision_output": (
        "Return the strict decision JSON. Recommendations and the final assignment are different things; "
        "use only the allowed project codes. Reply with JSON only."
    ),
}


def export(root: Path, task: str, split: str) -> tuple[Path, int]:
    src = root / "llm" / task / f"{split}.jsonl"
    if not src.is_file():
        raise FileNotFoundError(src)
    manifest = json.loads((root / "manifest.json").read_text(encoding="utf-8"))
    codes = {line.split(",", 2)[1] for line in (root / "projects.csv").read_text(encoding="utf-8").splitlines()[1:]}
    dest = root / "sft" / f"{task}.{split}.chat.jsonl"
    dest.parent.mkdir(parents=True, exist_ok=True)
    n = 0
    with src.open(encoding="utf-8") as f, dest.open("w", encoding="utf-8", newline="\n") as out:
        for line in f:
            ex = json.loads(line)
            errors = validate_example(ex, codes)
            if errors:  # reject, never repair
                raise ValueError(f"{src.name}: invalid example: {errors[0]}")
            rec = {
                "messages": [
                    {"role": "system", "content": SYSTEM[task]},
                    {"role": "user", "content": json.dumps(ex["input"], ensure_ascii=False)},
                    {"role": "assistant", "content": json.dumps(ex["target"], ensure_ascii=False)},
                ],
                "metadata": {
                    "example_id": ex["example_id"],
                    "generator_version": manifest["generator_version"],
                    "synthetic_record": True,
                },
            }
            out.write(json.dumps(rec, ensure_ascii=False) + "\n")
            n += 1
    return dest, n


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Export synthetic LLM examples to chat-format JSONL (local only)")
    ap.add_argument("dir", type=Path)
    ap.add_argument("--task", choices=sorted(SYSTEM), required=True)
    ap.add_argument("--split", choices=("train", "validation", "test"), required=True)
    args = ap.parse_args(argv)
    try:
        dest, n = export(args.dir, args.task, args.split)
    except (FileNotFoundError, ValueError) as e:
        print(f"error: {e}", file=sys.stderr)
        return 2
    print(f"wrote {n} records to {dest}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
