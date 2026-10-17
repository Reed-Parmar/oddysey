"""Synthetic dataset generator for trainee-to-project matching (docs/synthetic-data.md).

Ground truth comes from the production code: ``spa_ai.scoring`` for scores, eligibility and ranking, and
the ADR-017 allocation rules in ``app.automation.allocation`` (replayed without a database by
``scripts.synthetic.allocation``). Nothing here talks to a database, Supabase Storage or Groq.
"""

GENERATOR_VERSION = "synthetic-1"
