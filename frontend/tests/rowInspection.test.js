import test from 'node:test'
import assert from 'node:assert/strict'
import { inspectRow, inspectPage, LONG_CELL_CODEPOINTS } from '../src/lib/rowInspection.js'

test('no marks for a clean row', () => {
  const headers = ['词头', '音读', '释义']
  const row = { 词头: '徛', 音读: 'kiā', 释义: '站、立' }
  assert.deepEqual(inspectRow(headers, row), [])
})

test('width signal when columns differ from headers', () => {
  const headers = ['词头', '音读', '释义']
  // 少一列：释义为空
  const row = { 词头: '徛', 音读: 'kiā', 释义: '' }
  const marks = inspectRow(headers, row)
  const width = marks.find((m) => m.signal === 'width')
  assert.ok(width, 'should flag width mismatch')
  assert.equal(width.count, 2)
  assert.equal(width.expected, 3)
})

test('long signal when a cell exceeds threshold', () => {
  const headers = ['释义']
  const longText = '啊'.repeat(LONG_CELL_CODEPOINTS + 1)
  const marks = inspectRow(headers, { 释义: longText })
  const long = marks.find((m) => m.signal === 'long')
  assert.ok(long, 'should flag long cell')
  assert.equal(long.header, '释义')
  assert.equal(long.count, LONG_CELL_CODEPOINTS + 1)
})

test('rare signal when a cell contains rare CJK extension', () => {
  const headers = ['词头', '释义']
  const marks = inspectRow(headers, { 词头: '𢶀', 释义: '生僻字' })
  const rare = marks.find((m) => m.signal === 'rare')
  assert.ok(rare, 'should flag rare character')
  assert.equal(rare.header, '词头')
})

test('ipa signal when a cell is dense with IPA', () => {
  const headers = ['音读']
  const marks = inspectRow(headers, { 音读: 'ɑ ɒ ɔ ɛ ø ɡ' })
  const ipa = marks.find((m) => m.signal === 'ipa')
  assert.ok(ipa, 'should flag IPA dense')
  assert.equal(ipa.header, '音读')
})

test('inspectPage parses page record', () => {
  const page = {
    ocr_row_json: JSON.stringify({ 词头: '𢶀', 释义: '' }),
    row_headers_json: JSON.stringify(['词头', '释义'])
  }
  const marks = inspectPage(page)
  // 词头有罕见字 + 释义空 → 至少 rare + width
  assert.ok(marks.some((m) => m.signal === 'rare'))
  assert.ok(marks.some((m) => m.signal === 'width'))
})

test('inspectPage degrades on corrupt input', () => {
  assert.deepEqual(inspectPage(null), [])
  assert.deepEqual(inspectPage({}), [])
  assert.deepEqual(inspectPage({ ocr_row_json: 'not json', row_headers_json: 'not json' }), [])
})

test('inspectRow does not leak cell content in marks', () => {
  const headers = ['释义']
  const marks = inspectRow(headers, { 释义: '机密内容' })
  // 标记只含结构信息，绝不包含单元格正文
  const serialized = JSON.stringify(marks)
  assert.equal(serialized.includes('机密内容'), false)
})
