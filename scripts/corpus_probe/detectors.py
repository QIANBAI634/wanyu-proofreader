"""Offline detectors that flag suspicious values in a dialect corpus CSV.

Reference implementation for the layer-0 rules described in #177, producing the
finding kinds defined in #176. These run outside the product: nothing here is
wired into import, proofreading or arbitration, and no value is ever rewritten.

Ported from the W2 workspace probes (anomaly_probe.py / anomaly_probe2.py),
which were written against the real 莆仙方言大词典 corpus but never checked in.
"""
import re
import unicodedata
from collections import Counter, namedtuple

READING_FORMAT_INVALID = "reading_format_invalid"
MERGED_COLUMNS = "merged_columns"
ENCODING_FORM_ANOMALY = "encoding_form_anomaly"
CHAR_OUT_OF_REPERTOIRE = "char_out_of_repertoire"
OUTSIDE_UNICODE_SET = "outside_unicode_set"
MISSING_GLYPH_PLACEHOLDER = "missing_glyph_placeholder"

INFO, WARN, STRONG = "info", "warn", "strong"

Finding = namedtuple("Finding", "kind severity field message params")

# Three-or-more consecutive digits inside a reading column mean a superscript
# tone mark lost its superscripting. 533 and 453 are the only legitimate runs,
# both being real multi-digit contour values in this scheme.
LEGAL_LONG_TONES = frozenset({"533", "453"})
LONG_DIGIT_RUN = re.compile(r"\d{3,}")
TONE_TOKEN = re.compile(r"(?<!\d)\d{1,3}(?!\d)")
PLACEHOLDER = re.compile(r"@[\da-fA-F]{3,6}")
REGION_LABEL = re.compile(r"〔(?:莆田|仙游|[莆仙])〕")
PHONETIC_RUN = re.compile(
    r"[A-Za-zàáâãäåæçèéêëìíîïðñòóôõöøœùúûüýÿɐ-ʙʀ-ʗβθɒɔɛəɤɬʔŋɡǾø]"
    r"[A-Za-zàáâãäåæçèéêëìíîïðñòóôõöøœùúûüýÿɐ-ʙʀ-ʗβθɒɔɛəɤɬʔŋɡǾø]*"
)
PHONETIC_ONLY = re.compile(
    r"\s*[A-Za-zàáâãēîôûüŋɡɒɔɛøœʔɬβðǾ][A-Za-zàáâãēîôûüŋɡɒɔɛøœʔɬβðǾ]*[0-9]*\s*"
)
MEANING_SEPARATOR = re.compile(r"[：‖]")

# CJK planes beyond the BMP: these cannot be reached from any keyboard, so they
# are a font and representation question for #123, not a proofreader error.
CJK_EXTENSION_BLOCKS = (
    range(0x20000, 0x2A6E0),   # Ext B
    range(0x2A700, 0x2B73A),   # Ext C
    range(0x2B740, 0x2B81E),   # Ext D
    range(0x2B820, 0x2CEA2),   # Ext E
    range(0x2CEB0, 0x2EBE1),   # Ext F
    range(0x30000, 0x3134B),   # Ext G
    range(0x31350, 0x323B0),   # Ext H
    range(0x2F800, 0x2FA1E),   # Compatibility Ideographs Supplement
)
IPA_BLOCK = range(0x0250, 0x02B0)
# Characters that are legitimate inside a reading column even though no key
# declares them: #177 R1 allows the CJK and punctuation ranges, because a head-
# form gloss or a 〔莆田〕 label reaching this column is a structure complaint
# (merged_columns), not "the proofreader typed an untypeable character".
ALLOWED_NON_REPERTOIRE_RANGES = (
    IPA_BLOCK,
    range(0x2000, 0x2070),     # general punctuation, includes ′ ″
    range(0x3000, 0x3040),     # CJK symbols and punctuation, includes 〔 〕
    range(0x3400, 0x4DC0),     # CJK Extension A
    range(0x4E00, 0xA000),     # CJK Unified Ideographs
    range(0xF900, 0xFA70),     # CJK Compatibility Ideographs
    # Beyond-BMP ideographs are untypeable by definition and already carry their
    # own kind; reporting them twice would put two findings on one cell.
    *CJK_EXTENSION_BLOCKS,
)
ALLOWED_ABOVE_ASCII_STANDALONE = frozenset({0x02B0})


def finding(kind, severity, field, message, **params):
    return Finding(kind=kind, severity=severity, field=field, message=message,
                   params=params)


def detect_illegal_tone_runs(value, field):
    """A digit run of three or more that is not a legal contour value.

    Placeholder hex is stripped first: @20000 carries a five-digit run that is a
    missing-glyph marker, not a flattened tone, and reporting both would put two
    strong findings on one cell.
    """
    if not value:
        return []
    stripped = PLACEHOLDER.sub("", value)
    runs = [run for run in LONG_DIGIT_RUN.findall(stripped) if run not in LEGAL_LONG_TONES]
    if not runs:
        return []
    return [finding(READING_FORMAT_INVALID, STRONG, field,
                    "long_digit_run", runs=runs, run_count=len(runs))]


def detect_tone_count_mismatch(pinyin, ipa, field="拼音"):
    """拼音 and the IPA column should carry one tone token per syllable."""
    if not pinyin or not ipa:
        return []
    # A missing-glyph placeholder carries hex digits that are not tone marks.
    left = len(TONE_TOKEN.findall(PLACEHOLDER.sub("", pinyin)))
    right = len(TONE_TOKEN.findall(PLACEHOLDER.sub("", ipa)))
    if left == right:
        return []
    return [finding(READING_FORMAT_INVALID, WARN, field,
                    "tone_token_count_differs", pinyin_count=left, ipa_count=right)]


def detect_missing_glyph_placeholders(value, field):
    """@-hex markers stand for characters the source could not encode."""
    if not value:
        return []
    marks = PLACEHOLDER.findall(value)
    if not marks:
        return []
    return [finding(MISSING_GLYPH_PLACEHOLDER, STRONG, field,
                    "missing_glyph_placeholder", marks=marks, mark_count=len(marks))]


def detect_column_collapse(value, field):
    """A region label or an unbalanced bracket means columns were merged."""
    if not value:
        return []
    reasons = []
    if REGION_LABEL.search(value):
        reasons.append("region_label")
    # Full and half width brackets are counted separately: a cell pairing an
    # ASCII opener with a fullwidth closer is broken, not balanced.
    if value.count("[") != value.count("]") or value.count("［") != value.count("］"):
        reasons.append("unbalanced_bracket")
    if not reasons:
        return []
    return [finding(MERGED_COLUMNS, STRONG, field, "column_collapse", reasons=reasons)]


def detect_phonetic_in_meaning(value, field="释义"):
    """Reading material sitting inside the meaning column."""
    if not value or MEANING_SEPARATOR.search(value):
        return []
    if re.fullmatch(PHONETIC_ONLY, value):
        return [finding(MERGED_COLUMNS, STRONG, field, "meaning_is_phonetic_fragment")]
    if PHONETIC_RUN.search(value):
        return [finding(MERGED_COLUMNS, WARN, field, "phonetic_run_inside_meaning")]
    return []


def normalization_form(value):
    """Classify a string by its Unicode normalization form.

    Only NFC is ever applied to values; NFKD/NFKC would erase real linguistic
    distinctions such as ɑ vs a, so they are not offered here.
    """
    if not value:
        return "empty"
    is_nfc = value == unicodedata.normalize("NFC", value)
    is_nfd = value == unicodedata.normalize("NFD", value)
    if is_nfc and is_nfd:
        return "neutral"
    if is_nfc:
        return "nfc"
    if is_nfd:
        return "nfd"
    return "mixed"


def detect_inconsistent_forms(values_by_field):
    """Flag the minority normalization form within one column."""
    findings = []
    for field, values in sorted(values_by_field.items()):
        forms = Counter(normalization_form(v) for v in values if v)
        nfc, nfd = forms.get("nfc", 0), forms.get("nfd", 0)
        if not nfc or not nfd:
            continue
        minority = "nfd" if nfc >= nfd else "nfc"
        findings.append(finding(ENCODING_FORM_ANOMALY, WARN, field,
                                "mixed_normalization_forms",
                                minority=minority, nfc=nfc, nfd=nfd))
    return findings


def detect_combining_marks(value, field):
    """Combining marks are legitimate in IPA but worth surfacing per codepoint."""
    if not value:
        return []
    marks = sorted({hex(ord(c)) for c in value if unicodedata.category(c) == "Mn"})
    if not marks:
        return []
    return [finding(ENCODING_FORM_ANOMALY, INFO, field,
                    "combining_marks_present", marks=marks)]


def non_repertoire_chars(value, allowed=frozenset()):
    """Codepoints above ASCII outside the IPA block, the CJK and punctuation
    ranges #177 R1 allows, and whatever the enabled keyboards declare."""
    allowed_above_ascii = set(allowed) | ALLOWED_ABOVE_ASCII_STANDALONE
    return sorted({ord(c) for c in value
                   if ord(c) > 127
                   and ord(c) not in allowed_above_ascii
                   and not any(ord(c) in block for block in ALLOWED_NON_REPERTOIRE_RANGES)})


def detect_non_repertoire_chars(value, field, allowed=frozenset()):
    codepoints = non_repertoire_chars(value, allowed)
    if not codepoints:
        return []
    return [finding(CHAR_OUT_OF_REPERTOIRE, WARN, field,
                    "non_ipa_range_codepoints",
                    codepoints=[hex(c) for c in codepoints])]


def detect_cjk_extension(value, field):
    """Ideographs beyond the BMP: they need the #123 representation decision."""
    hits = sorted({hex(ord(c)) for c in value
                   if any(ord(c) in block for block in CJK_EXTENSION_BLOCKS)})
    if not hits:
        return []
    return [finding(OUTSIDE_UNICODE_SET, WARN, field,
                    "cjk_extension_present", codepoints=hits)]


def detect_row_width(cell_count, header_count):
    """A row wider than its header is a column-position symptom, not noise.

    Callers build header-keyed dicts, so without this the extra cells vanish.
    """
    if cell_count == header_count:
        return []
    return [finding(MERGED_COLUMNS, STRONG, "(row)", "row_width_differs",
                    cells=cell_count, headers=header_count)]


def entry_identity(headword, pinyin):
    """R-DEDUP: entry identity is (headword, pinyin).

    Same-form headwords are never merged: two rows sharing only the headword
    are different entries, so they must not be reported as duplicates.
    """
    return (headword.strip(), pinyin.strip())


def group_by_identity(rows, headword_field="词条", pinyin_field="拼音"):
    """Group rows by R-DEDUP identity, preserving every member."""
    groups = {}
    for row in rows:
        key = entry_identity(row.get(headword_field, ""), row.get(pinyin_field, ""))
        groups.setdefault(key, []).append(row)
    return groups


def analyze_row(row, reading_fields=("拼音", "莆田IPA", "仙游IPA"),
                meaning_fields=("释义",), allowed_repertoire=frozenset()):
    """Run every per-row detector over one parsed CSV row.

    A cell whose structure is already known to be broken reports once: when a
    strong merged_columns or placeholder finding owns the cell, the repertoire
    complaint about the same characters is dropped. Alert fatigue is the fastest
    way to make a proofreader stop reading markings at all.
    """
    collected = []
    for field, value in sorted(row.items()):
        if not value:
            continue
        hits = []
        # Structure complaints run on every column, not just the reading ones.
        # Gating them on reading_fields measured a total recall loss on the real
        # 15,022-row 正本: all 793 @hex placeholders sit in 词条 / 释义, and the
        # reading columns carry none, so the gate saw zero of them. The same gate
        # hid non-repertoire characters outside the reading columns.
        #
        # reading_fields stays hardcoded for now; #170 replaces it with column
        # roles, and this note goes with it.
        hits += detect_missing_glyph_placeholders(value, field)
        hits += detect_non_repertoire_chars(value, field, allowed_repertoire)
        if field in reading_fields:
            hits += detect_illegal_tone_runs(value, field)
            hits += detect_column_collapse(value, field)
            hits += detect_combining_marks(value, field)
        hits += detect_cjk_extension(value, field)
        if field in meaning_fields:
            hits += detect_phonetic_in_meaning(value, field)
            hits += detect_column_collapse(value, field)
        collected += hits

    owned = {hit.field for hit in collected
             if hit.severity == STRONG and hit.kind in (MERGED_COLUMNS, MISSING_GLYPH_PLACEHOLDER)}
    filtered = [hit for hit in collected
                if not (hit.kind == CHAR_OUT_OF_REPERTOIRE and hit.field in owned)]
    filtered += detect_tone_count_mismatch(row.get("拼音", ""), row.get("莆田IPA", ""))
    return filtered


# Param values that quote the cell verbatim. Codepoints stay: they are what #123
# needs to decide a representation, and a hex number is not dictionary text.
CONTENT_PARAMS = ("runs", "marks")


def redact_params(params):
    """Strip the fragments that echo corpus text, keeping counts and codepoints."""
    return {key: value for key, value in params.items() if key not in CONTENT_PARAMS}
