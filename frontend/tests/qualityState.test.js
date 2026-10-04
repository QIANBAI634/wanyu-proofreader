import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { QUALITY_STATE, QUALITY_STATE_LABELS, QUALITY_STATES } from '../src/constants/qualityState.js'
import {
  normalizeQualityState,
  qualityStateBadgeClass,
  qualityStateLabel,
  qualityStateNeedsBasis,
  qualityStateSummaryRows
} from '../src/lib/qualityState.js'

// 行尾一律归一：Windows 检出是 CRLF，锚定 \n 的表达式会在这里直接失效。
const read = (relative) => readFileSync(new URL(relative, import.meta.url), 'utf8').replace(/\r\n/g, '\n')

const migration = read('../../backend/pb_migrations/1789200400_page_quality_state.js')
const style = read('../src/style.css')

test('frontend states mirror the migration STATES literal', () => {
  const marker = 'const STATES = ['
  const start = migration.indexOf(marker)
  assert.notEqual(start, -1, 'migration must declare STATES')
  const list = migration.slice(start + marker.length, migration.indexOf(']', start))
  const inMigration = [...list.matchAll(/"([^"]+)"/g)].map((match) => match[1])
  assert.deepEqual(inMigration, QUALITY_STATES)
  // 每个值都要有中文标签，否则界面会渲染成裸英文枚举。
  for (const state of QUALITY_STATES) assert.match(QUALITY_STATE_LABELS[state], /\p{Script=Han}/u)
})

test('every badge class already exists in the stylesheet', () => {
  // #129 记过一类债：引用了不存在的令牌/类名，静默走 fallback，页面上看不出来。
  // 这里钉住三个状态用的是既有修饰类，而不是新造的配色。
  for (const state of QUALITY_STATES) {
    for (const name of qualityStateBadgeClass(state).split(/\s+/)) {
      assert.match(style, new RegExp(`\\.${name}\\s*\\{`), `${name} must exist in style.css`)
    }
  }
})

test('unknown state values survive instead of collapsing into candidate', () => {
  assert.equal(normalizeQualityState('quarantine'), 'quarantine')
  assert.equal(qualityStateBadgeClass('quarantine'), 'badge')
  const rows = qualityStateSummaryRows({ byState: { candidate: 2, quarantine: 1 } })
  assert.deepEqual(rows.map((row) => row.state), ['candidate', 'validated', 'withheld', 'quarantine'])
  assert.equal(rows.at(-1).count, 1)
})

test('empty values are candidate, not a fourth bucket', () => {
  for (const raw of ['', '   ', null, undefined]) {
    assert.equal(normalizeQualityState(raw), QUALITY_STATE.CANDIDATE)
    assert.equal(qualityStateLabel(raw), '待定')
  }
  // 汇总缺桶时三行仍在，计数为 0——界面上"这一桶没有"和"这一桶不存在"是两件事。
  assert.deepEqual(qualityStateSummaryRows({ byState: {} }).map((row) => row.count), [0, 0, 0])
})

test('basis is only pre-required for targets that change deliverability', () => {
  assert.equal(qualityStateNeedsBasis(QUALITY_STATE.CANDIDATE), false)
  assert.equal(qualityStateNeedsBasis(''), false, 'empty means candidate')
  assert.equal(qualityStateNeedsBasis(QUALITY_STATE.VALIDATED), true)
  assert.equal(qualityStateNeedsBasis(QUALITY_STATE.WITHHELD), true)
})
