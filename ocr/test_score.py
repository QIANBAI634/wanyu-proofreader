#!/usr/bin/env python3
"""score.py 的回归测试（覆盖 #120 审查意见的 6 个构造用例）。

只使用标准库 unittest，无需安装额外依赖。
运行：python -m unittest ocr.test_score 或 python ocr/test_score.py
"""

import csv
import io
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from score import score, align_positions  # noqa: E402


def make_csv(rows, fields):
    buf = io.StringIO()
    w = csv.DictWriter(buf, fieldnames=fields)
    w.writeheader()
    for r in rows:
        w.writerow(r)
    return buf.getvalue()


FIELDS = ["词头", "音读", "释义"]


class TestHardCharAlignment(unittest.TestCase):
    def test_insert_does_not_destroy_hard_chars(self):
        # 审查用例1：待测只多一个首字符，难字全部认对 → 生僻字覆盖应接近1，静默替换≈0
        gold = [{"词头": "㨄ɛʔ", "音读": "a", "释义": "x"}]
        test = [{"词头": "X㨄ɛʔ", "音读": "a", "释义": "x"}]
        r = score(gold, test, FIELDS)
        self.assertGreaterEqual(r["生僻字覆盖"], 0.9)
        self.assertLessEqual(r["静默替换率"], 0.01)

    def test_silent_replace_detected(self):
        # 难字被换成常用字 → 静默替换率 > 0
        gold = [{"词头": "㨄", "音读": "a", "释义": "x"}]
        test = [{"词头": "本", "音读": "a", "释义": "x"}]
        r = score(gold, test, FIELDS)
        self.assertGreater(r["静默替换率"], 0.0)


class TestAbstain(unittest.TestCase):
    def test_abstain_counts_as_covered(self):
        # 审查用例2：诚实弃权（空格/PUA/IDS）应记为合法弃权，生僻字覆盖=(认对+弃权)/总数
        gold = [{"词头": "㨄㧟", "音读": "a", "释义": "x"}]
        test = [{"词头": "  ", "音读": "a", "释义": "x"}]  # 两个难字各弃权成空格
        r = score(gold, test, FIELDS)
        # 弃权应计入覆盖，静默替换应为0
        self.assertGreaterEqual(r["生僻字覆盖"], 0.9)
        self.assertEqual(r["静默替换率"], 0.0)

    def test_pua_is_abstain_not_silent(self):
        # PUA 占位应算弃权，不算静默替换
        gold = [{"词头": "㨄", "音读": "a", "释义": "x"}]
        test = [{"词头": "", "音读": "a", "释义": "x"}]  # PUA
        r = score(gold, test, FIELDS)
        self.assertEqual(r["静默替换率"], 0.0)


class TestHardCharSet(unittest.TestCase):
    def test_compat_and_ext_g_are_hard(self):
        # 审查用例3：U+F900（兼容表意）、U+30000（Ext G）必须是难字
        hard = chr(0xF900) + chr(0x30000)
        gold = [{"词头": hard, "音读": "a", "释义": "x"}]
        test = [{"词头": "本本", "音读": "a", "释义": "x"}]
        r = score(gold, test, FIELDS)
        self.assertGreater(r["难字总数"], 0)
        self.assertGreater(r["静默替换率"], 0.0)


class TestMissingColumn(unittest.TestCase):
    def test_missing_column_is_not_full_score(self):
        # 审查用例4：待测缺「释义」列 → 不能满分
        gold = [{"词头": "a", "音读": "b", "释义": "c"}]
        test = [{"词头": "a", "音读": "b"}]  # 缺释义列
        r = score(gold, test, FIELDS)
        self.assertLess(r["列归属准确率"], 1.0)


class TestKeyAlignment(unittest.TestCase):
    def test_key_alignment_matches_rows(self):
        # 审查用例5：--key 应该按键值对齐，行序换了不该全错
        gold = [
            {"页码": "1", "词头": "a", "音读": "b", "释义": "c"},
            {"页码": "2", "词头": "d", "音读": "e", "释义": "f"},
        ]
        test = [
            {"页码": "2", "词头": "d", "音读": "e", "释义": "f"},
            {"页码": "1", "词头": "a", "音读": "b", "释义": "c"},
        ]
        r = score(gold, test, ["页码", "词头", "音读", "释义"], key="页码")
        self.assertEqual(r["列归属准确率"], 1.0)


class TestCerbounded(unittest.TestCase):
    def test_cer_is_bounded(self):
        # 审查用例6：空gold里吐出超长字符，CER/准确率必须 clamp 在 [0,1]
        gold = [{"词头": "", "音读": "", "释义": ""}]
        test = [{"词头": "x" * 61, "音读": "", "释义": ""}]
        r = score(gold, test, FIELDS)
        self.assertGreaterEqual(r["字级错误率 CER"], 0.0)
        self.assertLessEqual(r["字级错误率 CER"], 1.0)
        self.assertGreaterEqual(r["字级准确率"], 0.0)
        self.assertLessEqual(r["字级准确率"], 1.0)


if __name__ == "__main__":
    unittest.main()
