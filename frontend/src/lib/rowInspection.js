// #124 可疑格检测纯函数。
//
// 输入「目标表头 + 一行的结构化对象」，输出该行的可疑格标记列表。
// 输出形状对齐 review_findings 的 hint 视图（field + message:{key,params}），
// 措辞复用 findingMessages.js 的唯一词表，不在组件里另写文案。
// 只产出结构信息（码位、计数、列名），不产出单元格正文。

import { rareCharacters } from './rareCharacters.js'

// 超长单元格阈值（码点数）。
export const LONG_CELL_CODEPOINTS = 200

// 单个单元格内 IPA 字符数量的告警阈值。
export const IPA_DENSE_THRESHOLD = 5

// isHanChar：CJK 统一表意文字主区（常用字）。
function isHanChar(ch) {
  if (!ch) return false
  const cp = ch.codePointAt(0)
  return cp >= 0x4e00 && cp <= 0x9fff
}

// isIpaChar：本地最小 IPA 判定（IPA 块 U+0250–U+02AF、修饰字母 U+02B0–U+02FF、
// 组合附标 U+0300–U+036F）。独立内联，避免 #124 依赖尚未合并的 #125。
function isIpaChar(ch) {
  if (!ch) return false
  const cp = ch.codePointAt(0)
  return (cp >= 0x0250 && cp <= 0x02af)
    || (cp >= 0x02b0 && cp <= 0x02ff)
    || (cp >= 0x0300 && cp <= 0x036f)
}

// isLatinChar：ASCII 拉丁字母 + Latin-1/Latin Extended-A 变音字母（如 ā）。
function isLatinChar(ch) {
  if (!ch) return false
  const cp = ch.codePointAt(0)
  return (cp >= 0x0041 && cp <= 0x005a) || (cp >= 0x0061 && cp <= 0x007a)
    || (cp >= 0x00c0 && cp <= 0x00ff) || (cp >= 0x0100 && cp <= 0x017f)
}

// inspectRow(headers, rowObj) → [{ field, message: {key, params} }]
//   headers —— 目标列名数组
//   rowObj   —— header → value 的结构化行对象
//
// 信号：
//   - column_collapse：一格同时含「汉字」与「读音类（音标/拉丁）」，疑似列合并
//     （这是 hydrate 后仍能触发的真实信号；"缺失键"在 hydrate 后恒不发生，
//     见 #124 复审：hydrate 会遍历 headers 逐个建键）
//   - long_cell：单元格超长
//   - cjk_extension_present：含罕见字
//   - non_ipa_range_codepoints：IPA 字符密集
export function inspectRow(headers, rowObj) {
  const hs = (headers || []).map(String)
  const row = rowObj && typeof rowObj === 'object' && !Array.isArray(rowObj) ? rowObj : {}
  const marks = []

  for (const h of hs) {
    const value = String(row[h] ?? '')
    if (value === '') continue
    const chars = Array.from(value)

    // 1. 列合并：一格同时含汉字 + 读音类（音标/拉丁）。这是「多列挤进一格」的可观测形状。
    const hasHan = chars.some(isHanChar)
    const hasReading = chars.some((ch) => isIpaChar(ch) || isLatinChar(ch))
    if (hasHan && hasReading) {
      marks.push({ field: h, message: { key: 'column_collapse', params: {} } })
    }

    // 2. 超长。
    const n = chars.length
    if (n > LONG_CELL_CODEPOINTS) {
      marks.push({ field: h, message: { key: 'long_cell', params: { codepoints: n } } })
    }

    // 3. 罕见字。
    const rare = rareCharacters([value])
    if (rare.length) {
      marks.push({
        field: h,
        message: {
          key: 'cjk_extension_present',
          params: { codepoints: rare.map((c) => c.codePointAt(0)) }
        }
      })
    }

    // 4. IPA 密集。
    const ipaCodepoints = chars.filter(isIpaChar).map((ch) => ch.codePointAt(0))
    if (ipaCodepoints.length >= IPA_DENSE_THRESHOLD) {
      marks.push({
        field: h,
        message: { key: 'non_ipa_range_codepoints', params: { codepoints: ipaCodepoints } }
      })
    }
  }

  return marks
}

// 便捷：给一个 page 记录，从 ocr_row_json / row_headers_json 直接算可疑格。
export function inspectPage(page) {
  if (!page || typeof page !== 'object') return []
  let headers = []
  let rowObj = {}
  try {
    headers = JSON.parse(page.row_headers_json || '[]')
  } catch { /* corrupt headers degrade to empty */ }
  try {
    const parsed = JSON.parse(page.ocr_row_json || '{}')
    if (parsed && !Array.isArray(parsed) && typeof parsed === 'object') rowObj = parsed
  } catch { /* corrupt row degrades to empty */ }
  return inspectRow(headers, rowObj)
}
