#!/usr/bin/env node
// #228 从打分报告产出「gate 变更集」——一份**待人批准**的产物，不是部署动作。
//
//   node scripts/assist/score_rules.mjs --db ... --json /tmp/score.json
//   node scripts/assist/gate_changeset.mjs --score /tmp/score.json \
//        --approved-by "维护者邮箱/昵称" --out docs/plans/gate-changeset-2026-09-30.json
//
// 本命令**不写库**。放行必须经人批准（门槛文档 §7 与 #181 决策门都禁止自动生效）：
// 变更集落成文件或 PR diff，人评审后再用 POST /api/fangji/gates/changeset 应用。
// 判据（n_min / θ）不在这里重复实现——它来自 backend/pb_hooks/lib/gate_release.js，
// 应用侧还会再核一遍，所以这里给出的建议与那边的拒绝理由不会漂。
import { parseArgs } from 'node:util'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const gateRelease = require('../../backend/pb_hooks/lib/gate_release.js')
const rules = require('../../backend/pb_hooks/lib/assist_rules.js')
const coverage = require('../../backend/pb_hooks/lib/rule_coverage.js')

// 弱标注粒度度量不到的判据必须点名，不能沉默成「没进变更集」。
// 这份清单**不在这里维护**：它与"哪些判据能打分"是同一张表的正反面，
// 定义在 backend/pb_hooks/lib/rule_coverage.js，与管理端措辞共用（#254）。
// 口径与 scripts/assist/README.md §4、labeling.mjs 的 defaultRuleSet 注释一致。

export function buildChangeset(scoreResult, { approvedBy, approvedAt, producerVersion, changesetId }) {
  const scored = Array.isArray(scoreResult?.scored) ? scoreResult.scored : []
  const entries = []
  const excluded = []
  for (const item of scored) {
    const suggested = item.gate?.gate ?? 'off'
    if (!gateRelease.GATE_TIERS.includes(suggested)) {
      throw new Error(`打分结果里出现未知档位 ${suggested}（规则 ${item.rule}）`)
    }
    if (suggested === 'off') {
      excluded.push({
        rule: item.rule, kind: item.kind, message_key: item.message_key,
        // 三栏的完整性检查按通道身份比对，少了这一项，"保持 off"那一栏
        // 的每一条都会被算成"没出现在任何一栏里"，正常一轮打分也会炸。
        producer_version: producerVersion,
        gate: 'off', reason: `${item.gate.basis}${item.gate.note ? `；${item.gate.note}` : ''}`
      })
      continue
    }
    entries.push({
      producer: 'rule',
      producer_version: producerVersion,
      kind: item.kind,
      message_key: item.message_key,
      gate: suggested,
      sample_n: item.hits,
      precision_hat: item.precision,
      // 判据依据要写进产物本身：评审变更集的人不必再去翻门槛文档才知道这条为什么能放行。
      basis: `门槛文档 §2/§5：${item.gate.basis}`,
      wilson_lower: item.wilson?.lower ?? null,
      wilson_upper: item.wilson?.upper ?? null,
      approved_by: approvedBy,
      approved_at: approvedAt
    })
  }
  // 「无通道」不进 excluded：那一栏的语义是"有通道、这轮证据不够"，混在一起
  // 就等于把"永远不会有档位"写成"再等等"——正是 #254 报的那句误导。
  const noChannel = coverage.UNSCORED.map((item) => ({
    producer_version: item.producer_version,
    kind: item.kind,
    message_key: item.message_key,
    rule: item.rule,
    reason: item.reason
  }))
  // 三栏之和必须等于表上登记的全部可打分身份：漏在哪一栏，哪一栏就沉默。
  // 期望集合按本轮作用域算——没给列角色时 R5 本就不该出现，
  // 而"这一轮到底给没给角色"只有打分侧知道，所以它必须如实标在产物里。
  const rolesInScope = scoreResult?.scope_roles
  if (typeof rolesInScope !== 'boolean') {
    throw new Error('打分产物缺少 scope_roles：请用当前版本的 score_rules.mjs 重新产出 --json。' +
      '缺了它就无法判断"某条可打分判据没出现在报告里"是漏了，还是本来不在本轮作用域内。')
  }
  const listed = new Set([
    ...entries.map(coverage.keyOf),
    ...excluded.map(coverage.keyOf),
    ...noChannel.map(coverage.keyOf)
  ])
  const silent = coverage.SCORED
    .filter((item) => !item.requires_roles || rolesInScope)
    .filter((item) => !listed.has(coverage.keyOf(item)))
    .map((item) => `${item.rule}(${item.message_key})`)
  if (silent.length) {
    throw new Error(`打分报告漏了 ${silent.length} 条在作用域内的可打分判据，` +
      `它们既不在建议放行也不在保持 off：${silent.join('、')}`)
  }
  return {
    changeset: changesetId,
    producer: 'rule',
    producer_version: producerVersion,
    approved_by: approvedBy,
    approved_at: approvedAt,
    criteria: gateRelease.GATE_CRITERIA,
    criteria_source: 'docs/plans/2026-09-25-assist-rule-thresholds.md §2/§5（代码侧唯一出处 backend/pb_hooks/lib/gate_release.js）',
    // 报告的「能否外推」纪律同样适用于变更集：合成样本产出的档位不能当作线上精度承诺。
    extrapolation: scoreResult?.synthetic ? '本变更集的数字来自合成弱标注样本，只用于打通放行通道与验证判据行为，不构成线上准确率结论。' : '本变更集的数字来自库内真实样本。',
    coverage_source: 'backend/pb_hooks/lib/rule_coverage.js（可打分 / 无打分通道两类的唯一定义）',
    entries,
    excluded,
    no_channel: noChannel
  }
}

function renderMarkdown(changeset) {
  const lines = []
  lines.push(`# Gate 变更集 ${changeset.changeset}`)
  lines.push('')
  lines.push(`- 生产者：${changeset.producer} / ${changeset.producer_version}`)
  lines.push(`- 批准人：${changeset.approved_by}　批准时间：${changeset.approved_at}`)
  lines.push(`- 判据：${changeset.criteria.map((c) => `${c.gate} 需 p̂≥${c.theta} 且 n≥${c.nMin}`).join('；')}`)
  lines.push(`- 出处：${changeset.criteria_source}`)
  lines.push(`- 外推性：${changeset.extrapolation}`)
  lines.push('')
  lines.push('## 建议放行')
  lines.push('')
  if (!changeset.entries.length) lines.push('（无）')
  else {
    lines.push('| kind | message_key | gate | n | p̂ | Wilson 95% | 依据 |')
    lines.push('| --- | --- | --- | --- | --- | --- | --- |')
    for (const e of changeset.entries) {
      const wilson = e.wilson_lower === null ? 'n/a' : `[${e.wilson_lower}, ${e.wilson_upper}]`
      lines.push(`| ${e.kind} | ${e.message_key} | ${e.gate} | ${e.sample_n} | ${e.precision_hat ?? 'n/a'} | ${wilson} | ${e.basis} |`)
    }
  }
  lines.push('')
  lines.push('## 保持 off（必须逐条给理由，沉默会被读成「没问题」）')
  lines.push('')
  lines.push('| 规则 | 理由 |')
  lines.push('| --- | --- |')
  for (const e of changeset.excluded) lines.push(`| ${e.rule} | ${e.reason} |`)
  lines.push('')
  lines.push('## 无打分通道（点名：不是"再等等"，是现有通道永远不会有档位）')
  lines.push('')
  lines.push('> 这些身份在库里照样产出、照样计入管理端"校对员看不到"的条数，但弱标注的')
  lines.push('> `(提交, 字段)` 粒度量不到它们的精度，所以既进不了上面的表，也不该被写成"尚未放行"。')
  lines.push('> 出处：' + changeset.coverage_source)
  lines.push('')
  lines.push('| 规则 | kind / message_key | 为什么量不到 |')
  lines.push('| --- | --- | --- |')
  for (const e of changeset.no_channel) {
    lines.push(`| ${e.rule} | ${e.kind} / ${e.message_key} | ${e.reason} |`)
  }
  lines.push('')
  lines.push('> 本文件是待评审产物。应用它需要平台管理员调用 `POST /api/fangji/gates/changeset`；')
  lines.push('> 应用侧会用同一份判据复核，判据不满足的条目逐条拒绝。')
  return `${lines.join('\n')}\n`
}

function main() {
  const { values } = parseArgs({ options: {
    score: { type: 'string' }, 'approved-by': { type: 'string' }, out: { type: 'string' },
    report: { type: 'string' }, changeset: { type: 'string' }, date: { type: 'string' }, help: { type: 'boolean', default: false }
  } })
  if (values.help || !values.score || !values['approved-by']) {
    console.error('用法: gate_changeset.mjs --score <score.json> --approved-by <批准人> [--out <json>] [--report <md>] [--changeset <id>] [--date YYYY-MM-DD]')
    return 2
  }
  const approvedAt = values.date ? `${values.date}T00:00:00.000Z` : new Date().toISOString()
  if (values.date && !/^\d{4}-\d{2}-\d{2}$/.test(values.date)) {
    console.error('--date 必须是 YYYY-MM-DD')
    return 2
  }
  const score = JSON.parse(readFileSync(values.score, 'utf8'))
  // score_rules.mjs 用 --json 写出的对象带 synthetic 标记；--records 的真实报告没有。
  const changeset = buildChangeset(score, {
    approvedBy: values['approved-by'],
    approvedAt,
    producerVersion: score.producer_version || rules.RULES_VERSION,
    changesetId: values.changeset || `cs-${approvedAt.slice(0, 10)}-${(score.scored?.length ?? 0)}`
  })
  const json = `${JSON.stringify(changeset, null, 2)}\n`
  if (values.out) writeFileSync(values.out, json)
  else process.stdout.write(json)
  if (values.report) writeFileSync(values.report, renderMarkdown(changeset))
  console.error(`变更集 ${changeset.changeset}: 建议放行 ${changeset.entries.length} 条，保持 off ${changeset.excluded.length} 条，` +
    `无打分通道 ${changeset.no_channel.length} 条（点名，不进变更集）。本命令不写库。`)
  return 0
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit(main())
