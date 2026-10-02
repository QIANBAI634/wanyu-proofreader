#!/usr/bin/env python3
"""Tests for the tone-notation codec and its CLI.

Each rule is pinned from both sides — a value that must convert and the
neighbouring value that must not — because the failure mode of a batch converter
is silent: a wrongly raised tone still looks like a plausible reading. The
placeholder, per-column and untypeable-character cases are where an over-eager
transform would quietly corrupt data that volunteers then have to re-proofread.
"""
import contextlib
import csv
import importlib.util
import io
import json
import os
import shutil
import tempfile
import unicodedata
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent


def _load(directory, name):
    spec = importlib.util.spec_from_file_location(name, directory / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


tone = _load(HERE, "tone")
convert_tones = _load(HERE, "convert_tones")
corpus_probe = HERE.parent / "corpus_probe"
detectors = _load(corpus_probe, "detectors")

FIXTURE = HERE / "fixtures" / "mini_tones.csv"
KEYBOARD = HERE.parents[1] / "backend" / "keyboards" / "hinghwa-dialect.json"
RULES = HERE / "data" / "tone_notation.json"

PUTIAN = frozenset({"533", "453", "21", "13", "42", "55", "4", "1", "2", "0"})
XIANYOU = frozenset({"533", "453", "21", "13", "42", "55", "23", "2", "0"})
SUP = {str(digit): char for digit, char in sorted(tone.ALL_SUPERSCRIPTS.items())}


def run_main(args):
    stdout, stderr = io.StringIO(), io.StringIO()
    with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
        code = convert_tones.main(args)
    return code, stdout.getvalue(), stderr.getvalue()


def _at(row, index):
    return row[index] if index < len(row) else ""


def convert(value, legal=PUTIAN, superscripts=SUP):
    return tone.convert_cell(value, legal, superscripts)


class RaiseTests(unittest.TestCase):
    def test_legal_contours_become_superscripts(self):
        for value, expected in (("qa533", "qa⁵³³"), ("qa453", "qa⁴⁵³"),
                                ("vi21", "vi²¹"), ("ju4", "ju⁴"),
                                ("qa0", "qa⁰"), ("qa55vi21", "qa⁵⁵vi²¹")):
            result = convert(value)
            self.assertEqual(expected, result.text)
            self.assertEqual(tone.EXACT, result.status, value)

    def test_an_ambiguous_run_is_left_completely_untouched(self):
        # 42+13 and 4+2+13 are both readable in the 莆田 set; the syllable letters
        # that would settle it are gone, so this is a damage report, not a puzzle.
        result = convert("qa4213")
        self.assertEqual("qa4213", result.text)
        self.assertEqual(tone.AMBIGUOUS, result.status)
        self.assertEqual((), result.tones)
        self.assertEqual("tone_run_holds_2_contours_in_2_ways", result.reason)

    def test_a_unique_collision_is_still_ambiguous_but_reports_no_second_reading(self):
        # 仙游 has no 4 and no 1, so only 42+13 survives there: the count of
        # contours is what matters, and the reason must not claim a second reading.
        result = tone.convert_cell("qa4213", XIANYOU, SUP)
        self.assertEqual("tone_run_holds_2_contours", result.reason)

    def test_a_run_that_reads_as_no_legal_value_is_unsupported(self):
        result = convert("va1234")
        self.assertEqual("va1234", result.text)
        self.assertEqual(tone.UNSUPPORTED, result.status)
        self.assertEqual("tone_run_not_a_legal_value", result.reason)

    def test_one_bad_run_suppresses_every_good_run_in_the_same_cell(self):
        result = convert("qa533vi1234")
        self.assertEqual("qa533vi1234", result.text)
        self.assertEqual(tone.UNSUPPORTED, result.status)

    def test_the_same_digits_are_legal_in_one_column_and_not_in_another(self):
        # 23 is an 仙游 contour only; 4 and 1 are 莆田 only. A single global set
        # would misjudge both directions.
        self.assertEqual("qa²³", convert("qa23", XIANYOU).text)
        self.assertEqual(tone.UNSUPPORTED, convert("qa23", PUTIAN).status)
        self.assertEqual("ju⁴", convert("ju4", PUTIAN).text)
        self.assertEqual(tone.UNSUPPORTED, convert("ju4", XIANYOU).status)

    def test_placeholder_digits_are_never_raised(self):
        for value in ("qa@12345", "ka@12", "ka@ABC"):
            result = convert(value)
            self.assertEqual(value, result.text)
            self.assertEqual(tone.NO_TONE, result.status, value)

    def test_a_cell_mixing_placeholder_and_real_tones_converts_only_the_tones(self):
        result = convert("qa533@12345vi21")
        self.assertEqual("qa⁵³³@12345vi²¹", result.text)
        self.assertEqual(("533", "21"), result.tones)

    def test_an_already_superscript_cell_needs_no_work(self):
        result = convert("qa⁵³³")
        self.assertEqual("qa⁵³³", result.text)
        self.assertEqual(tone.NO_TONE, result.status)

    def test_empty_and_punctuation_only_cells(self):
        self.assertEqual(tone.EMPTY, convert("").status)
        self.assertEqual(tone.NO_TONE, convert("qa").status)

    def test_non_digit_characters_keep_their_normalization_form(self):
        # 仙游IPA is bimodal NFC/NFD in the real corpus; a converter that quietly
        # recomposed nasalisation would rewrite bytes nobody proofread (#174).
        decomposed = "a\u0303" + "533"
        result = tone.convert_cell(decomposed, PUTIAN, SUP)
        self.assertEqual("a\u0303⁵³³", result.text)
        self.assertNotEqual(unicodedata.normalize("NFC", decomposed), decomposed)
        self.assertEqual("a\u0303", result.text[:2])

    def test_raising_twice_changes_nothing(self):
        for value in ("qa533", "qa55vi21", "qa4213", "va1234", "qa@12345"):
            once = convert(value)
            twice = convert(once.text)
            self.assertEqual(once.text, twice.text, value)

    def test_flatten_is_the_exact_inverse_for_every_converted_cell(self):
        for value in ("qa533", "qa453", "vi21", "ju4", "qa0", "qa55vi21",
                      "qa533@12345vi21"):
            raised = convert(value)
            self.assertEqual(value, tone.flatten(raised.text), value)


class SuperscriptRepertoireTests(unittest.TestCase):
    def setUp(self):
        input_source = _load(corpus_probe, "input_source")
        self.repertoire = input_source.load_repertoire(str(KEYBOARD))

    def test_the_keyboard_decides_which_digits_can_be_raised(self):
        mapping = tone.load_superscript_map(chr(c) for c in self.repertoire)
        self.assertEqual("⁰", mapping["0"])
        self.assertEqual("⁸", mapping["8"])
        self.assertNotIn("9", mapping, "the 莆仙 keyboard has no ⁹ key; if one is added "
                                       "this test should fail so the rule file is revisited")

    def test_a_legal_tone_needing_an_untypeable_superscript_is_refused(self):
        legal = frozenset({"9"})
        result = tone.convert_cell("qa9", legal, {str(d): c for d, c in SUP.items() if d != "9"})
        self.assertEqual("qa9", result.text)
        self.assertEqual(tone.UNSUPPORTED, result.status)
        self.assertEqual("superscript_untypeable:9", result.reason)

    def test_flatten_recognises_every_superscript_digit_by_unicode_name(self):
        for digit in "0123456789":
            self.assertEqual(digit, tone.flatten(tone.ALL_SUPERSCRIPTS[digit]))


class RuleFileTests(unittest.TestCase):
    def setUp(self):
        self.rules = tone.load_tone_rules(str(RULES), "puxian-dict-reading")

    def test_the_three_reading_columns_are_declared(self):
        self.assertEqual(("拼音", "莆田IPA", "仙游IPA"), self.rules.columns)
        self.assertEqual(self.rules.legal_by_column["拼音"], self.rules.legal_by_column["莆田IPA"])
        self.assertNotEqual(self.rules.legal_by_column["仙游IPA"],
                            self.rules.legal_by_column["莆田IPA"])

    def test_long_tones_agree_with_the_shared_detector_constant(self):
        # detectors.py hardcodes the same pair for R6. Two copies that drift is the
        # debt #189 calls out, so the agreement is pinned rather than assumed.
        self.assertEqual(set(detectors.LEGAL_LONG_TONES), set(self.rules.long_tones))

    def test_a_tone_category_scheme_is_refused_not_converted(self):
        # 《文读字汇》 marks 阴平…阳入 as 1…7: the same digit, a different layer.
        with self.assertRaises(tone.SchemeError) as caught:
            tone.load_tone_rules(str(RULES), "puxian-wendu")
        self.assertIn("tone_category", str(caught.exception))

    def test_an_unknown_scheme_names_the_ones_that_exist(self):
        with self.assertRaises(tone.SchemeError) as caught:
            tone.load_tone_rules(str(RULES), "puxian-hocgen")
        self.assertIn("puxian-wendu", str(caught.exception))


class CliTests(unittest.TestCase):
    def test_report_counts_match_a_hand_check_of_the_fixture(self):
        code, out, err = run_main(["--csv", str(FIXTURE)])
        self.assertEqual(0, code, err)
        self.assertIn("scheme: puxian-dict-reading", out)
        self.assertIn("rows: 12", out)
        for expected in ("AMBIGUOUS", "UNSUPPORTED", "NO_TONE"):
            self.assertIn(expected, out)

    def test_default_and_json_output_quote_no_cell_value(self):
        with open(FIXTURE, encoding="utf-8-sig", newline="") as handle:
            rows = list(csv.DictReader(handle))
        values = sorted({cell for row in rows for key, cell in row.items()
                         if key != "PDF页码" and cell and not cell.isdigit()})
        self.assertGreater(len(values), 15, "the fixture's cells should be distinctive")
        for args in (["--csv", str(FIXTURE)], ["--csv", str(FIXTURE), "--json"]):
            code, out, err = run_main(args)
            self.assertEqual(0, code, err)
            for value in values:
                self.assertNotIn(value, out, "%s leaked into %s" % (value, args))
                self.assertNotIn(value, err)

    def test_json_output_is_machine_readable_and_carries_the_rule_version(self):
        code, out, err = run_main(["--csv", str(FIXTURE), "--json"])
        self.assertEqual(0, code, err)
        doc = json.loads(out)
        self.assertEqual("puxian-dict-reading", doc["scheme"])
        self.assertTrue(doc["rule_version"].startswith("puxian-tone-notation"))
        self.assertEqual(12, doc["rows"])
        self.assertNotIn("cell", json.dumps(doc, ensure_ascii=False))

    def test_writing_a_file_preserves_everything_outside_the_target_columns(self):
        workspace = tempfile.mkdtemp()
        try:
            corpus = os.path.join(workspace, "mini.csv")
            shutil.copy(str(FIXTURE), corpus)
            before = self._read(corpus)
            out_path = os.path.join(workspace, "raised.csv")
            code, out, err = run_main(["--csv", corpus, "--out", out_path])
            self.assertEqual(0, code, err)
            self.assertIn("verification", out)
            after = self._read(out_path)
            self.assertEqual(len(before), len(after), "row count must not change")
            changed = 0
            for left, right in zip(before, after):
                self.assertEqual(_at(left, 0), _at(right, 0))   # 词条 untouched
                self.assertEqual(_at(left, 5), _at(right, 5))   # 释义 untouched
                for index in (2, 3, 4):
                    # raising may change how a digit is written, never which digits
                    # are there or in what order.
                    self.assertEqual(tone.flatten(_at(left, index)),
                                     tone.flatten(_at(right, index)),
                                     "line %r column %r" % (_at(left, 1), index))
                    changed += _at(right, index) != _at(left, index)
            self.assertGreater(changed, 0,
                               "nothing was converted, so the assertions above are vacuous")
        finally:
            shutil.rmtree(workspace)

    def test_the_input_corpus_is_never_modified(self):
        workspace = tempfile.mkdtemp()
        try:
            corpus = os.path.join(workspace, "mini.csv")
            shutil.copy(str(FIXTURE), corpus)
            before = self._bytes(corpus)
            run_main(["--csv", corpus, "--out", os.path.join(workspace, "out.csv")])
            self.assertEqual(before, self._bytes(corpus))
        finally:
            shutil.rmtree(workspace)

    def test_refuses_to_write_inside_the_repository(self):
        target = os.path.join(convert_tones.REPO_ROOT, "leaked.csv")
        code, out, err = run_main(["--csv", str(FIXTURE), "--out", target])
        self.assertEqual(2, code)
        self.assertIn("refusing to write corpus text inside the repository", err)
        self.assertFalse(os.path.exists(target))

    def test_refuses_to_overwrite_the_input(self):
        workspace = tempfile.mkdtemp()
        try:
            corpus = os.path.join(workspace, "mini.csv")
            shutil.copy(str(FIXTURE), corpus)
            before = self._bytes(corpus)
            code, out, err = run_main(["--csv", corpus, "--out", corpus])
            self.assertEqual(2, code)
            self.assertIn("refusing to overwrite the input", err)
            self.assertEqual(before, self._bytes(corpus))
        finally:
            shutil.rmtree(workspace)

    def test_a_column_the_scheme_has_no_rule_for_is_an_error_not_a_skip(self):
        code, out, err = run_main(["--csv", str(FIXTURE), "--column", "词条"])
        self.assertEqual(2, code)
        self.assertIn("declares no tone values for column", err)

    def test_flatten_direction_returns_the_corpus_shape(self):
        code, out, err = run_main(["--csv", str(FIXTURE), "--direction", "flatten", "--json"])
        self.assertEqual(0, code, err)
        doc = json.loads(out)
        self.assertEqual(1, doc["columns"]["拼音"]["statuses"].get("EXACT"),
                         "only the already-superscript 辛 row has anything to flatten")

    @staticmethod
    def _read(path):
        with open(path, encoding="utf-8-sig", newline="") as handle:
            return [row for row in csv.reader(handle)][1:]

    @staticmethod
    def _bytes(path):
        with open(path, "rb") as handle:
            return handle.read()


if __name__ == "__main__":
    unittest.main()
