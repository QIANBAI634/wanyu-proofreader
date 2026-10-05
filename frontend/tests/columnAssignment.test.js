import test from 'node:test'
import assert from 'node:assert/strict'
import { assignColumns, assignRow } from '../src/lib/columnAssignment.js'
import { locateSpan } from '../src/lib/fieldHints.js'

test('equal-width columns are assigned correctly', () => {
  const headers = ['词头', '莆田IPA', '释义']
  const cells = ['徛', 'kiā', '站、立']
  const result = assignColumns(headers, cells)
  assert.equal(result[0].assignedHeader, '词头')
  assert.equal(result[1].assignedHeader, '莆田IPA')
  assert.equal(result[2].assignedHeader, '释义')
  assert.equal(result.every((r) => r.merged === false), true)
})

test('unboxed columns separated by whitespace keep their reading', () => {
  const headers = ['词头', '拼音', '释义']
  const cells = ['阿', 'a1', '①用在亲属称谓前']
  const row = assignRow(headers, cells)
  assert.equal(row.词头, '阿')
  assert.equal(row.拼音, 'a1')
  assert.equal(row.释义, '①用在亲属称谓前')
})

test('IPA combining marks belong to the reading column', () => {
  const headers = ['词头', '莆田IPA', '释义']
  const cells = ['阿', 'a̤̍', '舅母']
  const row = assignRow(headers, cells)
  assert.equal(row.莆田IPA, 'a̤̍')
})

test('circled numbers belong to the meaning column', () => {
  const headers = ['词头', '莆田IPA', '释义']
  const cells = ['阿', 'ɑ533', '①啊②唉']
  const row = assignRow(headers, cells)
  assert.equal(row.释义, '①啊②唉')
})

test('single column without spaces', () => {
  const headers = ['词头']
  const cells = ['徛']
  const result = assignColumns(headers, cells)
  assert.equal(result[0].assignedHeader, '词头')
})

test('merged cell (headword + reading) is flagged with char_offsets', () => {
  const headers = ['词头', '莆田IPA', '释义']
  const cells = ['徛 kiā', '', '站、立']
  const result = assignColumns(headers, cells)
  const merged = result.find((r) => r.merged === true)
  assert.ok(merged, 'should flag a merged cell')
  assert.deepEqual(merged.charOffsets, [[2, 5]]) // 'kiā' 的码位区间
})

test('merged cell via region label is flagged', () => {
  const headers = ['词头', '莆田IPA', '释义']
  const cells = ['阿〔莆田〕a1', '', '啊']
  const result = assignColumns(headers, cells)
  assert.ok(result.some((r) => r.merged === true))
})

test('definition example mentioning headword is not flagged as merged', () => {
  const headers = ['词头', '莆田IPA', '释义']
  const cells = ['徛', 'kiā', '徛站（站立）']
  const result = assignColumns(headers, cells)
  // 释义格含汉字 + 汉字，非 mixed，不应误判合并
  assert.equal(result[2].merged, false)
  assert.equal(result[2].assignedHeader, '释义')
})

test('char_offsets are consumable by fieldHints.locateSpan', () => {
  // 交叉断言：assignColumns 产出的 char_offsets 是码位区间，
  // 应能被 fieldHints.js 的 locateSpan 正确换算成 UTF-16 选区。
  const headers = ['词头', '莆田IPA', '释义']
  const cells = ['徛 kiā', '', '站、立']
  const result = assignColumns(headers, cells)
  const merged = result.find((r) => r.merged === true)
  assert.ok(merged)
  const span = locateSpan(cells[0], merged.charOffsets)
  assert.ok(span, 'locateSpan should accept codepoint offsets')
  // '徛 kiā'：码位 [2,5) 对应 UTF-16 也是 [2,5)（无补充平面字符）
  assert.deepEqual(span, { start: 2, end: 5 })
})

test('placeholder (PUA/IDS) headword is assigned to headword column', () => {
  const pua = String.fromCodePoint(0xE123)
  const ids = String.fromCodePoint(0x2FF0)
  const row1 = assignRow(['词头', '音读', '释义'], [pua, 'kiā', '站'])
  assert.equal(row1.词头, pua)
  assert.equal(row1.音读, 'kiā')
  assert.equal(row1.释义, '站')

  const row2 = assignRow(['词头', '音读', '释义'], [ids, 'kiā', '站'])
  assert.equal(row2.词头, ids)
})

test('@hex placeholder headword is assigned to headword column (blocking regression)', () => {
  const row = assignRow(['词头', '读音', '释义'], ['@20000', 'ka', '①东西'])
  assert.equal(row.词头, '@20000')
  assert.equal(row.读音, 'ka')
  assert.equal(row.释义, '①东西')
})

test('isolated region label is not flagged as merged', () => {
  // 单独一个地区标注格（如地区列）是合法的，只有地区标签外还有内容才算可疑。
  const headers = ['词头', '地区', '释义']
  const cells = ['徛', '〔莆田〕', '站']
  const result = assignColumns(headers, cells)
  assert.equal(result[1].merged, false)
})

test('rare CJK extension headword is preserved unchanged', () => {
  // 静默替换率 = 0：分列不改字，生僻字原样保留
  const row = assignRow(['词头', '释义'], ['𢶀', '生僻字释义'])
  assert.equal(row.词头, '𢶀')
  assert.equal(row.释义, '生僻字释义')
})

test('missing cells leave trailing columns unassigned', () => {
  const result = assignColumns(['词头', '音读', '释义'], ['徛', 'kiā'])
  assert.equal(result[0].assignedHeader, '词头')
  assert.equal(result[1].assignedHeader, '音读')
  assert.equal(result.length, 2)
})

test('extra cells keep empty assignedHeader', () => {
  const result = assignColumns(['词头', '音读', '释义'], ['徛', 'kiā', '站', '多余'])
  assert.equal(result[3].assignedHeader, '')
})

test('empty headers or cells do not throw', () => {
  assert.deepEqual(assignColumns([], ['徛']), [{ cellIndex: 0, assignedHeader: '', merged: false, charOffsets: undefined }])
  assert.deepEqual(assignColumns(['词头'], []), [])
})

test('assignColumns is a pure function (deterministic)', () => {
  const a = assignColumns(['词头', '音读', '释义'], ['徛', 'kiā', '站'])
  const b = assignColumns(['词头', '音读', '释义'], ['徛', 'kiā', '站'])
  assert.deepEqual(a, b)
})
