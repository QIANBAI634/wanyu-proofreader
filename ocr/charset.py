"""难字 / 弃权字符集定义（#120 打分脚本共享）。

范围与仓库基线对齐，不再手抄：
- 罕见汉字：frontend/src/lib/rareCharacters.js 的判定区间
- 音标字符：scripts/corpus_probe/detectors.py 的 PHONETIC_RUN（运行时 import，保证一致）
- 带圈序号 / 上标调号：本文件内固定集合
"""

import re
import sys
from pathlib import Path

# 罕见汉字区段（与 rareCharacters.js 对齐）
RARE_CJK_RANGES = (
    (0x3400, 0x4DBF),     # CJK Extension A
    (0xF900, 0xFAFF),     # CJK Compatibility Ideographs
    (0x20000, 0x2EE5F),   # CJK Extension B–F（含补充）
    (0x2F800, 0x2FA1F),   # Compatibility Ideographs Supplement
    (0x30000, 0x3347F),   # CJK Extension G
)

# 带圈序号 ①–⑳ 与上标调号 ¹–⁰
CIRCLED = frozenset("①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳")
SUPERSCRIPT = frozenset("¹²³⁴⁵⁶⁷⁸⁹⁰")

# 组合用鼻化/变音附加符（U+0300–U+036F 区段，超出 PHONETIC_RUN 覆盖）
_COMBINING_DIACRITICS = (0x0300, 0x036F)


def _load_phonetic_charset():
    """从 scripts/corpus_probe/detectors.py 的 PHONETIC_RUN 提取音标字符集。

    保证与仓库唯一权威字集一致，不在这里手抄第三份清单。
    """
    repo_root = Path(__file__).resolve().parent.parent
    detectors = repo_root / "scripts" / "corpus_probe" / "detectors.py"
    if not detectors.is_file():
        # 无法定位 detectors 时退回最小 IPA 块，避免脚本完全不可用
        return frozenset(), (0x0250, 0x02AF)
    src = detectors.read_text(encoding="utf-8")
    m = re.search(r"PHONETIC_RUN = re\.compile\(\s*r\"\[([^\]]*)\]", src)
    if not m:
        return frozenset(), (0x0250, 0x02AF)
    return frozenset(m.group(1)), (0x0250, 0x02AF)


_PHONETIC_CHARS, _IPA_BLOCK = _load_phonetic_charset()


def in_ranges(code, ranges):
    return any(lo <= code <= hi for lo, hi in ranges)


def is_rare_cjk(ch):
    """是否罕见汉字（Ext A/B–F/G、兼容表意、兼容补充）。"""
    return in_ranges(ord(ch), RARE_CJK_RANGES)


def is_ipa(ch):
    """是否 IPA 音标 / 音标用拉丁变音字母 / 鼻化附加符。"""
    if ch in _PHONETIC_CHARS:
        return True
    return in_ranges(ord(ch), (_IPA_BLOCK, _COMBINING_DIACRITICS))


def is_hard_char(ch):
    """是否「难字」：罕见汉字 / IPA / 带圈序号 / 上标调号。

    这是 #120 生僻字覆盖、静默替换率、集外字可表示性的判定基础。
    """
    return is_rare_cjk(ch) or is_ipa(ch) or ch in CIRCLED or ch in SUPERSCRIPT


# 弃权词表：OCR 引擎「读不出」时的合法占位形态，不得判为静默替换。
# - 空格 / 空串：引擎未输出
# - PUA 私用区（U+E000–U+F8FF）：用私用码位占位（见 #123 的 PUA 方案）
# - IDS 运算符（U+2FF0–U+2FFF）：表意文字描述序列（见 #123 的 IDS 方案）
# - 兼容表意文字若作为「明确弃权」出现，也应算弃权而非替换
ABSTAIN_RANGES = (
    (0xE000, 0xF8FF),     # Private Use Area
    (0x2FF0, 0x2FFF),     # Ideographic Description Characters
)


def is_abstain_char(ch):
    """是否「合法弃权」占位：空格 / 私用码位 / IDS 运算符。"""
    if ch == "" or ch.isspace():
        return True
    return in_ranges(ord(ch), ABSTAIN_RANGES)
