import test from 'node:test'
import assert from 'node:assert/strict'
import { inspectRow, LONG_CELL_CODEPOINTS } from '../src/lib/rowInspection.js'

test('no marks for a clean row', () => {
  const headers = ['词头', '音读', '释义']
  const row = { 词头: '徛', 音读: 'kiā', 释义: '站、立' }
  assert.deepEqual(inspectRow(headers, row), [])
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

test('does not flag normal definition with reading annotation', () => {
  // 方言词典释义里带读音括注是常态，不应报任何可疑格（#124 复审结论）。
  const headers = ['词头', '释义']
  const marks = inspectRow(headers, { 词头: '镀锌铁', 释义: '镀锌铁。‖外来词，来自马来语ajan的音译。' })
  assert.deepEqual(marks, [])
})

test('inspectRow does not leak cell content in marks', () => {
  const headers = ['释义']
  const marks = inspectRow(headers, { 释义: '机密内容' })
  const serialized = JSON.stringify(marks)
  assert.equal(serialized.includes('机密内容'), false)
})

test('corrupt or empty input degrades to empty', () => {
  assert.deepEqual(inspectRow(null, {}), [])
  assert.deepEqual(inspectRow([], {}), [])
  assert.deepEqual(inspectRow(['词头'], null), [])
})
