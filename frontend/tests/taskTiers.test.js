import assert from 'node:assert/strict'
import test from 'node:test'

import { tierBreakdown, TIER_KEYS, TIER_LABELS } from '../src/lib/taskTiers.js'

test('一个标签都没算过时整块不出现，而不是渲染三个 0', () => {
  const queue = { claimable: 40, tiers: { A: 0, B: 0, C: 0, other: 0, unlabeled: 40 } }
  assert.equal(tierBreakdown(queue), null, '无标签数据必须退回"和今天一样"的界面')
})

test('老服务端没有 tiers 字段时不报错也不显示', () => {
  assert.equal(tierBreakdown({ claimable: 5 }), null)
  assert.equal(tierBreakdown({ claimable: 5, tiers: 'A' }), null)
  assert.equal(tierBreakdown(null), null)
})

test('只有 unknown（算过但信号不足）同样不算可筛选项', () => {
  const queue = { claimable: 3, tiers: { A: 0, B: 0, C: 0, other: 3, unlabeled: 0 } }
  assert.equal(tierBreakdown(queue), null, '落 unknown 的条目不能撑起一个筛选器')
})

test('混合层级只列出有货的档，并保住未评估的数量', () => {
  const queue = { claimable: 10, tiers: { A: 4, B: 2, C: 0, other: 1, unlabeled: 3 } }
  const breakdown = tierBreakdown(queue)
  assert.deepEqual(breakdown.options.map((option) => option.key), ['A', 'B'])
  assert.deepEqual(breakdown.options.map((option) => option.count), [4, 2])
  assert.equal(breakdown.unknownCount, 1)
  assert.equal(breakdown.unlabeledCount, 3)
  assert.equal(breakdown.claimable, 10)
  // 概况要能对上账：可筛 + unknown + 未评估 == claimable，对不上就是接口与呈现脱节。
  const sum = breakdown.options.reduce((total, option) => total + option.count, 0)
    + breakdown.unknownCount + breakdown.unlabeledCount
  assert.equal(sum, breakdown.claimable)
})

test('三档标签齐全且顺序固定，负数与垃圾值按 0 处理', () => {
  assert.deepEqual(TIER_KEYS, ['A', 'B', 'C'])
  for (const key of TIER_KEYS) assert.ok(TIER_LABELS[key].startsWith(key))
  const breakdown = tierBreakdown({ claimable: 2, tiers: { A: 2, B: -5, C: 'x', other: null, unlabeled: undefined } })
  assert.deepEqual(breakdown.options.map((option) => option.key), ['A'])
  assert.equal(breakdown.unlabeledCount, 0)
})
