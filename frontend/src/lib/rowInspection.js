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

function codepointCount(text) {
  return Array.from(String(text ?? '')).length
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

// inspectRow(headers, rowObj) → [{ field, message: {key, params} }]
//   headers —— 目标列名数组
//   rowObj   —— header → value 的结构化行对象
export function inspectRow(headers, rowObj) {
  const hs = (headers || []).map(String)
  const row = rowObj && typeof rowObj === 'object' && !Array.isArray(rowObj) ? rowObj : {}
  const marks = []

  // 1. 结构性列缺失：表头里有某列，但 rowObj 里根本没有这个键。
  //    「值空」是另一条信号（required_role_field_empty），不能并进这里——
  //    否则合法留空的行会被误报成列合并（#124 S2）。
  const missingKeys = hs.filter((h) => !Object.prototype.hasOwnProperty.call(row, h))
  if (missingKeys.length) {
    marks.push({
      field: '',
      message: {
        key: 'row_width_differs',
        params: { cells: hs.length - missingKeys.length, headers: hs.length }
      }
    })
  }

  // 2. 逐格检查：超长 / 罕见字 / IPA 密集。
  for (const h of hs) {
    const value = String(row[h] ?? '')
    if (value === '') continue
    const n = codepointCount(value)
    if (n > LONG_CELL_CODEPOINTS) {
      marks.push({ field: h, message: { key: 'long_cell', params: { codepoints: n } } })
    }
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
    const ipaCodepoints = Array.from(value).filter((ch) => isIpaChar(ch)).map((ch) => ch.codePointAt(0))
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
