"""Behaviour checks for the originality analysis. These fixtures exercise the rules; they are not
accuracy measurements."""

from __future__ import annotations

import json

from spa_ai.originality import PIPELINE_VERSION, SHINGLE_SIZE, AttentionBands, CorpusDoc, analyse

REPORT_A = (
    "For my project I installed a single phase motor starter in the workshop panel.\n"
    "First I checked the supply voltage with a multimeter and noted it was steady at 230 volts.\n"
    "Then I mounted the contactor and overload relay on a DIN rail and tightened every screw.\n"
    "My instructor asked me to label each wire so that later fault finding would be quicker.\n"
    "After wiring the start and stop push buttons I tested the circuit without the motor.\n"
    "When the coil energised correctly I connected the motor and recorded its running current.\n"
    "The overload relay was set slightly above the full load current shown on the nameplate.\n"
    "I learned that neat wiring and careful testing save a lot of time during commissioning."
)

REPORT_B = (
    "Our group of tools for this task included a clamp meter, insulation tester and screwdrivers.\n"
    "I began by drawing the control diagram on paper and asking my trainer to verify it.\n"
    "Next the enclosure was drilled for glands and the earth bar was fixed near the bottom.\n"
    "Insulation resistance between phase and earth measured more than fifty megaohms here.\n"
    "Because the pump motor sometimes runs dry, I added a float switch in series with stop.\n"
    "Commissioning took two days since the supplied cable lugs were the wrong size for us.\n"
    "Finally I wrote a maintenance checklist that the hostel staff can follow every month.\n"
    "This experience improved my confidence in reading diagrams and handling field problems."
)

ORIGINAL_C = (
    "Solar street lights in our village often failed during the monsoon season last year.\n"
    "I surveyed twelve poles and found water inside most battery boxes after heavy rain.\n"
    "Replacing the rubber gaskets and raising the boxes reduced the failures noticeably.\n"
    "I also cleaned the panels because dust and bird droppings reduce the charging current.\n"
    "Measurements before and after cleaning showed a clear improvement in battery voltage.\n"
    "The panchayat agreed to buy spare gaskets so the fix can continue after I leave.\n"
)

COPIED_PARAGRAPH = (
    "A distinctive observation was that the earth leakage breaker tripped only on humid "
    "mornings, which pointed to moisture creeping into the junction box beside the borewell "
    "pump and slowly lowering the insulation of the old joint."
)

BRIEF = (
    "Project brief: Design and install a motor control panel with direct online starter. "
    "Trainees must document the wiring diagram, the list of materials used, the safety "
    "precautions followed, the testing procedure and the final commissioning results. "
    "The report should explain the role of the contactor, the overload relay and the push "
    "buttons, and describe how faults were identified and corrected during the work. "
    "Each trainee must also reflect on the skills learned and any difficulties faced on site."
)


def doc(id_: str, owner: str, text: str, **kw: object) -> CorpusDoc:
    return CorpusDoc(id=id_, owner=owner, kind=kw.pop("kind", "submission"), text=text, **kw)  # type: ignore[arg-type]


def run(target: str, corpus: list[CorpusDoc] | None = None, **kw: object) -> dict:
    return analyse(
        target_text=target,
        target_owner=kw.pop("owner", "t1"),  # type: ignore[arg-type]
        corpus=corpus or [],
        shared_materials=kw.pop("shared", []),  # type: ignore[arg-type]
        own_previous=kw.pop("own", []),  # type: ignore[arg-type]
        **kw,  # type: ignore[arg-type]
    )


def test_exact_copy_from_another_person() -> None:
    r = run(REPORT_A, [doc("s2", "t2", REPORT_A, label="Submission v1")])
    assert r["status"] == "completed"
    assert r["overlap_pct"] == 100.0
    assert r["exact_duplicates"]["normalized_other_person"] == ["s2"]
    assert r["exact_duplicates"]["own_previous_version"] is False
    assert r["finding"] == "potential_text_overlap"
    assert r["attention_band"] == "high"
    assert "misconduct" in r["finding_reason"] and "potential" in r["finding_reason"]
    assert r["sources"][0]["source_id"] == "s2" and r["sources"][0]["coverage_pct"] == 100.0
    assert r["pipeline_version"] == PIPELINE_VERSION and r["shingle_size"] == SHINGLE_SIZE
    json.dumps(r)


def test_same_owner_goes_to_self_reuse() -> None:
    r = run(REPORT_A, [doc("s1", "t1", REPORT_A), doc("s3", "t3", REPORT_B)])
    assert [s["source_id"] for s in r["sources"]] == []
    assert r["overlap_pct"] < 15
    assert r["self_reuse"]["overlap_pct"] == 100.0
    assert r["exact_duplicates"]["own_previous_version"] is True
    assert r["exact_duplicates"]["normalized_other_person"] == []


def test_own_previous_versions_reported_separately() -> None:
    r = run(REPORT_A, own=[doc("v1", "t1", REPORT_A)])
    assert r["self_reuse"]["overlap_pct"] == 100.0
    assert r["overlap_pct"] == 0.0
    no_own = run(REPORT_A)
    assert no_own["self_reuse"]["overlap_pct"] is None and no_own["self_reuse"]["note"]


def test_shared_brief_copied_by_two_trainees_is_excluded() -> None:
    target = BRIEF + "\n" + REPORT_A
    other = BRIEF + "\n" + REPORT_B
    r = run(target, [doc("s2", "t2", other)], shared=[BRIEF])
    assert r["tokens"]["excluded_by_reason"]["shared_material"] > 0
    assert r["overlap_pct"] is not None and r["overlap_pct"] < 15
    assert r["finding"] == "same_brief_expected_overlap"
    # without the brief as shared material, the same text would be flagged
    flagged = run(target, [doc("s2", "t2", other)])
    assert flagged["overlap_pct"] > r["overlap_pct"]


def test_mostly_brief_gives_insufficient_evidence_not_clean_zero() -> None:
    target = BRIEF + "\nI did the work as described."
    r = run(target, [doc("s2", "t2", BRIEF)], shared=[BRIEF])
    assert r["status"] == "insufficient_text"
    assert r["overlap_pct"] is None
    assert "shared material" in r["overlap_reason"]
    assert r["finding"] == "insufficient_evidence"
    assert r["attention_band"] is None


def test_independent_implementations_have_low_overlap() -> None:
    r = run(REPORT_A, [doc("s2", "t2", REPORT_B)], shared=[BRIEF])
    assert r["status"] == "completed"
    assert r["overlap_pct"] < 5
    assert r["finding"] == "no_significant_overlap"
    assert r["attention_band"] == "low"


def test_global_overlap_is_union_not_sum() -> None:
    lines = REPORT_A.split("\n")
    src1 = "\n".join(lines[:5])  # lines 0-4
    src2 = "\n".join(lines[3:])  # lines 3-7, overlaps src1 on lines 3-4
    r = run(REPORT_A, [doc("x1", "t2", src1), doc("x2", "t3", src2)])
    cov = {s["source_id"]: s["coverage_pct"] for s in r["sources"]}
    assert set(cov) == {"x1", "x2"}
    assert cov["x1"] + cov["x2"] > 100
    assert r["overlap_pct"] == 100.0
    assert r["distinct_source_count"] == 2


def test_short_quote_excluded_long_quote_not() -> None:
    quote = '"Safety first means isolating the supply before touching any terminal."'
    target = REPORT_A + "\nAs the manual says, " + quote + " (ITI Electrician Manual, 2020)"
    r = run(target)
    assert r["tokens"]["excluded_by_reason"]["quotation"] == 10

    long_quote = "“" + " ".join(REPORT_A.split("\n")) + "”"
    r2 = run(long_quote, [doc("s2", "t2", REPORT_A)])
    assert r2["tokens"]["excluded_by_reason"]["quotation"] == 0
    assert r2["overlap_pct"] == 100.0
    assert any("Quotations longer" in lim for lim in r2["limitations"])


def test_bibliography_excluded() -> None:
    refs = (
        "References:\n"
        "Bureau of Indian Standards, Code of practice for electrical wiring installations, 2018.\n"
        "Directorate General of Training, Electrician trade theory second year, New Delhi.\n"
    )
    r = run(REPORT_A + "\n" + refs, [doc("s2", "t2", refs)])
    assert r["tokens"]["excluded_by_reason"]["bibliography"] >= 20
    assert r["overlap_pct"] == 0.0
    assert r["sources"] == []


def test_short_generic_lines_excluded() -> None:
    r = run("Introduction\nAim:\n" + REPORT_A)
    assert r["tokens"]["excluded_by_reason"]["short_generic"] == 2


def test_short_or_empty_text_is_insufficient() -> None:
    for text in ("", "Motor starter wiring done and tested ok."):
        r = run(text, [doc("s2", "t2", REPORT_A)])
        assert r["status"] == "insufficient_text"
        assert r["overlap_pct"] is None and r["overlap_reason"]
        assert r["finding"] == "insufficient_evidence"


def test_exact_short_match() -> None:
    r = run("Panel wired ok\nand tested", [doc("s2", "t2", "panel wired OK and tested")],
            min_eligible_tokens=1)
    # all lines are short, nothing eligible -> insufficient; with a 4-token line it matches
    assert r["status"] == "insufficient_text"
    r2 = run("Panel wired and tested", [doc("s2", "t2", "panel WIRED and tested")],
             min_eligible_tokens=1)
    assert r2["overlap_pct"] == 100.0
    assert r2["sources"][0]["passages"][0]["method"] == "exact_short"


def test_non_latin_text_unsupported() -> None:
    hindi = "मैंने मोटर स्टार्टर पैनल को तार से जोड़ा और परीक्षण किया। " * 20
    r = run(hindi, [doc("s2", "t2", hindi)])
    assert r["language"]["supported"] is False
    assert r["status"] == "insufficient_text"
    assert r["overlap_pct"] is None
    assert r["finding"] == "insufficient_evidence"
    assert r["sources"] == []


def test_inserted_copied_paragraph_located_in_original_text() -> None:
    target = ORIGINAL_C + COPIED_PARAGRAPH + "\n" + REPORT_B
    source = REPORT_A + "\n" + COPIED_PARAGRAPH + "\nThat was the end of the fault story."
    r = run(target, [doc("s9", "t9", source)])
    assert r["status"] == "completed"
    assert 0 < r["overlap_pct"] < 50
    [src] = r["sources"]
    passage = max(src["passages"], key=lambda p: p["tokens"])
    sliced = target[passage["target_start"] : passage["target_end"]]
    assert sliced == COPIED_PARAGRAPH.rstrip(".")
    assert source[passage["source_start"] : passage["source_end"]] == sliced
    assert len(passage["target_excerpt"]) <= 300


def test_binary_hash_duplicate() -> None:
    r = run(REPORT_A, [doc("s2", "t2", REPORT_B, binary_hash="abc")], target_binary_hash="abc")
    assert r["exact_duplicates"]["binary_other_person"] == ["s2"]
    r2 = run(REPORT_A, own=[doc("v1", "t1", "x", binary_hash="abc")], target_binary_hash="abc")
    assert r2["exact_duplicates"]["own_previous_version"] is True
    assert r2["exact_duplicates"]["binary_other_person"] == []


def test_deterministic() -> None:
    corpus = [doc("b", "t2", REPORT_A), doc("a", "t3", REPORT_A), doc("c", "t4", REPORT_B)]
    first = run(REPORT_A, corpus, shared=[BRIEF])
    assert first == run(REPORT_A, corpus, shared=[BRIEF])
    assert [s["source_id"] for s in first["sources"]] == ["a", "b"]


def test_attention_bands_configurable() -> None:
    target = ORIGINAL_C + COPIED_PARAGRAPH + "\n" + REPORT_B
    corpus = [doc("s9", "t9", COPIED_PARAGRAPH + "\nUnrelated closing words for the record here.")]
    default = run(target, corpus)
    pct = default["overlap_pct"]
    assert default["attention_band"] == AttentionBands().band(pct)
    strict = AttentionBands(version="bands-test", medium_at=1.0, high_at=pct)
    r = run(target, corpus, bands=strict)
    assert r["attention_band"] == "high"
    assert r["bands_version"] == "bands-test"
    assert r["bands"] == {"medium_at": 1.0, "high_at": pct}
    assert r["finding"] == "potential_text_overlap"


def test_empty_corpus_completes_with_limitation() -> None:
    r = run(REPORT_A, [])
    assert r["status"] == "completed"
    assert r["overlap_pct"] == 0.0
    assert r["sources"] == [] and r["distinct_source_count"] == 0
    assert any("empty corpus" in lim for lim in r["limitations"])
    assert r["code"]["status"] == "not_assessed"


def test_reference_documents_compared_even_with_blank_owner() -> None:
    r = run(REPORT_A, [doc("ref1", "", REPORT_A, kind="reference")], owner="")
    assert r["sources"][0]["kind"] == "reference"
    assert r["self_reuse"]["overlap_pct"] is None
