import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import {
  BUCKET_LABELS,
  bucketLabel,
  canSubmit,
  conclusionState,
  conclusionSummary
} from '../src/lib/blockedReason.js'

const settled = {
  blocked_reason: 'rights_gate',
  blocked_reason_by: 'u_123',
  blocked_reason_by_name: '小林',
  blocked_reason_at: '2026-10-03T07:20:41.000Z',
  blocked_reason_note: '授权邮件 2026-10-02'
}

test('「没人说过」与「看过但认不出」是两态，不许合成一句', () => {
  assert.equal(conclusionState({}), 'unset')
  assert.equal(conclusionState({ blocked_reason: '' }), 'unset')
  assert.equal(conclusionState({ blocked_reason: null }), 'unset')
  assert.equal(conclusionState({ blocked_reason: undefined }), 'unset')
  assert.equal(conclusionState({ blocked_reason: 'unknown' }), 'unrecognized')
  assert.equal(conclusionState({ blocked_reason: 'glyph_table' }), 'settled')
  // 两态的文案必须真的不同：如果都落进同一个分支，这一条就会假绿
  assert.notEqual(conclusionSummary({}), conclusionSummary({ blocked_reason: 'unknown' }))
  assert.match(conclusionSummary({}), /还没有人登记/)
  assert.doesNotMatch(conclusionSummary({}), /认不出/)
})

test('回读串里 who / when / basis 三件齐备，缺一件要显式说出来', () => {
  const line = conclusionSummary(settled)
  assert.match(line, /授权未决/)
  assert.match(line, /2026-10-03 07:20/, `时间没到分钟：${line}`)
  assert.match(line, /授权邮件 2026-10-02/)
  assert.match(line, /小林/)
  // 署名优先用名字，但名字拿不到时不许把 who 整段丢掉
  assert.match(conclusionSummary({ ...settled, blocked_reason_by_name: '' }), /u_123/)
  assert.match(conclusionSummary({ ...settled, blocked_reason_by: '', blocked_reason_by_name: '' }), /（无记录）/)
  assert.match(conclusionSummary({ ...settled, blocked_reason_note: '' }), /（无依据）/)
  assert.match(conclusionSummary({ ...settled, blocked_reason_at: '' }), /（无时间）/)
})

test('没见过的桶要原样显示，不能被标签表吞成空', () => {
  assert.equal(bucketLabel(''), '（无人登记）')
  assert.equal(bucketLabel('some_new_bucket'), 'some_new_bucket')
  assert.match(conclusionSummary({ ...settled, blocked_reason: 'some_new_bucket' }), /some_new_bucket/)
})

test('提交门禁：reason 与 basis 都要有非空白内容', () => {
  assert.equal(canSubmit({ reason: 'rights_gate', basis: '邮件' }), true)
  assert.equal(canSubmit({ reason: 'unknown', basis: '看过，认不出' }), true)
  assert.equal(canSubmit({ reason: '', basis: '邮件' }), false)
  assert.equal(canSubmit({ reason: 'rights_gate', basis: '' }), false)
  assert.equal(canSubmit({ reason: 'rights_gate', basis: '   ' }), false)
  assert.equal(canSubmit({}), false)
})

// 值域的权威在后端。这份标签表是抄本，所以抄本必须能被证明没有漂：
// 少一个键会让管理员选不到那个结论，多一个键则会 400 在提交那一步。
test('BUCKET_LABELS 的键集与后端 BLOCKED_BUCKETS 完全一致', () => {
  const source = readFileSync(new URL('../../backend/pb_hooks/lib/assist_difficulty.js', import.meta.url), 'utf8')
  const match = source.match(/const BLOCKED_BUCKETS = \[([^\]]*)\]/)
  assert.ok(match, '后端 BLOCKED_BUCKETS 定义没找到：这条防漂测试已经失效')
  const backend = match[1].split(',').map((entry) => entry.trim().replace(/^"|"$/g, '')).filter(Boolean)
  assert.deepEqual([...backend].sort(), Object.keys(BUCKET_LABELS).sort())
})

const viewSource = () => readFileSync(new URL('../src/views/admin/ProjectDetailView.vue', import.meta.url), 'utf8')

test('管理端区块只对平台管理员渲染，且撤销只在已有结论时可用', () => {
  const source = viewSource()
  assert.match(source, /v-if="auth\.isPlatformAdmin"[\s\S]{0,200}blocked-conclusion/, '区块没有挂在 isPlatformAdmin 门禁下')
  for (const used of ['getBlockedReason', 'setBlockedReason', 'clearBlockedReason', 'conclusionSummary', 'canSubmitBlocked']) {
    assert.ok(source.includes(used), `视图没有用到 ${used}：接口或纯逻辑成了死代码`)
  }
  // 「登记后层级」那行必须来自接口返回，而不是前端自己估
  assert.match(source, /difficulty_tier[\s\S]{0,120}blockedTier\.value/, '写值之后没有回显层级')
  assert.match(source, /:disabled="blockedBusy \|\| blockedState === 'unset'"/, '没有结论时撤销按钮仍然可点')
})
