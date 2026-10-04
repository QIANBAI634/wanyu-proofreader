// #125 分列纯函数的字符类先验，移植自 scripts/corpus_probe/detectors.py 的最小集。
//
// 用途：判断一个单元格（或一串字符）的「主导类别」，供列归属分类器决定
// 该格应归到哪一列（词头 / 读音 / 释义 …），以及是否发生了「列合并」。
//
// 内容红线（docs/plans/2026-09-25-review-findings.md §7）：本层只产出「结构
// 信息」（码位区间、类别、计数），不产出字形序列——这与 detectors 的判据一致。

// ---- 汉字判定 ----
// 与 frontend/src/lib/rareCharacters.js 的区间保持一致，另加 CJK 统一表意
// 文字主区（常用字），因为「词头」「释义」都可能落在主区。
const CJK_UNIFIED = [0x4e00, 0x9fff]
const CJK_EXTENSION = [
  [0x3400, 0x4dbf], // Ext A
  [0xf900, 0xfaff], // Compatibility Ideographs
  [0x20000, 0x2ee5f], // Ext B–F
  [0x2f800, 0x2fa1f], // Compatibility Supplement
  [0x30000, 0x3347f] // Ext G
]

function inRanges(cp, ranges) {
  return ranges.some(([lo, hi]) => cp >= lo && cp <= hi)
}

export function isHan(ch) {
  if (!ch) return false
  const cp = ch.codePointAt(0)
  return cp >= CJK_UNIFIED[0] && cp <= CJK_UNIFIED[1] || inRanges(cp, CJK_EXTENSION)
}

// ---- 读音 / 音标判定 ----
// IPA 块（U+0250–U+02AF）、修饰字母（U+02B0–U+02FF）、组合附标（U+0300–U+036F），
// 以及拉丁音标字母（ŋ ø ɒ 等，detectors.PHONETIC_RUN 里的非 ASCII 音标字符）。
const IPA_BLOCK = [0x0250, 0x02af]
const MODIFIER_LETTERS = [0x02b0, 0x02ff]
const COMBINING_DIACRITICS = [0x0300, 0x036f]
// detectors.PHONETIC_RUN 里出现的音标专用非 ASCII 字符（不含 ASCII 拉丁字母）。
const PHONETIC_SYMBOLS = new Set('ɐ-ʙʀ-ʗβθɒɔɛəɤɬʔŋɡǾø'.split('').filter((c) => c !== '-'))

export function isIpa(ch) {
  if (!ch) return false
  const cp = ch.codePointAt(0)
  return inRanges(cp, [IPA_BLOCK, MODIFIER_LETTERS, COMBINING_DIACRITICS]) || PHONETIC_SYMBOLS.has(ch)
}

// 拉丁字母（含带变音符的拉丁）——读音列的主体。
// 覆盖 Latin-1 Supplement（U+00C0–U+00FF，如 à á ø ÿ）与 Latin Extended-A
// （U+0100–U+017F，如 ā ē ū Ǿ），与 detectors.PHONETIC_RUN 对齐。
export function isLatin(ch) {
  if (!ch) return false
  const cp = ch.codePointAt(0)
  return (cp >= 0x0041 && cp <= 0x005a) || (cp >= 0x0061 && cp <= 0x007a)
    || (cp >= 0x00c0 && cp <= 0x00ff) || (cp >= 0x0100 && cp <= 0x017f)
}

// 声调数字（单字符 0–9）——读音列的声调标记。
export function isToneDigit(ch) {
  if (!ch) return false
  const cp = ch.codePointAt(0)
  return cp >= 0x0030 && cp <= 0x0039
}

// 带圈序号（①–⑳）与全角数字——释义列的义项标记。
const CIRCLED = new Set('①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳')

export function isCircledNumber(ch) {
  return CIRCLED.has(ch)
}

// 释义分隔符（：‖ 等），与 detectors.MEANING_SEPARATOR 对齐。
const MEANING_SEPARATORS = new Set('：‖')

export function isMeaningSeparator(ch) {
  return MEANING_SEPARATORS.has(ch)
}

// 集外字占位符：PUA(U+E000–U+F8FF) 与 IDS(U+2FF0–U+2FFF)。
// 与 ocr/charset.py 的 ABSTAIN_RANGES 对齐——#123 用它们表示收不进 Unicode 的
// 集外字。分列时它们属于「内容字符」（词头/释义里打不出的字），不是无意义的 other，
// 否则纯 PUA 词头会被 charClass 判成 'other' 而错位。
const PLACEHOLDER_RANGES = [
  [0xe000, 0xf8ff], // Private Use Area
  [0x2ff0, 0x2fff] // Ideographic Description Characters
]

export function isPlaceholderChar(ch) {
  if (!ch) return false
  const cp = ch.codePointAt(0)
  return inRanges(cp, PLACEHOLDER_RANGES)
}

// @hex 占位符：@ + 3~6 位十六进制（与 detectors.PLACEHOLDER = @[\da-fA-F]{3,6} 对齐）。
const HEX_PLACEHOLDER_RE = /@[\da-fA-F]{3,6}/

// 折叠 @hex 占位符为一个 PUA 占位字符：这样「打不出的字」整体归入内容字符（han），
// 而不是把 @ 和 hex 位拆开、让 hex 位被误判成声调数字。
function collapseHexPlaceholders(text) {
  return String(text ?? '').replace(/@[\da-fA-F]{3,6}/g, '')
}

// ---- 主导类别 ----
// 对一个单元格文本，统计其码点类别，返回主导类别：
//   'han'      —— 主要是汉字（词头 / 释义的正文）
//   'reading'  —— 主要是音标/拉丁字母/声调数字（读音列）
//   'mixed'    —— 同时含「汉字」与「读音类」两派，疑似列合并
//   'empty'    —— 空串
export function charClass(text) {
  // 先折叠 @hex 占位符，避免 hex 位被当声调数字（阻断项修复）。
  const str = collapseHexPlaceholders(text).trim()
  if (!str) return 'empty'

  let han = 0
  let reading = 0
  for (const ch of Array.from(str)) {
    if (isMeaningSeparator(ch) || ch === ' ' || ch === '\t' || isCircledNumber(ch)) {
      // 分隔符/义项序号是「释义」的结构标记，不偏向读音。
      continue
    }
    // 集外字占位符（PUA/IDS，含折叠进来的 @hex）是「内容字符」，归入词头/释义类。
    if (isHan(ch) || isPlaceholderChar(ch)) { han += 1; continue }
    if (isIpa(ch) || isLatin(ch)) { reading += 1; continue }
    // 声调数字：只有前面已有读音字符时才算（如 kiā533），孤立数字/年份（1978）不算。
    if (isToneDigit(ch) && reading > 0) { reading += 1; continue }
  }

  if (han > 0 && reading > 0) return 'mixed'
  if (han > 0) return 'han'
  if (reading > 0) return 'reading'
  return 'other'
}

// 对一串文本，按「读音段 / 非读音段」切出码位区间（半开 [start,end)）。
// 供合并格检测输出 char_offsets，与 fieldHints.js 的 locateSpan 同口径。
export function readingSpans(text) {
  const chars = Array.from(String(text ?? ''))
  const spans = []
  let start = -1
  for (let i = 0; i < chars.length; i += 1) {
    const isReading = isIpa(chars[i]) || isLatin(chars[i]) || isToneDigit(chars[i])
    if (isReading && start === -1) start = i
    if (!isReading && start !== -1) {
      spans.push([start, i])
      start = -1
    }
  }
  if (start !== -1) spans.push([start, chars.length])
  return spans
}
