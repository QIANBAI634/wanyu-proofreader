#!/usr/bin/env python3
"""Tests for the corpus probe detectors and their input handling.

Every detector here is a gate someone will eventually trust to say "look at
this row", so each one is pinned from both sides: a value that must hit and the
neighbouring value that must not. The 533/453 pair, the @hex placeholders and
the keyboard repertoire are the places where an over-eager regex would bury
proofreaders in noise, and the leak tests are what keep a diagnostic from
smuggling corpus text into an issue.
"""
import contextlib
import importlib.util
import io
import json
import os
import tempfile
import unittest
import unicodedata
from pathlib import Path

HERE = Path(__file__).resolve().parent


def _load(name):
    spec = importlib.util.spec_from_file_location(name, HERE / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


detectors = _load("detectors")
input_source = _load("input_source")
probe_corpus = _load("probe_corpus")

FIXTURE = HERE / "fixtures" / "mini_corpus.csv"
KEYBOARD = HERE.parents[1] / "backend" / "keyboards" / "hinghwa-dialect.json"


def run_main(args):
    stdout, stderr = io.StringIO(), io.StringIO()
    with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
        code = probe_corpus.main(args)
    return code, stdout.getvalue(), stderr.getvalue()


class ToneRunTests(unittest.TestCase):
    def test_flags_long_run_that_is_not_a_legal_contour(self):
        hits = detectors.detect_illegal_tone_runs("sa1234", "拼音")
        self.assertEqual([detectors.READING_FORMAT_INVALID], [h.kind for h in hits])
        self.assertEqual(["1234"], hits[0].params["runs"])
        self.assertEqual(1, hits[0].params["run_count"])

    def test_legal_three_digit_contours_are_not_flagged(self):
        for value in ("to533", "to453"):
            self.assertEqual([], detectors.detect_illegal_tone_runs(value, "拼音"))

    def test_short_tone_digits_are_ignored(self):
        for value in ("ka55", "ŋa22", "ia1", "zua42"):
            self.assertEqual([], detectors.detect_illegal_tone_runs(value, "拼音"))

    def test_placeholder_hex_is_not_a_flattened_tone(self):
        # @20000 is an all-digit placeholder: 61.6% of Extension-B codepoints
        # written in hex contain a run of three or more digits, so without
        # stripping, every missing-glyph marker would also scream tone damage.
        self.assertEqual([], detectors.detect_illegal_tone_runs("@20000 lu55", "拼音"))
        self.assertEqual(1, len(detectors.detect_missing_glyph_placeholders("@20000 lu55", "拼音")))

    def test_a_real_flattening_next_to_a_placeholder_is_still_caught(self):
        hits = detectors.detect_illegal_tone_runs("@20000 ia9999", "拼音")
        self.assertEqual(["9999"], hits[0].params["runs"])

    def test_empty_value_is_safe(self):
        self.assertEqual([], detectors.detect_illegal_tone_runs("", "拼音"))

    def test_two_bad_runs_in_one_value_are_both_reported(self):
        hits = detectors.detect_illegal_tone_runs("a1234 b9999", "拼音")
        self.assertEqual(["1234", "9999"], hits[0].params["runs"])


class ToneCountTests(unittest.TestCase):
    def test_mismatch_between_pinyin_and_ipa(self):
        hits = detectors.detect_tone_count_mismatch("ka55 hi21", "ka55")
        self.assertEqual(1, len(hits))
        self.assertEqual({"pinyin_count": 2, "ipa_count": 1}, hits[0].params)

    def test_agreement_is_silent(self):
        self.assertEqual([], detectors.detect_tone_count_mismatch("ka55 hi21", "ka55 hi21"))

    def test_a_flattened_superscript_is_left_to_the_tone_run_detector(self):
        self.assertEqual([], detectors.detect_tone_count_mismatch("ŋã22", "ŋa222"))
        self.assertEqual(1, len(detectors.detect_illegal_tone_runs("ŋa222", "莆田IPA")))

    def test_missing_evidence_is_not_guessed(self):
        self.assertEqual([], detectors.detect_tone_count_mismatch("ka55", ""))
        self.assertEqual([], detectors.detect_tone_count_mismatch("", "ka55"))


class PlaceholderTests(unittest.TestCase):
    def test_hex_placeholder_is_reported_with_the_markers(self):
        hits = detectors.detect_missing_glyph_placeholders("@4E2D ia55", "拼音")
        self.assertEqual({"@4E2D"}, set(hits[0].params["marks"]))
        self.assertEqual(1, hits[0].params["mark_count"])

    def test_at_sign_without_hex_is_not_a_placeholder(self):
        self.assertEqual([], detectors.detect_missing_glyph_placeholders("mail@example", "拼音"))


class ColumnCollapseTests(unittest.TestCase):
    def test_single_and_two_character_region_labels_both_hit(self):
        for value in ("zua42 〔莆〕", "zua42 〔莆田〕", "zua42 〔仙游〕"):
            hits = detectors.detect_column_collapse(value, "拼音")
            self.assertIn("region_label", hits[0].params["reasons"], value)

    def test_unbalanced_bracket(self):
        hits = detectors.detect_column_collapse("ka55］", "拼音")
        self.assertIn("unbalanced_bracket", hits[0].params["reasons"])

    def test_mixed_bracket_widths_are_not_considered_balanced(self):
        hits = detectors.detect_column_collapse("ka55[a］", "拼音")
        self.assertIn("unbalanced_bracket", hits[0].params["reasons"])

    def test_balanced_bracket_is_fine(self):
        self.assertEqual([], detectors.detect_column_collapse("ka55［1］", "拼音"))
        self.assertEqual([], detectors.detect_column_collapse("ka55[1]", "拼音"))


class MeaningTests(unittest.TestCase):
    def test_meaning_that_is_only_a_phonetic_fragment_is_strong(self):
        hits = detectors.detect_phonetic_in_meaning("tsɔ33")
        self.assertEqual("meaning_is_phonetic_fragment", hits[0].message)
        self.assertEqual(detectors.STRONG, hits[0].severity)

    def test_phonetic_run_inside_prose_is_a_warning(self):
        hits = detectors.detect_phonetic_in_meaning("看看 ka33 东西")
        self.assertEqual(detectors.WARN, hits[0].severity)
        self.assertEqual("phonetic_run_inside_meaning", hits[0].message)

    def test_pure_meaning_is_clean(self):
        self.assertEqual([], detectors.detect_phonetic_in_meaning("第一"))

    def test_a_separated_sense_list_is_not_flagged(self):
        self.assertEqual([], detectors.detect_phonetic_in_meaning("甲：ka33；乙：lu21"))


class NormalizationFormTests(unittest.TestCase):
    def test_classifies_each_form(self):
        cases = {
            "": "empty",
            "ka55": "neutral",
            "kʰ\u00e355": "nfc",
            "k\u02b0a\u030355": "nfd",
        }
        for value, expected in cases.items():
            self.assertEqual(expected, detectors.normalization_form(value), repr(value))

    def test_mixed_column_flags_the_minority_form(self):
        hits = detectors.detect_inconsistent_forms(
            {"拼音": ["k\u00e355", "ka55", "a\u030355", "ki33"]})
        self.assertEqual([detectors.ENCODING_FORM_ANOMALY], [h.kind for h in hits])
        self.assertEqual("nfd", hits[0].params["minority"])

    def test_uniform_column_is_silent(self):
        self.assertEqual([], detectors.detect_inconsistent_forms(
            {"拼音": ["k\u00e355", "\u00e3", "ka55"]}))

    def test_combining_marks_are_reported_as_info(self):
        hits = detectors.detect_combining_marks("a\u0303", "莆田IPA")
        self.assertEqual(["0x303"], hits[0].params["marks"])
        self.assertEqual(detectors.INFO, hits[0].severity)
        self.assertEqual([], detectors.detect_combining_marks("ka55", "莆田IPA"))


class RepertoireTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.repertoire = input_source.load_repertoire(str(KEYBOARD))

    def test_keyboard_declares_the_nasalised_and_ipa_characters_we_use(self):
        for char in ("\u00e3", "\u0254", "\u01fe", "\u02b0"):
            self.assertIn(ord(char), self.repertoire, char)

    def test_character_outside_the_keyboard_is_flagged(self):
        hits = detectors.detect_non_repertoire_chars("\u0254\u03a955", "莆田IPA",
                                                     self.repertoire)
        self.assertEqual(["0x3a9"], hits[0].params["codepoints"])

    def test_in_repertoire_characters_are_not_flagged(self):
        self.assertEqual([], detectors.detect_non_repertoire_chars(
            "\u01fe\u00e3\u0254\u02b055", "莆田IPA", self.repertoire))

    def test_han_in_a_reading_column_is_not_an_out_of_repertoire_hit(self):
        # #177 R1 allows the CJK ranges: a headword gloss sitting in a reading
        # column is a structure complaint (merged_columns), not an untypeable key.
        self.assertEqual([], detectors.detect_non_repertoire_chars("zua42 莆田", "拼音"))

    def test_cjk_planes_beyond_the_bmp_are_their_own_kind(self):
        for char in ("\U00020000", "\U0002a700", "\U0002b740", "\U0002ceb1"):
            hits = detectors.detect_cjk_extension(char, "词条")
            self.assertEqual([detectors.OUTSIDE_UNICODE_SET], [h.kind for h in hits], char)
            self.assertEqual([], detectors.detect_non_repertoire_chars(char, "词条"),
                             "%s must not report twice" % char)
        self.assertEqual([], detectors.detect_cjk_extension("甲", "词条"))


class RowLevelBehaviourTests(unittest.TestCase):
    """Two behaviours that only exist to keep the signal worth reading."""

    def test_placeholder_digits_are_not_counted_as_tones(self):
        row = {"词条": "壬", "拼音": "@4E2D ia55", "莆田IPA": "ia55", "仙游IPA": "ia55"}
        messages = [h.message for h in detectors.analyze_row(row)]
        self.assertNotIn("tone_token_count_differs", messages)
        self.assertIn("missing_glyph_placeholder", messages)

    def test_a_broken_cell_reports_once(self):
        row = {"词条": "特", "拼音": "zua42 〔莆〕 \u03a9", "莆田IPA": "zua42"}
        messages = [h.message for h in detectors.analyze_row(row)]
        self.assertIn("column_collapse", messages)
        self.assertNotIn("non_ipa_range_codepoints", messages)

    def test_a_clean_cell_still_reports_repertoire(self):
        row = {"词条": "特", "拼音": "\u0254\u03a955", "莆田IPA": "\u0254\u03a955"}
        messages = [h.message for h in detectors.analyze_row(row)]
        self.assertIn("non_ipa_range_codepoints", messages)

    def test_placeholders_outside_the_reading_columns_are_detected(self):
        # The real 15,022-row 正本 carries all 793 placeholders in 词条 and 释义,
        # and none at all in the reading columns. While this detector sat behind
        # the reading_fields gate the offline probe reported zero of them.
        for field in ("词条", "释义"):
            messages = [h.message for h in detectors.analyze_row(
                {field: "@4E2D", "拼音": "ka55"})]
            self.assertIn("missing_glyph_placeholder", messages, field)

    def test_out_of_repertoire_outside_the_reading_columns_is_detected(self):
        # Same gate, same blind spot: an untypeable character sitting in 释义 was
        # never looked at, so the column holding the most real text went unread.
        messages = [h.message for h in detectors.analyze_row(
            {"词条": "甲", "释义": "Ω"})]
        self.assertIn("non_ipa_range_codepoints", messages)

    def test_the_meaning_column_suppression_still_holds(self):
        # Widening the detectors also widened the suppression: a 释义 cell whose
        # structure is already broken by a placeholder must still report once.
        row = {"词条": "甲", "释义": "@4E2D \u03a9"}
        messages = [h.message for h in detectors.analyze_row(row)]
        self.assertIn("missing_glyph_placeholder", messages)
        self.assertNotIn("non_ipa_range_codepoints", messages)

    def test_a_row_wider_than_its_header_is_reported_not_dropped(self):
        hits = detectors.detect_row_width(4, 2)
        self.assertEqual([detectors.MERGED_COLUMNS], [h.kind for h in hits])
        self.assertEqual({"cells": 4, "headers": 2}, hits[0].params)
        self.assertEqual([], detectors.detect_row_width(2, 2))


class ProbeEndToEndTests(unittest.TestCase):
    def setUp(self):
        self.headers, self.rows = input_source.read_rows(str(FIXTURE))
        self.findings = probe_corpus.analyze(
            self.headers, self.rows, input_source.load_repertoire(str(KEYBOARD)))

    def test_fixture_exercises_the_expected_kinds(self):
        found = {item["kind"] for item in self.findings}
        for expected in (detectors.READING_FORMAT_INVALID, detectors.MERGED_COLUMNS,
                         detectors.MISSING_GLYPH_PLACEHOLDER,
                         detectors.ENCODING_FORM_ANOMALY, detectors.CHAR_OUT_OF_REPERTOIRE,
                         detectors.OUTSIDE_UNICODE_SET):
            self.assertIn(expected, found)

    def test_fixture_carries_placeholders_outside_the_reading_columns(self):
        # The fixture used to put every placeholder in 拼音, the one reading
        # column, encoding the opposite of the real distribution — which is why
        # it was the only ground truth and never challenged the gate.
        fields = {item["field"] for item in self.findings
                  if item["kind"] == detectors.MISSING_GLYPH_PLACEHOLDER}
        self.assertIn("词条", fields)
        self.assertIn("释义", fields)

    def test_extra_cells_are_reported_not_silently_dropped(self):
        hits = [i for i in self.findings if i["message"] == "row_width_differs"]
        self.assertEqual(1, len(hits))
        self.assertEqual(15, hits[0]["line"])
        self.assertEqual({"cells": 8, "headers": 6}, hits[0]["params"])

    def test_illegal_run_row_is_attributable(self):
        lines = {item["line"] for item in self.findings
                 if item["message"] == "long_digit_run"}
        self.assertIn(4, lines)      # sa1234 sits on csv line 4
        self.assertNotIn(2, lines)   # to533 is legal
        self.assertNotIn(14, lines)  # @20000 is a placeholder, not a tone run

    def cell_values(self):
        values = set()
        for row in self.rows:
            values.update(v for v in row if v and not v.isdigit())
        return values

    def assert_content_free(self, text):
        for value in sorted(self.cell_values()):
            self.assertNotIn(value, text, "leaked cell value %r" % value)

    def test_default_output_echoes_no_cell_value(self):
        code, out, err = run_main(["--csv", str(FIXTURE)])
        self.assertEqual(0, code)
        self.assert_content_free(out)
        self.assertIn("findings:", out)

    def test_json_output_is_redacted_to_counts_codepoints_and_positions(self):
        code, out, err = run_main(["--csv", str(FIXTURE), "--json"])
        self.assertEqual(0, code)
        self.assert_content_free(out)
        payload = json.loads(out)
        for item in payload["findings"]:
            self.assertNotIn("runs", item["params"])
            self.assertNotIn("marks", item["params"])
        self.assertEqual(os.path.basename(str(FIXTURE)), payload["source"])

    def test_show_samples_is_the_only_way_to_get_cell_text(self):
        code, out, err = run_main(["--csv", str(FIXTURE), "--show-samples", "3"])
        self.assertEqual(0, code)
        self.assertIn("do not paste", err)
        samples = [json.loads(line) for line in out.splitlines() if line.startswith("{")]
        self.assertTrue(samples)
        self.assertTrue(any("cell" in item for item in samples))
        self.assertIn("runs", samples[0]["params"])

    def test_personal_path_is_never_printed(self):
        code, out, err = run_main(["--csv", str(FIXTURE)])
        self.assertEqual(0, code)
        self.assertNotIn(str(FIXTURE.parent), out)


class InputSourceTests(unittest.TestCase):
    def test_flag_wins_over_environment(self):
        with tempfile.TemporaryDirectory() as work:
            chosen = Path(work) / "chosen.csv"
            chosen.write_text("PDF页码,词条\n1,甲\n", encoding="utf-8")
            other = Path(work) / "other.csv"
            other.write_text("PDF页码,词条\n1,乙\n", encoding="utf-8")
            resolved = input_source.resolve_corpus_path(
                ["--csv", str(chosen)], env={input_source.ENV_VAR: str(other)})
            self.assertEqual(str(chosen), resolved)

    def test_equals_form_of_the_flag_is_accepted(self):
        with tempfile.TemporaryDirectory() as work:
            chosen = Path(work) / "c.csv"
            chosen.write_text("PDF页码\n1\n", encoding="utf-8")
            self.assertEqual(str(chosen),
                             input_source.resolve_corpus_path([f"--csv={chosen}"], env={}))

    def test_no_default_is_selected_on_any_machine(self):
        with self.assertRaises(input_source.InputSourceError) as caught:
            input_source.resolve_corpus_path([], env={})
        self.assertIn("--csv", str(caught.exception))

    def test_missing_file_is_reported_not_crashed(self):
        with self.assertRaises(input_source.InputSourceError):
            input_source.resolve_corpus_path(["--csv", "/nonexistent/corpus.csv"], env={})

    def test_non_utf8_bytes_exit_cleanly_from_the_cli(self):
        # GB18030-exported Chinese CSVs are the common shape for this corpus.
        with tempfile.TemporaryDirectory() as work:
            path = Path(work) / "gbk.csv"
            path.write_bytes("PDF页码,词条\n1,甲\n".encode("gb18030"))
            code, out, err = run_main(["--csv", str(path)])
            self.assertEqual(2, code)
            self.assertTrue(err.startswith("error:"), err)
            self.assertNotIn("Traceback", err)

    def test_empty_file_exits_cleanly_from_the_cli(self):
        with tempfile.TemporaryDirectory() as work:
            path = Path(work) / "empty.csv"
            path.write_bytes(b"")
            code, out, err = run_main(["--csv", str(path)])
            self.assertEqual(2, code)
            self.assertTrue(err.startswith("error:"), err)
            self.assertNotIn("Traceback", err)

    def test_home_prefix_is_abbreviated_in_messages(self):
        old_home = os.environ.get("HOME")
        with tempfile.TemporaryDirectory() as home:
            os.environ["HOME"] = home
            try:
                shown = input_source.display_path(os.path.join(home, "corpus", "正本.csv"))
                self.assertTrue(shown.startswith("~/"), shown)
                self.assertNotIn(home, shown)
            finally:
                if old_home is not None:
                    os.environ["HOME"] = old_home

    def test_paths_outside_home_are_shown_in_full(self):
        self.assertTrue(input_source.display_path("/tmp/corpus.csv").startswith("/tmp/"))

    def test_keyboard_defaults_to_the_repository_copy(self):
        self.assertEqual(str(KEYBOARD), input_source.resolve_keyboard_path([], env={}))

    def test_bom_is_tolerated(self):
        with tempfile.TemporaryDirectory() as work:
            path = Path(work) / "bom.csv"
            path.write_bytes("PDF页码,词条\n1,甲\n".encode("utf-8-sig"))
            headers, rows = input_source.read_rows(str(path))
            self.assertEqual(["PDF页码", "词条"], headers)
            self.assertEqual([["1", "甲"]], rows)


if __name__ == "__main__":
    unittest.main()
