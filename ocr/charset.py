"""难字 / 弃权字符集定义（#120 打分脚本共享）。

范围与仓库基线对齐：
- frontend/src/lib/rareCharacters.js 的罕见字判定
- scripts/corpus_probe/detectors.py 的 CJK 扩展区段
- backend/keyboards/ 的目标字符集（IPA 与鼻化附加符）

集中在此定义，避免 score.py 再手抄一份导致不一致。
"""

# 罕见汉字区段（与 rareCharacters.js 对齐）
RARE_CJK_RANGES = (
    (0x3400, 0x4DBF),     # CJK Extension A
    (0xF900, 0xFAFF),     # CJK Compatibility Ideographs
    (0x20000, 0x2EE5F),   # CJK Extension B–F（含补充）
    (0x2F800, 0x2FA1F),   # Compatibility Ideographs Supplement
    (0x30000, 0x3347F),   # CJK Extension G
)

# IPA 音标块（U+0250–U+02AF），含鼻化附加符 U+0303 等
IPA_BLOCK = (0x0250, 0x02AF)

# 鼻化/变音附加符与声调符号（常用在莆仙 IPA 上标）
IPA_DIACRITICS = frozenset(
    "Ǿã̃ḁ̩̯̃̃̄̆́̀̂̌̋̏ʰʲʷˠˤʳ"
)

# 带圈序号 ①–⑳ 与上标调号 ¹–⁰
CIRCLED = frozenset("①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳")
SUPERSCRIPT = frozenset("¹²³⁴⁵⁶⁷⁸⁹⁰")


def in_ranges(code, ranges):
    return any(lo <= code <= hi for lo, hi in ranges)


def is_rare_cjk(ch):
    """是否罕见汉字（Ext A/B–F/G、兼容表意、兼容补充）。"""
    return in_ranges(ord(ch), RARE_CJK_RANGES)


def is_ipa(ch):
    """是否 IPA 音标或鼻化/变音附加符。"""
    return in_ranges(ord(ch), (IPA_BLOCK,)) or ch in IPA_DIACRITICS


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
