import test from 'node:test'
import assert from 'node:assert/strict'
import { inspectRow, LONG_CELL_CODEPOINTS } from '../src/lib/rowInspection.js'

test('no marks for a clean row', () => {
  const headers = ['词头', '音读', '释义']
  const row = { 词头: '徛', 音读: 'kiā', 释义: '站、立' }
  assert.deepEqual(inspectRow(headers, row), [])
})

test('column_collapse when a cell mixes han and reading', () => {
  const headers = ['词头', '音读', '释义']
  // 一格挤了「徛」（汉字）+「kiā」（拉丁）→ 列合并
  const marks = inspectRow(headers, { 词头: '徛 kiā', 音读: '', 释义: '站' })
  const collapse = marks.find((m) => m.message.key === 'column_collapse')
  assert.ok(collapse, 'mixed cell should flag column collapse')
  assert.equal(collapse.field, '词头')
})

test('no column_collapse when cell is pure han or pure reading', () => {
  const headers = ['词头', '音读', '释义']
  // 纯汉字释义格、纯拉丁音读格都不该报列合并
  const marks = inspectRow(headers, { 词头: '徛', 音读: 'kiā', 释义: '站、立' })
  assert.equal(marks.some((m) => m.message.key === 'column_collapse'), false)
})

test('long signal when a cell exceeds threshold', () => {
  const headers = ['释义']
  const longText = '啊'.repeat(LONG_CELL_CODEPOINTS + 1)
  const marks = inspectRow(headers, { 释义: longText })
  const long = marks.find((m) => m.message.key === 'long_cell')
  assert.ok(long, 'should flag long cell')
  assert.equal(long.field, '释义')
  assert.equal(long.message.params.codepoints, LONG_CELL_CODEPOINTS + 1)
})

test('rare signal when a cell contains rare CJK extension', () => {
  const headers = ['词头', '释义']
  const marks = inspectRow(headers, { 词头: '𢶀', 释义: '生僻字' })
  const rare = marks.find((m) => m.message.key === 'cjk_extension_present')
  assert.ok(rare, 'should flag rare character')
  assert.equal(rare.field, '词头')
})

test('ipa signal when a cell is dense with IPA', () => {
  const headers = ['音读']
  const marks = inspectRow(headers, { 音读: 'ɑ ɒ ɔ ɛ ø ɡ' })
  const ipa = marks.find((m) => m.message.key === 'non_ipa_range_codepoints')
  assert.ok(ipa, 'should flag IPA dense')
  assert.equal(ipa.field, '音读')
})

test('inspectRow does not leak cell content in marks', () => {
  const headers = ['释义']
  const marks = inspectRow(headers, { 释义: '机密内容' })
  // 标记只含结构信息（key + params 码位/计数），绝不包含单元格正文
  const serialized = JSON.stringify(marks)
  assert.equal(serialized.includes('机密内容'), false)
})
