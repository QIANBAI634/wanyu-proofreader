import test from 'node:test'
import assert from 'node:assert/strict'
import {
  evidenceText,
  gateBadgeClass,
  gateLabel,
  previewChangeset,
  precisionText,
  readChangeset,
  summariseApply
} from '../src/lib/gateChangeset.js'

// #228 的变更集入口。这里要钉住的是"前端不复算判据"这条纪律：
// 本模块只做读取、原样提交、如实呈现，所以测试盯的是**哪些字段被带进请求体**、
// 以及**被拒的条目有没有露出来**，而不是任何档位该不该升。

const entry = (o = {}) => ({
  producer: 'rule',
  producer_version: 'identity-v2',
  kind: 'duplicate_identity',
  message_key: 'same_identity_across_sources',
  gate: 'warn',
  sample_n: 200,
  precision_hat: 0.72,
  approved_by: '维护者甲',
  approved_at: '2026-09-30',
  ...o
})

test('变更集读取只把 changeset 与 entries 带进请求体，脚本旁注不外溢', () => {
  const artifact = {
    changeset: 'cs-2026-09-30-a',
    producer: 'rule',
    producer_version: 'identity-v2',
    approved_by: '维护者甲',
    criteria: [{ gate: 'warn', theta: 0.6, nMin: 150 }],
    criteria_source: 'docs/plans/2026-09-25-assist-rule-thresholds.md §2',
    excluded: [{ rule: 'merged_columns/column_collapse', reason: 'n=0' }],
    entries: [entry()]
  }
  const read = readChangeset(JSON.stringify(artifact))
  assert.equal(read.ok, true, read.problem)
  assert.deepEqual(Object.keys(read.payload).sort(), ['changeset', 'entries'])
  assert.equal(read.payload.changeset, 'cs-2026-09-30-a')
  assert.equal(read.payload.entries.length, 1)
})

test('空内容、非法 JSON、非对象、数组都按问题返回而不是抛异常', () => {
  for (const bad of ['', '   ', '{oops', '[]', 'null', '"cs-1"']) {
    const read = readChangeset(bad)
    assert.equal(read.ok, false, `${JSON.stringify(bad)} 应被拒`)
    assert.ok(read.problem.length > 0)
  }
})

test('缺 entries 或缺变更集身份时报错说清缺什么', () => {
  assert.match(readChangeset(JSON.stringify({ changeset: 'cs-1' })).problem, /entries/)
  assert.match(readChangeset(JSON.stringify({ entries: [entry()] })).problem, /changeset/)
  assert.match(readChangeset(JSON.stringify({ changeset: 'cs-1', entries: [] })).problem, /entries/)
})

test('身份四元组不完整的条目在提交前就挡住', () => {
  const broken = entry()
  delete broken.message_key
  const read = readChangeset(JSON.stringify({ changeset: 'cs-1', entries: [entry(), broken] }))
  assert.equal(read.ok, false)
  assert.match(read.problem, /四元组/)
  assert.match(read.problem, /1 条/)
})

test('预览按档位计数并列出批准人，缺批准人时明说会被逐条拒', () => {
  const preview = previewChangeset('cs-1', [
    entry({ gate: 'warn' }),
    entry({ gate: 'off', message_key: 'same_identity_different_content' }),
    entry({ gate: 'warn', message_key: 'reading_format_invalid', approved_by: ' ' })
  ])
  assert.equal(preview.total, 3)
  assert.deepEqual(preview.by_gate, { warn: 2, off: 1 })
  assert.deepEqual(preview.approvers, ['维护者甲'])
})

test('n=0 的精度显示成 n/a，不显示成 0.0000', () => {
  // 门槛文件 §3：命中数为 0 是"暂无证据"，不是"精度为 0"。渲染成 0.0000 会把两种
  // 完全不同的结论说成同一种，而处置是不一样的。
  assert.equal(precisionText({ precision_hat: null, sample_n: 0 }), 'n/a')
  assert.equal(precisionText({ precision_hat: undefined, sample_n: 0 }), 'n/a')
  assert.equal(precisionText({ precision_hat: 0, sample_n: 500 }), '0.0000')
  assert.equal(precisionText({ precision_hat: 0.91234, sample_n: 500 }), '0.9123')
  assert.equal(evidenceText({ precision_hat: null, sample_n: 0 }), 'n=0 · p̂=n/a')
  assert.equal(evidenceText({}), 'n=0 · p̂=n/a', '整行缺字段也不能显示成 NaN')
})

test('应用结果里"什么都没改"必须显式可见', () => {
  const refused = summariseApply({
    changeset: 'cs-1', applied: 0, unchanged: 0, refused: 2, locked: 0,
    entries: [
      { kind: 'merged_columns', message_key: 'column_collapse', action: 'refused', reason: '样本量不足' },
      { kind: 'duplicate_identity', message_key: 'same_identity_across_sources', action: 'refused', reason: '缺批准人' }
    ]
  })
  assert.equal(refused.inert, true, 'applied=0 时不能看起来像成功放行')
  assert.equal(refused.refused.length, 2)
  assert.match(refused.counts, /被拒绝 2/)

  const withLocked = summariseApply({
    changeset: 'cs-2', applied: 1, unchanged: 0, refused: 0, locked: 1,
    entries: [
      { kind: 'page_outlier', message_key: 'row_length_outlier', action: 'applied' },
      { kind: 'punctuation_mix', message_key: 'fullwidth_punctuation', action: 'locked' }
    ]
  })
  assert.equal(withLocked.inert, false)
  assert.equal(withLocked.locked.length, 1)
})

test('未知档位与动作回显原值，不静默变空', () => {
  // 后端加档或加动作时，前端没跟上也必须看得见原始 token，而不是渲染成空白格。
  assert.equal(gateLabel('quiet'), 'quiet')
  assert.equal(gateLabel(undefined), '未登记')
  assert.equal(gateBadgeClass('quiet'), 'badge', '未知档位保持中性样式，但标签仍是原值')
  assert.equal(gateBadgeClass('off'), 'badge')
  assert.equal(gateBadgeClass('strong'), 'badge badge-approved')
  assert.equal(gateBadgeClass('warn'), 'badge badge-pending')
  const summary = summariseApply({ changeset: 'cs', applied: 1, entries: [{ action: 'merged' }] })
  assert.match(summary.counts, /已写入 1/)
})

// #254：门控表也要说得出"这条永远拿不到档位"，不能只有项目页会分。
test('通道标签三态齐全，未知值不许冒充"可打分"', async () => {
  const { CHANNEL_LABELS, channelLabel, channelBadgeClass } = await import('../src/lib/gateChangeset.js')
  assert.deepEqual(Object.keys(CHANNEL_LABELS).sort(), ['scored', 'unknown', 'unscored'])
  assert.equal(channelLabel('scored'), '可打分')
  assert.equal(channelLabel('unscored'), '无打分通道')
  assert.equal(channelLabel('nonsense'), '未登记通道')
  assert.equal(channelLabel(undefined), '未登记通道')
  assert.notEqual(channelBadgeClass('unscored'), channelBadgeClass('scored'), '两类共用一个样式就等于没区分')
})

test('门控表真的把通道列渲染出来', async () => {
  const { readFileSync } = await import('node:fs')
  const view = readFileSync(new URL('../src/views/admin/GateRulesView.vue', import.meta.url), 'utf8')
  assert.match(view, /<th>打分通道<\/th>/, '表头没有通道列')
  assert.match(view, /channelLabel\(item\.scoring_channel\)/, '通道值没被渲染')
})
