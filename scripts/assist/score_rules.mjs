#!/usr/bin/env node
// #179 规则打分器：输入弱标注集 + 一批规则，输出每条规则的命中数/precision/recall/
// 按 field 与 project 分组的误报分布，一条命令可复现。
//
//   node scripts/assist/score_rules.mjs --db backend/pb_data/data.db --json /tmp/score.json
//   node scripts/assist/score_rules.mjs --records export.json --report docs/testing/assist-baseline-<date>.md
//   --date 固定标题里的生成日期（只改措辞模板、数字未变时用；默认取当天）
//
// 全程只读；报告只含计数与比率，不含单元格正文。
import { parseArgs } from 'node:util'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { loadFromSqlite, loadFromRecords } from './weak_labels.mjs'
import { buildLabels, scoreRules, renderReport, stripSecrets } from './lib/labeling.mjs'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const here = path.dirname(fileURLToPath(import.meta.url))
const rules = require('../../backend/pb_hooks/lib/assist_rules.js')
const coverage = require('../../backend/pb_hooks/lib/rule_coverage.js')

// 参与打分的规则 = 规则身份 + 判据上下文。#177 新增规则时这里要跟上，
// 否则那条规则永远不会出现在基线报告里（这是最容易漏的一步）。
//
// 但"漏了"从今天起不再只能靠人记住：清单必须与 backend/pb_hooks/lib/rule_coverage.js
// 的 SCORED **双向相等**（#254）。只判包含会放过"登记了通道却忘了写打分"那一侧，
// 而它的症状恰好就是这条 issue 报的那个——某族疑点在产，报告里两栏都不出现。
export function defaultRuleSet({ keyboards = [], roles = null }) {
  const context = rules.makeContext({ keyboards, roles })
  const list = [
    { name: 'R1 char_out_of_repertoire', kind: 'char_out_of_repertoire', message_key: 'non_ipa_range_codepoints', scope: 'all', context },
    { name: 'R2 confusable_substitution', kind: 'confusable_substitution', message_key: 'confusable_ascii_in_reading', scope: 'ipa', context },
    { name: 'R3 combining_marks', kind: 'encoding_form_anomaly', message_key: 'combining_marks_present', scope: 'ipa', context },
    { name: 'R6 long_digit_run', kind: 'reading_format_invalid', message_key: 'long_digit_run', scope: 'reading', context },
    { name: 'R6 tone_token_count_differs', kind: 'reading_format_invalid', message_key: 'tone_token_count_differs', scope: 'reading', context }
  ]
  // 未覆盖（本报告以 n/a 呈现，不算 0 精度）：R3 列级 mixed_normalization_forms、
  // R4 punctuation_mix、R7 两个判据，以及跨行身份那一族。它们要看到整列/整批/相邻两条
  // 才成立，而弱标注是按 (提交, 字段) 对齐的粒度——点名与理由在 rule_coverage.js 的
  // UNSCORED 里，由变更集报告渲染，不在这里重复一遍。
  if (roles && Object.keys(roles).length) {
    list.push({ name: 'R5 missing_field', kind: 'missing_field', message_key: 'required_role_field_empty', scope: 'role_required', context })
  }
  const producerVersion = rules.RULES_VERSION
  coverage.assertCovered(
    list.map((item) => ({ producer_version: producerVersion, kind: item.kind, message_key: item.message_key })),
    '打分清单'
  )
  const expected = coverage.SCORED
    .filter((item) => !item.requires_roles || (roles && Object.keys(roles).length))
    .filter((item) => !list.some((entry) => entry.kind === item.kind && entry.message_key === item.message_key))
  if (expected.length) {
    throw new Error(`打分清单漏了 ${expected.length} 条已登记为可打分的判据：` +
      expected.map((item) => `${item.rule}(${item.message_key})`).join('、'))
  }
  return list
}

function main() {
  const { values } = parseArgs({ options: {
    db: { type: 'string' }, records: { type: 'string' }, keyboard: { type: 'string' },
    roles: { type: 'string' }, json: { type: 'string' }, report: { type: 'string' },
    'real-report': { type: 'string' }, date: { type: 'string' }, help: { type: 'boolean', default: false }
  } })
  if (values.help || (!values.db && !values.records)) {
    console.error('用法: score_rules.mjs (--db <sqlite> | --records <json>) [--keyboard <json>] [--roles <json>] [--json out] [--report out] [--date YYYY-MM-DD]')
    return 2
  }
  if (values.date && !/^\d{4}-\d{2}-\d{2}$/.test(values.date)) {
    console.error('--date 必须是 YYYY-MM-DD')
    return 2
  }
  const dataset = values.db ? loadFromSqlite(values.db) : loadFromRecords(values.records)
  const keyboardPath = values.keyboard || path.join(here, '..', '..', 'backend', 'keyboards', 'hinghwa-dialect.json')
  const keyboards = [{ definition: JSON.parse(readFileSync(keyboardPath, 'utf8')) }]
  // 列角色决定 R5 的判定作用域。三种来源必须分开说，因为它们的处置动作不同：
  // --roles 显式给的 > 库内读的 > 没有；库内多项目不一致时**不猜**，
  // 直接降到"R5 不参与打分"并把原因写进报告头（静默少评一条规则是这类工具最常见的假绿）。
  const dbRoles = dataset.roles && Object.keys(dataset.roles).length ? dataset.roles : null
  const rolesConflict = Boolean(dataset.rolesConflict) && !values.roles
  const roles = values.roles ? JSON.parse(readFileSync(values.roles, 'utf8')) : dbRoles
  const rolesNote = values.roles ? '已提供（--roles 指定）'
    : rolesConflict ? '不一致（本库含多个项目且列角色不同，R5 不参与打分；请按项目分别打分或用 --roles 指定）'
      : roles ? (values.db ? '已提供（读自库内 projects.column_roles_json）' : '已提供（导出文件自带 roles）')
        : '未提供（这份数据里没有任何列角色登记，R5 不参与打分）'
  const labels = buildLabels(dataset)
  const result = scoreRules(labels, defaultRuleSet({ keyboards, roles }))
  // scope_roles 不是装饰：gate_changeset.mjs 要据此判断"本轮作用域里应当出现哪些可打分判据"。
  // 没有它，R5 缺席到底是漏了还是没给列角色，读产物的人分不出来（#254 验收第 1 条）。
  const synthetic = {
    ...result,
    labels: stripSecrets(labels),
    scope_roles: Boolean(roles && Object.keys(roles).length)
  }

  const real = values['real-report'] ? JSON.parse(readFileSync(values['real-report'], 'utf8')) : null
  const report = renderReport(synthetic, {
    synthetic,
    real: real && real.scored ? real : null,
    // --date 让「刷新报告措辞」不顺手改掉标题日期：数字没变时标题也不该变，否则只能手改
    // 生成物那一行，而手改的部分下一次重跑就被覆盖。
    generatedAt: values.date || new Date().toISOString().slice(0, 10),
    sourceNote: `样本来自 ${values.db ? path.basename(values.db) : path.basename(values.records)}：`
      + `条目 ${dataset.pages.length}、提交 ${dataset.attempts.length}、字段级样本 ${labels.length}。`
      + ` 键盘口径 = ${path.basename(keyboardPath)}；列角色 = ${rolesNote}。`
  })
  if (values.json) writeFileSync(values.json, JSON.stringify(synthetic, null, 2))
  if (values.report) writeFileSync(values.report, report)
  else console.log(report)
  for (const item of synthetic.scored) {
    console.error(`${item.rule}: n=${item.hits} tp=${item.tp} fp=${item.fp} fn=${item.fn} precision=${item.precision ?? 'n/a'} recall=${item.recall ?? 'n/a'} → ${item.gate.gate}`)
  }
  return 0
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit(main())
