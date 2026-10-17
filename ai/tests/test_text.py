import pytest

from spa_ai.text import jaccard, tokenize


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("HTML/CSS", {"html", "css"}),
        ("Dual-Axis", {"dual", "axi"}),
        ("TIG/MIG Welding", {"tig", "mig", "welding"}),
        ("Renewable Energy Systems", {"renewable", "energy", "system"}),
        ("motors modules", {"motor", "module"}),
        ("css ops iot class", {"css", "ops", "iot", "class"}),
        ("Pipe & Sheet Metal Welding", {"pipe", "sheet", "metal", "welding"}),
        ("The art of IT is in the Data", {"art", "data"}),
        ("Café 100%", {"caf", "100"}),
        ("as is", set()),
        ("", set()),
        (None, set()),
    ],
)
def test_tokenize_examples(text, expected):
    assert tokenize(text) == frozenset(expected)


def test_stopword_check_happens_before_plural_rule():
    # "intos" is not a stop-word; after stripping it becomes "into" but is kept.
    assert tokenize("intos") == frozenset({"into"})


def test_jaccard():
    assert jaccard(frozenset(), frozenset()) == 0.0
    assert jaccard(tokenize("Circuit Wiring"), tokenize("Solar Wiring")) == pytest.approx(1 / 3)
    assert jaccard(tokenize("a b"), tokenize("b c")) == 0.5  # 'a' is a stop-word
    assert jaccard(frozenset({"x"}), frozenset({"x"})) == 1.0
