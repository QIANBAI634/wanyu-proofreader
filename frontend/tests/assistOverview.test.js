import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import {
  EMPTY_MESSAGES,
  gatedOffNotice,
  gatedOffSplit,
  emptyReason,
  findingLocator,
  findingSpanText,
  kindBreakdown,
  recomputeNotice,
  severityCount,
  truncatedNotice
} from '../src/lib/assistOverview.js'

test('空列表的四种成因互斥且各有说法', () => {
  const item = { kind: 'missing_field', severity: 'strong' }
  assert.equal(emptyReason({ items: [item], runs: { rules: true }, pagesScanned: 3 }), 'has-findings')
  assert.equal(emptyReason({ items: [], runs: {}, pagesScanned: 3 }), 'never-run')
  assert.equal(emptyReason({ items: [], runs: { rules: true }, pagesScanned: 0 }), 'no-entries')
  assert.equal(emptyReason({ items: [], runs: { rules: true }, pagesScanned: 5 }), 'clean')
  // 只跑跨行身份：不得说成"没有疑点"（#235 二轮评审阻断项）
  assert.equal(emptyReason({ items: [], runs: { identity: true }, pagesScanned: 5 }), 'identity-only')
  assert.equal(emptyReason({ items: [], runs: { rules: true, identity: true }, pagesScanned: 5 }), 'clean')
  assert.match(EMPTY_MESSAGES['identity-only'], /不表示资料干净/)
  assert.equal(EMPTY_MESSAGES['identity-only'].includes('没有疑点'), false,
    '只跑跨行身份的文案不许出现"没有疑点"这种全量结论')
  // never-run 的文案必须点明"这不表示资料干净"，否则空列表就会被读成后者。
  assert.match(EMPTY_MESSAGES['never-run'], /不表示资料干净/)
  assert.equal(EMPTY_MESSAGES.clean, '跑过了，当前批次没有疑点。')
  assert.notEqual(EMPTY_MESSAGES['never-run'], EMPTY_MESSAGES.clean, '两种空态不许共用一句话')
})

test('缺字段与缺参数时不许崩，也不许编数', () => {
  assert.deepEqual(kindBreakdown(undefined), [])
  assert.deepEqual(gatedOffSplit(null), { waiting: 0, noChannel: 0, unknown: 0, total: 0 })
  assert.equal(gatedOffNotice(gatedOffSplit(null)), '')
  assert.equal(severityCount([null, {}, { severity: 'warn' }], 'warn'), 1)
  assert.equal(emptyReason({}), 'never-run')
  assert.equal(recomputeNotice(null), '')
  assert.equal(recomputeNotice({}), '')
  assert.equal(recomputeNotice({ pages: 2 }).includes('NaN'), false)
})

test('重算摘要里缺哪个字段就少说哪句，不猜', () => {
  const text = recomputeNotice({ pages: 500, findings: 12, duration_ms: 1958, unanchored: 2 })
  assert.match(text, /扫了 500 条/)
  assert.match(text, /产出 12 条疑点/)
  assert.match(text, /用时 1958 ms/)
  assert.match(text, /有 2 条找不到挂靠条目/)
  assert.equal(text.includes('下线旧批次'), false, '摘要里没有 superseded 就不该说它')
})

test('跨行重算的两个可见缺口都必须被说出来', () => {
  const stale = recomputeNotice({ pages: 3, findings: 2, difficulty_stale: true }, { identity: true })
  assert.match(stale, /再点一次「按项目重算疑点」/, `tier 过期不说出去，管理员就会拿旧分层去筛任务：${stale}`)
  const unattributed = recomputeNotice({ pages: 3, findings: 2, unattributed_groups: 4 }, { identity: true })
  assert.match(unattributed, /4 组有分歧但登记来源不足以判成跨来源冲突/)
  const plain = recomputeNotice({ pages: 3, findings: 2 }, {})
  assert.equal(plain.includes('登记来源'), false, '普通疑点重算不该报跨行专属的字段')
})

test('截断信号有出口：门控表截断与列表分页是两件事', () => {
  assert.match(truncatedNotice({ gate_rows_truncated: true }), /按 off 处理/)
  assert.match(truncatedNotice({ hasMore: true }), /下一页/)
  assert.equal(truncatedNotice({ gate_rows_truncated: false, hasMore: false }), '')
  assert.equal(truncatedNotice(null), '')
})

test('按 kind 汇总的顺序稳定且标签来自同一个词表', () => {
  const rows = kindBreakdown([
    { kind: 'merged_columns' }, { kind: 'merged_columns' },
    { kind: 'missing_field' }, { kind: 'page_outlier' }
  ])
  assert.deepEqual(rows.map((r) => r.kind), ['merged_columns', 'missing_field', 'page_outlier'])
  assert.deepEqual(rows.map((r) => r.count), [2, 1, 1])
  // 同数量按 kind 名排序，保证两次渲染逐字一致
  const tied = kindBreakdown([{ kind: 'page_outlier' }, { kind: 'missing_field' }])
  assert.deepEqual(tied.map((r) => r.kind), ['missing_field', 'page_outlier'])
  assert.equal(rows[0].label, '疑似列合并')
  assert.equal(kindBreakdown([{ kind: 'brand_new_kind' }])[0].label, 'brand_new_kind',
    '未知 kind 要原样回显而不是编一个中文标签')
})

// #254：两种 off 不许共用一句"尚未放行"。有通道、等证据 与 永远拿不到档位
// 是两种完全不同的排产动作，混说会让 manager 去等一个不会发生的放行。
test('off 档按打分通道分三类计数，只数 gate 明确为 off 的条目', () => {
  const split = gatedOffSplit([
    { gate: 'off', scoring_channel: 'scored' },
    { gate: 'off', scoring_channel: 'scored' },
    { gate: 'off', scoring_channel: 'unscored' },
    { gate: 'off' },
    { gate: 'warn', scoring_channel: 'unscored' },
    { gate: 'strong', scoring_channel: 'scored' },
    {}
  ])
  assert.deepEqual(split, { waiting: 2, noChannel: 1, unknown: 1, total: 4 })
})

test('未登记通道的身份单独说，不并进"等证据"也不并进"无通道"', () => {
  const text = gatedOffNotice(gatedOffSplit([{ gate: 'off' }]))
  assert.match(text, /未登记在通道表里/)
  assert.equal(/证据未达档/.test(text), false, '未知身份被说成等证据')
  assert.equal(/没有弱标注打分通道/.test(text), false, '未知身份被说成永远拿不到')
})

test('两类措辞各自成句，且都不出现"尚未放行"这种等得起的说法', () => {
  const waiting = gatedOffNotice({ waiting: 3, noChannel: 0, unknown: 0, total: 3 })
  const noChannel = gatedOffNotice({ waiting: 0, noChannel: 5, unknown: 0, total: 5 })
  assert.match(waiting, /3 条.*证据未达档/)
  assert.match(noChannel, /5 条.*拿不到档位/)
  for (const text of [waiting, noChannel]) {
    assert.equal(/尚未放行/.test(text), false, `两类共用了一句：${text}`)
    assert.ok(text.includes(String(text === waiting ? 3 : 5)))
  }
})

// #235 评审阻断项：`truncatedNotice` 曾经"测试钉着、UI 零消费"，
// ProjectDetailView 自己手写了一句告警，把三个不相干的口径混在一起。
// 下面几条把"helper 真的被消费"与"两个截断信号互不覆写"钉在源码上，
// 因为这个仓库没有组件渲染测试，不这么钉就等于没测。
const readSource = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8')

test('管理端告警必须走 truncatedNotice，而不是手写另一句', () => {
  const view = readSource('../src/views/admin/ProjectDetailView.vue')
  assert.match(view, /truncatedNotice/, 'truncatedNotice 没被 import 或没被调用')
  assert.match(view, /assistFindingsNotice\.value = truncatedNotice\(/,
    'findings 侧的告警文案应由 helper 生成，而不是在 UI 里拼字符串')
  assert.equal(view.includes('assistTruncated'), false,
    '共享的 assistTruncated 已废弃：它让读疑点顺手冲掉人工结论的截断告警')
})

test('疑点截断与人工结论截断是两个独立信号', () => {
  const view = readSource('../src/views/admin/ProjectDetailView.vue')
  assert.match(view, /const assistFindingsNotice = ref\(''\)/)
  assert.match(view, /const assistDismissalsTruncated = ref\(false\)/)
  assert.match(view, /v-if="assistFindingsNotice"/, 'findings 侧要有自己的展示位')
  assert.match(view, /v-if="assistDismissalsTruncated"/, '人工结论侧要有自己的展示位')

  // 关键回归：读 findings 不许碰人工结论那个 ref。
  const body = view.match(/async function loadAssistFindings\(\) \{[\s\S]*?\n\}/)?.[0] ?? ''
  assert.ok(body.length > 0, '没找到 loadAssistFindings，断言会恒真')
  assert.equal(body.includes('assistDismissalsTruncated'), false,
    `读疑点却在写人工结论的截断位：${body}`)

  // 人工结论那句必须说清"更早的仍在生效、只是不在列表"，而不是含糊的分页提示。
  assert.match(view, /更早的结论仍会在重算时整组生效/,
    '截断文案必须点明"没列出"不等于"没有"')
})

test('truncatedNotice 只说后端明说的事', () => {
  assert.equal(truncatedNotice({ gate_rows_truncated: true, hasMore: false }),
    '门控登记表读取被截断，超出部分的规则一律按 off 处理')
  assert.equal(truncatedNotice({ hasMore: true }), '疑点列表还有下一页')
  assert.equal(truncatedNotice({}), '', '两个信号都没有时不许凭空造告警')
})

test('疑点行说清挂靠哪一条，整批判据不许说成"这一条有问题"', () => {
  assert.deepEqual(findingLocator({ page_number: 41, pdf_page: 7, evidence: { anchor: 'entry' } }),
    { entryText: '第 41 条', pdfText: 'PDF 第 7 页', jumpable: true, pdfPage: 7 })
  // 列级/页级判据挑第一个条目当锚点，措辞必须带上判定范围
  assert.equal(findingLocator({ page_number: 41, pdf_page: 7, evidence: { anchor: 'column_first_entry' } }).entryText,
    '整列判定，挂靠第 41 条')
  assert.equal(findingLocator({ page_number: 41, evidence: { anchor: 'pdf_page_first_entry' } }).entryText,
    '整页判定，挂靠第 41 条')
  assert.equal(findingLocator({ page_number: 41, evidence: {} }).entryText, '第 41 条',
    '没有 anchor 时按最直白的说法，不硬加"挂靠"前缀')
})

test('缺定位信息时如实降级，不许留白或假称可以跳转', () => {
  // 条目号取不到 = 说"未知"，不能渲染成"第  条"或干脆不渲染
  assert.equal(findingLocator({ page_number: null, pdf_page: 3 }).entryText, '条目号未知')
  assert.equal(findingLocator({ page_number: null, evidence: { anchor: 'column_first_entry' } }).entryText,
    '整列判定，挂靠条目号未知')
  assert.equal('entry_missing' in findingLocator({ page_number: 9, pdf_page: 9 }), false,
    'entry_missing 是死分支（page 是 cascadeDelete 的 relation，悬挂引用进不了库）')
  assert.deepEqual(findingLocator({ page_number: 0, pdf_page: 0 }),
    { entryText: '条目号未知', pdfText: '无 PDF 页号（CSV 直接导入的条目）', jumpable: false, pdfPage: null })
  assert.equal(findingLocator(undefined).entryText, '条目号未知', '整行缺失也不许崩')
})

test('命中区间只在有区间时说区间，否则点明判据看不到单格', () => {
  assert.equal(findingSpanText({ evidence: { char_offsets: [[2, 7], [11, 13]] } }),
    '命中第 3–7 字、第 12–13 字')
  // 正本实测里绝大多数区间就是单字符（一个全角标点），不要渲染成"第 1–1 字"
  assert.equal(findingSpanText({ evidence: { char_offsets: [[0, 1], [1, 2], [2, 3], [3, 4]] } }),
    '命中第 1 字、第 2 字、第 3 字 等 4 处')
  assert.equal(findingSpanText({ evidence: { anchor: 'entry' } }), '未给出命中位置')
  assert.equal(findingSpanText({ evidence: { anchor: 'column_first_entry' } }),
    '该类判据按整批数据判定，指不到具体字')
  // 形状不符（区间倒置、长度不是 2）退化成"未给出"，而不是渲染出 NaN 或第 -2 字
  assert.equal(findingSpanText({ evidence: { char_offsets: [[5, 5], [1], ['a', 'b']] } }),
    '未给出命中位置')
  assert.equal(findingSpanText(undefined), '该类判据按整批数据判定，指不到具体字')
})

test('视图真的消费这两个 helper，跳转用精确页号而不是子串搜索', () => {
  const view = readSource('../src/views/admin/ProjectDetailView.vue')
  const rowsBody = view.match(/const assistViewRows = computed\([\s\S]*?\n\}\)\)\)/)?.[0] ?? ''
  assert.ok(rowsBody.length > 0, '没找到 assistViewRows，断言会恒真')
  assert.match(rowsBody, /findingLocator\(/)
  assert.match(rowsBody, /findingSpanText\(/)
  assert.match(view, /v-for="view in assistViewRows"/, '模板还在直接渲染原始行，定位串不会显示')

  const jumpBody = view.match(/async function jumpToEntryPage\(view\) \{[\s\S]*?\n\}/)?.[0] ?? ''
  assert.ok(jumpBody.length > 0, '没找到 jumpToEntryPage，断言会恒真')
  assert.match(jumpBody, /minPdfPage\.value = String\(page\)/)
  assert.match(jumpBody, /maxPdfPage\.value = String\(page\)/)
  // q 是对正文的子串匹配，用它跳某一条会连带命中别条 ⇒ 这条路径不许出现
  assert.equal(jumpBody.includes('searchQuery'), false, `跳转改用了子串搜索：${jumpBody}`)
})

test('两类重算的覆盖范围分开记录，跨行重算不算全量', () => {
  const view = readSource('../src/views/admin/ProjectDetailView.vue')
  const identityBody = view.match(/async function runIdentityRecompute\(\) \{[\s\S]*?\n\}/)?.[0] ?? ''
  assert.ok(identityBody.length > 0, '没找到 runIdentityRecompute，断言会恒真')
  assert.match(identityBody, /identity: true/)
  assert.equal(identityBody.includes('rules: true'), false,
    `只跑跨行重算却标了全量覆盖：${identityBody}`)
  const rulesBody = view.match(/async function runFindingsRecompute\(\) \{[\s\S]*?\n\}/)?.[0] ?? ''
  assert.match(rulesBody, /rules: true/)
  assert.equal(view.includes('assistEverRun'), false, '共享的 assistEverRun 已废弃')
})
