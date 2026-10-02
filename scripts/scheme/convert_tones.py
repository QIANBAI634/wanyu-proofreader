#!/usr/bin/env python3
"""把记音列的数字声调转成印出样式（上标），或反向压平；只报不改写原件。

  python3 scripts/scheme/convert_tones.py --csv /path/to/正本.csv
  python3 scripts/scheme/convert_tones.py --csv ... --direction flatten
  python3 scripts/scheme/convert_tones.py --csv ... --out /tmp/正本.上标.csv
  python3 scripts/scheme/convert_tones.py --csv ... --json

默认只出统计，不写任何文件。`--out` 写的是**新文件**，并且拒绝写进仓库（未授权语料
不入仓，见 CONTRIBUTING.md 与 #92）和拒绝覆盖输入本身。

输出纪律与 corpus_probe 一致：默认与 `--json` 只含文件名、sha256 前缀、计数、调值
直方图与码位，不含单元格原文；只有 `--show-samples N` 才打印原文并在 stderr 警告。
"""
import argparse
import collections
import csv
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(os.path.dirname(HERE), "corpus_probe"))

import input_source  # noqa: E402  (repo root is two levels up from scripts/scheme)
import tone  # noqa: E402

REPO_ROOT = os.path.dirname(os.path.dirname(HERE))
DEFAULT_SCHEME = "puxian-dict-reading"


def convert_rows(headers, rows, rules, superscripts, columns, direction):
    """Return (converted rows, per-column tally) without touching the inputs."""
    tally = {column: collections.Counter() for column in columns}
    tones = {column: collections.Counter() for column in columns}
    reasons = {column: collections.Counter() for column in columns}
    changed = {column: 0 for column in columns}
    out = []
    for values in rows:
        record = list(values)
        for column in columns:
            if column not in headers:
                continue
            index = headers.index(column)
            if index >= len(record):
                continue
            original = record[index]
            if direction == "flatten":
                result = tone.flatten(original)
                if not original:
                    status = tone.EMPTY
                else:
                    status = tone.EXACT if result != original else tone.NO_TONE
                raised = result
            else:
                conversion = tone.convert_cell(original, rules.legal_by_column[column],
                                               superscripts)
                status, raised = conversion.status, conversion.text
                tones[column].update(conversion.tones)
                if conversion.reason:
                    reasons[column][conversion.reason] += 1
            tally[column][status] += 1
            if raised != original:
                changed[column] += 1
                record[index] = raised
        out.append(record)
    return out, tally, tones, reasons, changed


def _cell(row, index):
    """A row can be narrower than the header; read it as corpus_probe does."""
    return row[index] if index < len(row) else ""


def verify(headers, before, after, columns):
    """Refuse to call a batch done unless the untouched parts are provably untouched.

    The invariant for a converted cell is that flattening both sides gives the same
    string: raising a tone may change how a digit is written, never which digits are
    there or in what order. Anything looser would pass on a cell that dropped one.
    """
    problems = []
    if len(before) != len(after):
        problems.append("row count changed: %d -> %d" % (len(before), len(after)))
        return problems
    targets = {headers.index(c) for c in columns if c in headers}
    for number, (left, right) in enumerate(zip(before, after), start=2):
        if len(left) != len(right):
            problems.append("line %d width changed: %d -> %d"
                            % (number, len(left), len(right)))
            continue
        for index in range(len(headers)):
            if index in targets:
                if tone.flatten(_cell(right, index)) != tone.flatten(_cell(left, index)):
                    problems.append("line %d column %s lost or reordered a digit"
                                    % (number, headers[index]))
            elif _cell(left, index) != _cell(right, index):
                problems.append("line %d column %s changed but is not a target"
                                % (number, headers[index]))
    return problems


def guard_output(csv_path, out_path):
    """Keep the 正本 itself and the repo tree out of harm's way."""
    target = os.path.abspath(out_path)
    if target == os.path.abspath(csv_path):
        return "refusing to overwrite the input corpus: %s" % input_source.display_path(target)
    if target == REPO_ROOT or target.startswith(REPO_ROOT + os.sep):
        return ("refusing to write corpus text inside the repository (%s): unlicensed "
                "corpus must not be committed (CONTRIBUTING.md, #92)" % REPO_ROOT)
    return None


def write_csv(path, headers, rows):
    """Match the 正本's shape: UTF-8 BOM, CRLF record terminators, minimal quoting."""
    with open(path, "w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.writer(handle, lineterminator="\r\n")
        writer.writerow(headers)
        writer.writerows(rows)


def report_lines(source, digest, rules, rows, tally, tones, reasons, changed, columns,
                 superscripts):
    print("source: %s  sha256: %s…" % (source, digest[:16]))
    print("scheme: %s  rule_version: %s  rows: %d" % (rules.scheme_id, rules.rule_version, rows))
    print("superscript repertoire: %s"
          % " ".join("U+%04X" % ord(char) for char in sorted(superscripts.values())))
    for column in columns:
        counts = tally[column]
        total = sum(counts.values())
        print("\n%s: cells=%d changed=%d" % (column, total, changed[column]))
        for status in (tone.EXACT, tone.NO_TONE, tone.AMBIGUOUS, tone.UNSUPPORTED, tone.EMPTY):
            if counts.get(status):
                print("  %-12s %6d (%.2f%%)" % (status, counts[status],
                                                100.0 * counts[status] / max(1, total)))
        if tones[column]:
            histogram = ", ".join("%s×%d" % (t, n)
                                  for t, n in sorted(tones[column].items(), key=lambda kv: -kv[1]))
            print("  tone_values: %s" % histogram)
        for reason, count in reasons[column].most_common(5):
            print("  reason %-34s %d" % (reason, count))


def main(argv=None):
    parser = argparse.ArgumentParser(description="convert tone digits to/from superscripts")
    parser.add_argument("--csv", help="corpus CSV path (or set WANYU_CORPUS_CSV)")
    parser.add_argument("--keyboard", help="keyboard JSON that declares the typeable "
                        "superscript digits (defaults to the repo's 莆仙方言键盘)")
    parser.add_argument("--rules", help="tone notation rule file (defaults to this "
                        "package's data/tone_notation.json)")
    parser.add_argument("--scheme", default=DEFAULT_SCHEME,
                        help="which annotation scheme the readings use; must be declared, "
                             "never inferred (#189 非目标)")
    parser.add_argument("--column", action="append", dest="columns",
                        help="column to convert; repeatable (defaults to the scheme's own)")
    parser.add_argument("--direction", choices=("raise", "flatten"), default="raise")
    parser.add_argument("--out", help="write the converted CSV here (never inside the repo)")
    parser.add_argument("--json", action="store_true", help="emit the tally as json")
    parser.add_argument("--show-samples", type=int, default=0, metavar="N",
                        help="also print N converted cells with their original text")
    args = parser.parse_args(argv)

    try:
        path = input_source.resolve_corpus_path(["--csv", args.csv] if args.csv else [])
        keyboard = input_source.resolve_keyboard_path(
            ["--keyboard", args.keyboard] if args.keyboard else [])
        rules = tone.load_tone_rules(args.rules or tone.RULE_FILE, args.scheme)
        repertoire = input_source.load_repertoire(keyboard)
        superscripts = tone.load_superscript_map(
            chr(codepoint) for codepoint in repertoire)
        if not superscripts:
            print("error: the enabled keyboard declares no superscript digits; "
                  "nothing can be raised", file=sys.stderr)
            return 2
        columns = args.columns or list(rules.columns)
        headers, rows = input_source.read_rows(path)
        unknown = [c for c in columns if c not in headers]
        if unknown:
            print("error: columns not in this csv: %s" % ", ".join(unknown), file=sys.stderr)
            return 2
        for column in columns:
            if column not in rules.legal_by_column:
                print("error: scheme %s declares no tone values for column %s"
                      % (rules.scheme_id, column), file=sys.stderr)
                return 2
    except (input_source.InputSourceError, tone.SchemeError, OSError, ValueError) as error:
        print("error: %s" % error, file=sys.stderr)
        return 2

    digest = input_source.checksum(path)
    converted, tally, tones, reasons, changed = convert_rows(
        headers, rows, rules, superscripts, columns, args.direction)

    if args.out:
        blocked = guard_output(path, args.out)
        if blocked:
            print("error: %s" % blocked, file=sys.stderr)
            return 2
        problems = verify(headers, rows, converted, columns)
        if problems:
            print("error: refusing to write, verification failed: %s"
                  % "; ".join(problems[:5]), file=sys.stderr)
            return 2
        write_csv(args.out, headers, converted)
        print("wrote: %s (verification: %d rows, untouched columns identical)"
              % (input_source.display_path(args.out), len(converted)))

    if args.json:
        json.dump({"source": os.path.basename(path), "sha256": digest, "rows": len(rows),
                   "scheme": rules.scheme_id, "rule_version": rules.rule_version,
                   "direction": args.direction,
                   "superscript_repertoire": [hex(ord(char))
                                              for char in sorted(superscripts.values())],
                   "columns": {column: {"statuses": dict(tally[column]),
                                        "changed": changed[column],
                                        "tone_values": dict(tones[column]),
                                        "reasons": dict(reasons[column])}
                               for column in columns}},
                  sys.stdout, ensure_ascii=False, indent=2)
        print()
    else:
        report_lines(os.path.basename(path), digest, rules, len(rows), tally, tones,
                     reasons, changed, columns, superscripts)

    if args.show_samples:
        print("warning: output below contains corpus field contents; do not paste "
              "it into issues, commits, or any non-private channel.", file=sys.stderr)
        shown = 0
        for original, result in zip(rows, converted):
            for column in columns:
                index = headers.index(column)
                if index < len(original) and original[index] != result[index]:
                    print(json.dumps({"column": column, "before": original[index],
                                      "after": result[index]}, ensure_ascii=False))
                    shown += 1
                    if shown >= args.show_samples:
                        return 0
    return 0


if __name__ == "__main__":
    sys.exit(main())
