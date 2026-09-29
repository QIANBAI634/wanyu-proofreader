"""难字 / 弃权字符集定义（#120 打分脚本共享）。

范围与仓库基线对齐，不再手抄字集清单：
- 罕见汉字：frontend/src/lib/rareCharacters.js 的判定区间（本文件 RARE_CJK_RANGES 与其对齐）
- 音标字符：scripts/corpus_probe/detectors.py（真正 import 模块，用其 PHONETIC_RUN 与 IPA_BLOCK）
- 带圈序号 / 上标调号：本文件内固定集合
"""

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

# 组合用鼻化/变音附加符（U+0300–U+036F）
_COMBINING_DIACRITICS = (0x0300, 0x036F)
# 修饰字母区段（U+02B0–U+02FF），含 ʰ ʷ ʲ ˠ ˤ ʳ 等上标音标
_MODIFIER_LETTERS = (0x02B0, 0x02FF)


def _load_detectors():
    """真正 import scripts/corpus_probe/detectors.py，返回其模块（或 None）。

    不解析其正则源码，而是直接用它的 PHONETIC_RUN 与 IPA_BLOCK。
    """
    repo_root = Path(__file__).resolve().parent.parent
    scripts_dir = repo_root / "scripts"
    if not (scripts_dir / "corpus_probe" / "detectors.py").is_file():
        return None
    if str(scripts_dir) not in sys.path:
        sys.path.insert(0, str(scripts_dir))
    try:
        from corpus_probe import detectors
        return detectors
    except ImportError:
        return None


_detectors = _load_detectors()


def in_ranges(code, ranges):
    return any(lo <= code <= hi for lo, hi in ranges)


def is_rare_cjk(ch):
    """是否罕见汉字（Ext A/B–F/G、兼容表意、兼容补充）。"""
    return in_ranges(ord(ch), RARE_CJK_RANGES)


def is_ipa(ch):
    """是否 IPA 音标 / 音标用拉丁变音字母 / 修饰字母 / 鼻化附加符。

    判据优先级：
    1. detectors.PHONETIC_RUN.fullmatch：仓库唯一的音标字符类（含拉丁变音字母 ŋ œ β θ 等）
    2. detectors.IPA_BLOCK：IPA 扩展块（U+0250–U+02AF）
    3. 修饰字母区段 U+02B0–U+02FF 与组合附加符 U+0300–U+036F
    """
    if _detectors is not None:
        if _detectors.PHONETIC_RUN.fullmatch(ch):
            return True
        if ch and ord(ch) in _detectors.IPA_BLOCK:
            return True
    return in_ranges(ord(ch), (_MODIFIER_LETTERS, _COMBINING_DIACRITICS))


def is_hard_char(ch):
    """是否「难字」：罕见汉字 / IPA / 带圈序号 / 上标调号。

    这是 #120 生僻字覆盖、静默替换率、集外字可表示性的判定基础。
    """
    return is_rare_cjk(ch) or is_ipa(ch) or ch in CIRCLED or ch in SUPERSCRIPT


# 弃权词表：OCR 引擎「读不出」时的合法占位形态，不得判为静默替换。
# - 空格 / 空串：引擎未输出
# - PUA 私用区（U+E000–U+F8FF）：用私用码位占位（见 #123 的 PUA 方案）
# - IDS 运算符（U+2FF0–U+2FFF）：表意文字描述序列（见 #123 的 IDS 方案）
ABSTAIN_RANGES = (
    (0xE000, 0xF8FF),     # Private Use Area
    (0x2FF0, 0x2FFF),     # Ideographic Description Characters
)


def is_abstain_char(ch):
    """是否「合法弃权」占位：空格 / 私用码位 / IDS 运算符。"""
    if ch == "" or ch.isspace():
        return True
    return in_ranges(ord(ch), ABSTAIN_RANGES)
