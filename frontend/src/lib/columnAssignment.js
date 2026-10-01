// #125 分列纯函数：列归属分类器。
//
// 只做「把一行已经切好的候选格，判定各自归属哪一列，并标记哪些格发生了列合并」。
// 不碰数据模型、不写 review_findings（接入 #176 契约是后续独立步骤），
// 不自动分割空白游程（#125 正文警告会在方言音标上误判）。
//
// 首版门槛（开工前写定，需在 #125 issue 下由组长正式确认）：
//   - 列归属准确率 ≥ 0.90（无框多列）
//   - 合并未分离检出率 ≥ 0.80
//   - 静默替换率 = 0（分列不改字，天然满足）

import { suggestColumnRole } from './columnRoleSuggestion.js'
import { charClass, readingSpans, isMeaningSeparator, isCircledNumber } from './columnChars.js'

// 角色 → 期望的字符类别。'unspecified' 不设期望（退化为按顺序对齐）。
const ROLE_EXPECTED_CLASS = {
  headword: 'han',
  reading: 'reading',
  meaning: 'han',
  region: 'other',
  example: 'han',
  note: 'other'
}

// assignColumns(headers, cells)：
//   headers —— 目标列名数组（不含页码列）
//   cells   —— 一行候选格字符串数组（长度可能 ≠ headers，可能含合并格）
// 返回 [{ cellIndex, assignedHeader, merged, charOffsets }]。
//
// 算法：先按「列角色期望类别」做精确匹配（格类别 == 列期望类别），剩余格
// 按顺序回退对齐；若某格类别为 'mixed'，或命中合并启发式，标记 merged 并
// 输出 readingSpans 得到的 char_offsets（码位半开区间）。
export function assignColumns(headers, cells) {
  const hs = (headers || []).map(String)
  const cs = (cells || []).map((c) => String(c ?? ''))
  const roles = hs.map(suggestColumnRole)

  const result = cs.map((cell, cellIndex) => {
    const cls = charClass(cell)
    const merged = isMergedCell(cell, cls)
    return {
      cellIndex,
      assignedHeader: '',
      merged,
      charOffsets: merged ? readingSpans(cell) : undefined
    }
  })

  // 精确匹配：对每个「有期望角色」的列，找类别相符且未分配的格。
  const used = new Set()
  const assignedTo = new Array(hs.length).fill(-1) // 列 → 格索引
  for (let col = 0; col < hs.length; col += 1) {
    const expected = ROLE_EXPECTED_CLASS[roles[col]]
    if (!expected) continue
    for (let cell = 0; cell < cs.length; cell += 1) {
      if (used.has(cell)) continue
      const cls = charClass(cs[cell])
      if (cls === expected && !result[cell].merged) {
        assignedTo[col] = cell
        used.add(cell)
        break
      }
    }
  }

  // 回退对齐：未精确匹配的列，按列顺序接未分配的格（按格顺序）。
  const freeCells = []
  for (let cell = 0; cell < cs.length; cell += 1) if (!used.has(cell)) freeCells.push(cell)
  for (let col = 0; col < hs.length; col += 1) {
    if (assignedTo[col] !== -1) continue
    if (freeCells.length === 0) break
    assignedTo[col] = freeCells.shift()
    used.add(assignedTo[col])
  }

  for (let col = 0; col < hs.length; col += 1) {
    const cell = assignedTo[col]
    if (cell !== -1) result[cell].assignedHeader = hs[col]
  }
  // 未被任何列接住的格（cell 数 > headers 数），保持 assignedHeader 空串。

  return result
}

// 合并格启发式（对齐 detectors.detect_column_collapse / detect_phonetic_in_meaning）：
//   1. charClass 为 'mixed'（同格同时含汉字与读音类）
//   2. 含义项序号后紧跟读音类（如「①啊 ②啊」里夹了音标段）——用 readingSpans 落在释义格判定
// 第 2 条较难可靠判定，首版只用 mixed + 不平衡括号 + 地区标签。
const REGION_LABEL = /〔(?:莆田|仙游|[莆仙])〕/

function isMergedCell(cell, cls) {
  if (!cell) return false
  if (cls === 'mixed') return true
  // 地区标签（〔莆田〕）或成对括号不平衡 → 列合并信号（detectors.detect_column_collapse）
  if (REGION_LABEL.test(cell)) return true
  const fullWidthOpen = (cell.match(/［/g) || []).length
  const fullWidthClose = (cell.match(/］/g) || []).length
  if (fullWidthOpen !== fullWidthClose) return true
  const asciiOpen = (cell.match(/\[/g) || []).length
  const asciiClose = (cell.match(/\]/g) || []).length
  if (asciiOpen !== asciiClose) return true
  return false
}

// 便捷导出：给一行直接返回「列名 → 单元格值」的映射（用于后续 #124 预览）。
export function assignRow(headers, cells) {
  const assigned = assignColumns(headers, cells)
  const row = {}
  for (const a of assigned) {
    if (a.assignedHeader) row[a.assignedHeader] = cells[a.cellIndex]
  }
  return row
}

export { isMeaningSeparator, isCircledNumber }
