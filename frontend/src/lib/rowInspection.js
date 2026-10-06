// #124 可疑格检测纯函数。
//
// 输入「目标表头 + 一行的结构化对象」，输出该行的可疑格标记列表。
// 输出形状对齐 review_findings 的 hint 视图（field + message:{key,params}），
// 措辞复用 findingMessages.js 的唯一词表，不在组件里另写文案。
// 只产出结构信息（码位、计数、列名），不产出单元格正文。
//
// 本模块只保留两条「无争议、可解释」的信号：
//   - long_cell：单元格码点数超过阈值（异常长）
//   - cjk_extension_present：含罕见字 / 集外字（CJK 扩展区）
//
// 有意**不检测列合并**（#124 复审结论）：「一格同时含汉字与拉丁」在方言词典里
// 是常态（释义带读音括注、词源拉丁转写），真实语料 15,022 行触发 1,120 次、
// 99% 落在释义列、真阳性为 0 —— 净负价值。列合并检测应等到 #125 提供「拿表头
// 真源做对照」的判据（如用拼音/莆田IPA 列实际内容做包含比对）再补。

import { rareCharacters } from './rareCharacters.js'

// 超长单元格阈值（码点数）。
export const LONG_CELL_CODEPOINTS = 200

// inspectRow(headers, rowObj) → [{ field, message: {key, params} }]
//   headers —— 目标列名数组
//   rowObj   —— header → value 的结构化行对象
export function inspectRow(headers, rowObj) {
  const hs = (headers || []).map(String)
  const row = rowObj && typeof rowObj === 'object' && !Array.isArray(rowObj) ? rowObj : {}
  const marks = []

  for (const h of hs) {
    const value = String(row[h] ?? '')
    if (value === '') continue
    const chars = Array.from(value)

    // 1. 超长。
    const n = chars.length
    if (n > LONG_CELL_CODEPOINTS) {
      marks.push({ field: h, message: { key: 'long_cell', params: { codepoints: n } } })
    }

    // 2. 罕见字（CJK 扩展区 / 集外字）。
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
  }

  return marks
}
