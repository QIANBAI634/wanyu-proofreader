#!/usr/bin/env node
// #179 弱标注集生成器：从「两份独立结果 + 一个人工确认的最终值」里按字段对齐产样本。
//
//   node scripts/assist/weak_labels.mjs --db backend/pb_data/data.db --out /tmp/labels.jsonl
//   node scripts/assist/weak_labels.mjs --records export.json --out /tmp/labels.jsonl
//
// 全程只读。默认输出不含任何单元格正文（判据同 scripts/corpus_probe）。
import { parseArgs } from 'node:util'
import { readFileSync, writeFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'

import { buildLabels, stripSecrets } from './lib/labeling.mjs'

// 抽出来以便用内存库单测同一份 SQL（列名写错是这类只读工具最常见的静默失败）。
//
// roles 是 #226 落进 `projects.column_roles_json` 的那份列角色，R5（必填角色列为空）
// 的判定作用域完全由它决定。过去 `--db` 路径不读它，报告头于是写「列角色未提供，
// R5 不参与打分」，读者会以为这条规则的精度是 0——而库里明明有答案。
// 一张库可能跨多个项目，列角色不一致时不给"猜一个"：`rolesConflict` 必须一路传到报告里，
// 因为「静默少评一条规则」正是本文件要修的那类事故。
function readRoles(db) {
  let rows
  try {
    rows = db.prepare(`
      SELECT column_roles_json FROM projects
      WHERE column_roles_json IS NOT NULL AND column_roles_json != ''
    `).all()
  } catch {
    // 裁剪过的副本或旧库没有 projects 表：按"未提供"降级，不中断打分。
    return { roles: null, rolesConflict: false }
  }
  const maps = new Set()
  for (const row of rows) {
    let parsed = null
    try {
      parsed = JSON.parse(row.column_roles_json)
    } catch {
      continue // 坏 JSON 视同没标，交给 --roles 显式覆盖
    }
    if (!parsed || typeof parsed !== 'object' || !Object.keys(parsed).length) continue
    maps.add(JSON.stringify(Object.entries(parsed).sort()))
  }
  if (maps.size === 0) return { roles: null, rolesConflict: false }
  if (maps.size > 1) return { roles: null, rolesConflict: true }
  return { roles: fromEntriesSorted([...maps][0]), rolesConflict: false }
}

// entries 形如 [["词条","headword"],…] 的 JSON 串，还原成映射（顺序无关，比较时才排序）。
function fromEntriesSorted(entriesJson) {
  return Object.fromEntries(JSON.parse(entriesJson))
}

export function readDataset(db) {
  const pages = db.prepare(`
      SELECT id, project, proofread_row_json AS final_row_json, status
      FROM pages
      WHERE proofread_row_json IS NOT NULL AND proofread_row_json != ''
    `).all()
    const attempts = db.prepare(`
      SELECT id, page, project, round, kind, proofreader, row_json, submitted_at
      FROM proofreading_attempts
      ORDER BY page, round, pass_no
    `).all()
    const { roles, rolesConflict } = readRoles(db)
    return { pages, attempts, roles, rolesConflict }
}

export function loadFromSqlite(path) {
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    return readDataset(db)
  } finally {
    db.close()
  }
}

export function loadFromRecords(path) {
  const parsed = JSON.parse(readFileSync(path, 'utf8'))
  if (!parsed || !Array.isArray(parsed.pages) || !Array.isArray(parsed.attempts)) {
    throw new Error('records 文件必须含 pages 与 attempts 两个数组')
  }
  return parsed
}

function main() {
  const { values } = parseArgs({ options: {
    db: { type: 'string' }, records: { type: 'string' }, out: { type: 'string' },
    'show-values': { type: 'string', default: '0' }, help: { type: 'boolean', default: false }
  } })
  if (values.help || (!values.db && !values.records)) {
    console.error('用法: weak_labels.mjs (--db <sqlite 文件> | --records <json 导出>) [--out <jsonl>] [--show-values N]')
    return 2
  }
  const dataset = values.db ? loadFromSqlite(values.db) : loadFromRecords(values.records)
  const labels = buildLabels(dataset)
  const redacted = stripSecrets(labels)
  const text = redacted.map((item) => JSON.stringify(item)).join('\n')
  if (values.out) writeFileSync(values.out, `${text}\n`)
  else console.log(text)

  const negatives = redacted.filter((item) => !item.accepted).length
  const equivalent = redacted.filter((item) => item.reason_code === 'unicode_equivalent').length
  console.error(`labels: ${redacted.length}（负例 ${negatives}，其中 unicode_equivalent ${equivalent}）；来源条目 ${dataset.pages.length}`)
  if (Number(values['show-values']) > 0) {
    console.error('warning: 下面的内容含真实单元格正文，不得提交进仓库、issue 或任何非私有渠道。')
    for (const item of labels.slice(0, Number(values['show-values']))) {
      console.log(JSON.stringify({ ...stripSecrets([item])[0], submitted_value: item._submitted_value, final_value: item._final_value }))
    }
  }
  return 0
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit(main())
