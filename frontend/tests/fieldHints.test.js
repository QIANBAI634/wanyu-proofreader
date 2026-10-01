import test from 'node:test'
import assert from 'node:assert/strict'
import {
  HINT_DISPLAY_LIMIT,
  hintKindLabel,
  hintsForField,
  hintsOverflowFor,
  locateSpan,
  pageLevelHints,
  pageLevelOverflow,
  prepareFieldHints,
  gatedNotice
} from '../src/lib/fieldHints.js'

// #176 §3.1 的一条真实形状（含 message_key 与 evidence），供各用例复用。
function makeHint(overrides = {}) {
  return {
    field: '莆田IPA',
    kind: 'reading_format_invalid',
    severity: 'warn',
    message: { key: 'long_digit_run', params: { runs: ['5333'], run_count: 1 } },
    highlight: false,
    evidence: {},
    ...overrides
  }
}

// ---- 空数组退化：这是当前（#179 回填后）唯一会发生的线上情况 ----

test('empty hints degrade to a frozen empty structure with zero display surface', () => {
  const prepared = prepareFieldHints([])
  // 引用相等 = 视图每次拿到的都是同一个不可变空对象，任何 v-if 判定恒假。
  assert.equal(prepared, prepareFieldHints([]))
  assert.deepEqual(prepared, { fields: {}, pageLevel: { items: [], overflow: 0 }, total: 0 })
  assert.equal(hintsForField(prepared, '莆田IPA').length, 0)
  assert.equal(hintsOverflowFor(prepared, '莆田IPA'), 0)
  assert.equal(pageLevelHints(prepared).length, 0)
  assert.equal(pageLevelOverflow(prepared), 0)
})

test('non-array garbage never throws and behaves exactly like the empty case', () => {
  for (const garbage of [null, undefined, 0, '', 'hints', {}]) {
    assert.equal(prepareFieldHints(garbage), prepareFieldHints([]))
  }
})

// ---- 分组、顺序与 D_max ----

test('hints group by field; an empty field name becomes page-level', () => {
  const prepared = prepareFieldHints([
    makeHint(),
    makeHint({ field: '仙游IPA', message: { key: 'combining_marks_present', params: { marks: ['0x303'] } } }),
    makeHint({ field: '', message: { key: 'row_width_differs', params: { cells: 5, headers: 4 } } })
  ])
  assert.deepEqual(Object.keys(prepared.fields).sort(), ['仙游IPA', '莆田IPA'])
  assert.equal(hintsForField(prepared, '莆田IPA').length, 1)
  assert.match(hintsForField(prepared, '莆田IPA')[0].text, /三位以上连续数字/)
  assert.equal(pageLevelHints(prepared).length, 1)
  assert.match(pageLevelHints(prepared)[0].text, /单元格数与表头不符/)
})

test('highlighted hints sort first but nothing is ever hidden by severity (契约 §3.1 强调信号唯一)', () => {
  const prepared = prepareFieldHints([
    makeHint({ kind: 'punctuation_mix', message: { key: 'punctuation_width_mixed_in_column', params: {} } }),
    makeHint({ highlight: true, severity: 'strong', kind: 'encoding_form_anomaly', message: { key: 'mixed_normalization_forms', params: { nfc: 2, nfd: 1, minority: 'NFD' } } }),
    makeHint({ kind: 'missing_field', message: { key: 'required_role_field_empty', params: { role: 'reading' } } })
  ])
  const items = hintsForField(prepared, '莆田IPA')
  assert.equal(items.length, 3)
  assert.equal(items[0].highlight, true)
  assert.equal(items[1].highlight, false)
  // 服务端给的相对顺序在非高亮组内保持不变（稳定排序）。
  assert.equal(items[1].kind, 'punctuation_mix')
  assert.equal(items[2].kind, 'missing_field')
})

test('D_max keeps display density bounded and folds the rest into a count', () => {
  const many = Array.from({ length: HINT_DISPLAY_LIMIT + 2 }, (_, i) =>
    makeHint({ kind: `kind_${i}`, message: { key: `unknown_key_${i}`, params: {} } }))
  const prepared = prepareFieldHints(many)
  assert.equal(hintsForField(prepared, '莆田IPA').length, HINT_DISPLAY_LIMIT)
  assert.equal(hintsOverflowFor(prepared, '莆田IPA'), 2)
  assert.equal(prepared.total, many.length)
})

test('D_max caps the whole row, not each field (门槛文件 §8.1 每行口径)', () => {
  // 2(莆田IPA) + 1(释义) + 2(整条级) = 5 条，无 highlight → 服务端序取前 3。
  const prepared = prepareFieldHints([
    makeHint(),
    makeHint({ kind: 'punctuation_mix', message: { key: 'punctuation_width_mixed_in_column', params: {} } }),
    makeHint({ field: '释义', message: { key: 'row_width_differs', params: { cells: 5, headers: 4 } } }),
    makeHint({ field: '', message: { key: 'pdf_page_backtrack', params: { from_page: 9, to_page: 5, backtrack: 4 } } }),
    makeHint({ field: '', message: { key: 'example_missing', params: {} } })
  ])
  const visibleTotal =
    hintsForField(prepared, '莆田IPA').length +
    hintsForField(prepared, '释义').length +
    pageLevelHints(prepared).length
  assert.equal(visibleTotal, HINT_DISPLAY_LIMIT)
  // 被行级上限隐藏的疑点按桶记数，绝不静默消失。
  assert.equal(hintsOverflowFor(prepared, '莆田IPA'), 0)
  assert.equal(hintsOverflowFor(prepared, '释义'), 0)
  assert.equal(pageLevelOverflow(prepared), 2)
  assert.equal(prepared.total, 5)
})

test('a row-wide cap still lets highlights win across fields', () => {
  const prepared = prepareFieldHints([
    makeHint(),
    makeHint({ field: '释义' }),
    makeHint({ field: '', highlight: true, severity: 'strong' })
  ])
  // 3 条恰好都在上限内：整行可见 = 3，高亮在桶内排前。
  assert.equal(pageLevelHints(prepared)[0].highlight, true)
  assert.equal(hintsForField(prepared, '莆田IPA').length, 1)
})

test('hints for unrendered columns fall back to page level (宁可多标也不要漏标)', () => {
  const hints = [
    makeHint({ field: '字词' }),
    makeHint({ field: '仙游IPA', message: { key: 'combining_marks_present', params: { marks: ['0x303'] } } })
  ]
  const prepared = prepareFieldHints(hints, ['字词', '莆田IPA', '释义'])
  assert.equal(prepared.fields['仙游IPA'], undefined)
  assert.equal(hintsForField(prepared, '仙游IPA').length, 0)
  assert.equal(pageLevelHints(prepared).length, 1)
  assert.match(pageLevelHints(prepared)[0].text, /组合附加符/)
  // Set 也接受；不传第二参则维持纯按 field 分组的旧行为（视图以外调用不受影响）。
  const asSet = prepareFieldHints(hints, new Set(['字词']))
  assert.equal(pageLevelHints(asSet).length, 1)
  const unbounded = prepareFieldHints(hints)
  assert.equal(hintsForField(unbounded, '仙游IPA').length, 1)
})

// ---- kind 标签与措辞退化 ----

test('all ten contract kinds get labels and an unknown kind falls back readably (#178 扩展点)', () => {
  const kinds = [
    'char_out_of_repertoire', 'confusable_substitution', 'encoding_form_anomaly', 'missing_field',
    'reading_format_invalid', 'punctuation_mix', 'page_outlier', 'duplicate_identity',
    'cross_source_conflict', 'merged_columns'
  ]
  for (const kind of kinds) {
    const label = hintKindLabel(kind)
    assert.ok(label && label !== kind, `${kind} should have a shipped label`)
  }
  // 新 kind（例如 #178 后续扩展）不改渲染端也不会坏：原样回显，不抛错。
  assert.equal(hintKindLabel('brand_new_kind'), 'brand_new_kind')
  assert.equal(hintKindLabel(''), '机器疑点')
})

test('a malformed hint renders a fallback message instead of throwing', () => {
  const prepared = prepareFieldHints([null, makeHint({ field: '', message: undefined })])
  assert.equal(prepared.total, 2)
  assert.equal(pageLevelHints(prepared).length, 2)
  for (const item of pageLevelHints(prepared)) {
    assert.match(item.text, /未登记的疑点类型/)
  }
})

// ---- SourceSpan 定位 ----

test('char_offsets are codepoint pairs converted to utf-16 selection bounds', () => {
  assert.deepEqual(locateSpan('abcd5333ef', [[4, 8]]), { start: 4, end: 8 })
  // 补充平面汉字占 1 个码位、2 个 UTF-16 单元：𢶀abc 的 [0,2] → utf-16 [0,3]。
  assert.deepEqual(locateSpan('𢶀abc', [[0, 2]]), { start: 0, end: 3 })
  assert.deepEqual(locateSpan('甲𢶀乙', [[1, 2]]), { start: 1, end: 3 })
})

test('locateSpan returns null for missing or malformed offsets (定位降级为聚焦字段)', () => {
  assert.equal(locateSpan('abc', undefined), null)
  assert.equal(locateSpan('abc', []), null)
  assert.equal(locateSpan('abc', [[2, 1]]), null)
  assert.equal(locateSpan('abc', [[1, 99]]), null)
  assert.equal(locateSpan('abc', [['x', 2]]), null)
  assert.equal(locateSpan('', [[0, 1]]), null)
  assert.equal(locateSpan(null, [[0, 1]]), null)
  // 取第一个可用区间，坏形状跳过后继续。
  assert.deepEqual(locateSpan('abcdef', [[9, 8], [1, 3]]), { start: 1, end: 3 })
})

// #228/#234：被门控挡住的条数要说出来，否则"没下发"会被读成"没疑点"。
test('gated notice separates "not released" from "nothing found"', () => {
  assert.equal(gatedNotice(0), '', '0 条被挡住时不该出现任何文案')
  assert.equal(gatedNotice(undefined), '')
  assert.equal(gatedNotice(null), '')
  assert.equal(gatedNotice(''), '')
  assert.equal(gatedNotice(-3), '', '负数是后端 bug，不能显示成"另有 -3 处"')
  assert.equal(gatedNotice('abc'), '')
  const text = gatedNotice(2)
  assert.match(text, /另有 2 处机器疑点暂未开放显示/)
  assert.match(text, /不代表这条没有值得看的地方/)
  assert.equal(gatedNotice(1.9), '本条另有 1 处机器疑点暂未开放显示（规则尚未放行，不代表这条没有值得看的地方）。',
    '非整数要向下取整，不能显示 1.9 处')
})
