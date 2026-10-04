// #124 可疑格检测纯函数。
//
// 输入「目标表头 + 一行的结构化对象」，输出该行的可疑格标记列表。
// 只产出结构信息（码位计数、列名、信号类型），不产出单元格正文——
// 判据同 scripts/corpus_probe/README.md：码位是结构信息，字形序列是内容。
//
// 三类信号（对齐 #124 正文建议）：
//   - width：本行有效列数 vs 表头数不符（多列并一格 / 少列）
//   - long ：单元格码点数超过阈值（异常长）
//   - rare ：单元格含罕见字（CJK 扩展区，复用 rareCharacters.js）
//   - ipa  ：单元格含 IPA 音标字符聚集（本地判定，避免跨 #125 依赖）

import { rareCharacters } from './rareCharacters.js'

// 超长单元格阈值（码点数）。词典释义格正常会较长，但超过此值即提示人工复核。
export const LONG_CELL_CODEPOINTS = 200

// 单个单元格内 IPA 字符数量的告警阈值。
export const IPA_DENSE_THRESHOLD = 5

function codepointCount(text) {
  return Array.from(String(text ?? '')).length
}

// isIpaChar：本地最小 IPA 判定，与 columnChars.js 的 isIpa 语义一致
// （IPA 块 U+0250–U+02AF、修饰字母 U+02B0–U+02FF、组合附标 U+0300–U+036F）。
// 独立内联，避免 #124 依赖尚未合并的 #125 的 columnChars.js。
function isIpaChar(ch) {
  if (!ch) return false
  const cp = ch.codePointAt(0)
  return (cp >= 0x0250 && cp <= 0x02af)
    || (cp >= 0x02b0 && cp <= 0x02ff)
    || (cp >= 0x0300 && cp <= 0x036f)
}

// inspectRow(headers, rowObj) → [{ header, signal, count? }]
//   headers —— 目标列名数组
//   rowObj   —— header → value 的结构化行对象
export function inspectRow(headers, rowObj) {
  const hs = (headers || []).map(String)
  const row = rowObj && typeof rowObj === 'object' && !Array.isArray(rowObj) ? rowObj : {}
  const marks = []

  // 1. 列数不符：有效列（值非空）的数量 vs 表头数。
  //    一行里「有内容」的列数少于表头数，往往是多列被并进一格或整列丢失。
  const present = hs.filter((h) => {
    const v = row[h]
    return v !== undefined && v !== null && String(v).trim() !== ''
  }).length
  if (present !== hs.length) {
    marks.push({ header: '', signal: 'width', count: present, expected: hs.length })
  }

  // 2. 逐格检查：超长 / 罕见字 / IPA 密集。
  for (const h of hs) {
    const value = String(row[h] ?? '')
    if (value === '') continue
    const n = codepointCount(value)
    if (n > LONG_CELL_CODEPOINTS) {
      marks.push({ header: h, signal: 'long', count: n })
    }
    const rare = rareCharacters([value])
    if (rare.length) {
      marks.push({ header: h, signal: 'rare', count: rare.length })
    }
    const ipaCount = Array.from(value).filter((ch) => isIpaChar(ch)).length
    if (ipaCount >= IPA_DENSE_THRESHOLD) {
      marks.push({ header: h, signal: 'ipa', count: ipaCount })
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
