"""Printable HTML for a Plagiarism & Originality Analysis (ADR-017 §9.6).

Renders exactly the persisted (and viewer-redacted) findings plus the current review state; every
value is HTML-escaped.
"""

import html
from typing import TYPE_CHECKING

from app.db import models as M
from app.db.enums import GRADE_LABELS

if TYPE_CHECKING:
    from app.modules.submissions import AnalysisOut


def render_report_html(sub: M.Submission, v: "AnalysisOut", staff: bool = True) -> str:
    """`staff=False` (a student, ADR-028): the originality, corpus, semantic and AI-writing sections are omitted."""
    e = html.escape
    o = v.originality or {}
    ev = v.evaluation or {}
    tok = o.get("tokens") or {}
    rows = "".join(
        f"<tr><td>{e(str(s.get('label') or ''))}</td><td>{s.get('matched_tokens')}</td><td>{s.get('coverage_pct')}%</td></tr>"
        for s in o.get("sources", [])
    )
    passages = "".join(
        f"<li><blockquote>{e(str(p.get('target_excerpt') or ''))}</blockquote>"
        + (
            f"<p class=src>Source: {e(str(p.get('source_excerpt')))}</p>"
            if p.get("source_excerpt")
            else "<p class=src>Source text withheld</p>"
        )
        + "</li>"
        for s in o.get("sources", [])
        for p in s.get("passages", [])[:10]
    )
    crit = "".join(
        f"<tr><td>{e(c['label'])}</td><td>{c['points']} / {c['max_points']}</td><td>{e(c.get('explanation') or '')}</td></tr>"
        for c in v.effective_criteria
    )
    sugg = "".join(
        f"<li><b>{e(s.get('issue', ''))}</b><br>Why it matters: {e(s.get('why_it_matters', ''))}<br>Steps: "
        f"{e('; '.join(s.get('steps', [])))}<br>Expected benefit: {e(s.get('expected_benefit', ''))}</li>"
        for s in ev.get("suggestions", [])
    )
    reviews = "".join(
        f"<li>{e(r.created_at[:16])} — {e(r.reviewer)}: {e(r.action)} — {e(r.note)}</li>" for r in v.reviews
    )
    lims = "".join(f"<li>{e(x)}</li>" for x in (o.get("limitations") or []) + (ev.get("limitations") or []))
    overlap = "Not computed" if o.get("overlap_pct") is None else f"{o['overlap_pct']}%"
    originality_html = (
        f"""<h2>Text overlap (potential overlap requiring contextual review)</h2>
<p>Overlap: <b>{e(overlap)}</b> {("(" + e(o.get("overlap_reason") or "") + ")") if o.get("overlap_pct") is None else ""}
· attention band: {e(str(o.get("attention_band")))} (review heuristic {e(str(o.get("bands_version")))}, not a probability)</p>
<p>Method: {e(str(o.get("method", "")))}<br>Formula: {e(str(o.get("formula", "")))}<br>
Eligible words: {tok.get("eligible")} · excluded: {tok.get("excluded")} ({tok.get("excluded_pct")}%) by reason {e(str(tok.get("excluded_by_reason")))}</p>
<p>Finding: <b>{e(str(o.get("finding")))}</b> — {e(str(o.get("finding_reason", "")))}</p>
<p>Corpus: {e(str((v.corpus or {}).get("scope", "")))} Items: {(v.corpus or {}).get("items")}.</p>
<table><tr><th>Source</th><th>Matched words</th><th>Coverage</th></tr>{rows or "<tr><td colspan=3>No matching sources</td></tr>"}</table>
<h3>Matching passages</h3><ol>{passages or "<li>None</li>"}</ol>
<h2>Concept / paraphrase similarity</h2><p>{e(str((v.semantic or {}).get("reason", "Not assessed")))}</p>
<h2>Code similarity</h2><p>{e(str((o.get("code") or {}).get("reason", "Code similarity not assessed")))}</p>
<h2>AI-writing assessment</h2><p>{e(str((v.ai_writing or {}).get("reason", "Not available")))}</p>
"""
        if staff
        else ""
    )
    total = ev.get("total")
    grade = ev.get("grade")
    title = "Plagiarism &amp; Originality Analysis" if staff else "Automated Report Evaluation"
    return f"""<!doctype html><html lang="en"><head><meta charset="utf-8"><title>{title}</title>
<style>body{{font:14px/1.5 system-ui,sans-serif;max-width:900px;margin:24px auto;padding:0 16px;color:#111}}
table{{border-collapse:collapse;width:100%}}td,th{{border:1px solid #ccc;padding:4px 8px;text-align:left;vertical-align:top}}
blockquote{{margin:4px 0;padding:4px 8px;background:#fff7d6}}.src{{color:#555;font-size:12px}}.muted{{color:#555}}
@media print{{a{{color:#000}}}}</style></head><body>
<h1>{title}</h1>
<p class=muted>Project {e(sub.allocation.project.project_code)} · version {sub.version} · analysis revision {v.revision} ·
status <b>{e(v.status.value)}</b>{(" — " + e(v.status_reason)) if v.status_reason else ""} · review: {e(v.review_state)}</p>
<p class=muted>Pipeline {e(v.pipeline_version)} · input hash {e((v.input_hash or "")[:16])} · finished {e(v.finished_at or "—")}</p>
{originality_html}<h2>Automated report evaluation (documented evidence only)</h2>
<p>Status: {e(str(ev.get("status")))} · total: {total if total is not None else "—"} / {ev.get("max_total", 100)} ·
automated report grade: {e(GRADE_LABELS.get(grade or "", grade or "—"))}{" · supervisor-amended" if v.amended else ""}</p>
<table><tr><th>Criterion</th><th>Points</th><th>Explanation</th></tr>{crit}</table>
<h2>Improvements</h2><ol>{sugg or "<li>No suggestions recorded</li>"}</ol>
<h2>Review history</h2><ul>{reviews or "<li>Not reviewed yet</li>"}</ul>
<h2>Limitations</h2><ul>{lims}</ul>
</body></html>"""
