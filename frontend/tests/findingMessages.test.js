import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import {
  codepointLabel,
  findingMessageKeys,
  renderFindingMessage,
  renderHints,
  FALLBACK_PREFIX
} from '../src/lib/findingMessages.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const detectors = path.join(here, '..', '..', 'scripts', 'corpus_probe', 'detectors.py')
const rulesLib = path.join(here, '..', '..', 'backend', 'pb_hooks', 'lib', 'assist_rules.js')
const identityLib = path.join(here, '..', '..', 'backend', 'pb_hooks', 'lib', 'assist_identity.js')

// 措辞表与生产者必须一起改：检测器或规则引擎新增一个 message_key 而前端没配措辞时，
// 校对员会看到 FALLBACK 文案，而这两条测试会先一步失败。
function detectorMessageKeys() {
  const source = readFileSync(detectors, 'utf8')
  const pattern = /finding\(\s*[A-Z_]+,\s*[A-Z]+,\s*[^,]+,\s*"([a-z_]+)"/g
  const keys = new Set()
  for (const match of source.matchAll(pattern)) keys.add(match[1])
  assert.ok(keys.size >= 9, `expected the shipped detectors' message keys, got ${[...keys]}`)
  return keys
}

// #177 的 JS 规则引擎：finding(kind, severity, field, "message_key", ...)
function ruleEngineMessageKeys() {
  const source = readFileSync(rulesLib, 'utf8')
  const pattern = /finding\(\s*"[a-z_]+",\s*"(?:info|warn|strong)",\s*[^,]+,\s*"([a-z_]+)"/g
  const keys = new Set()
  for (const match of source.matchAll(pattern)) keys.add(match[1])
  // 少于 5 个说明规则库被改动过或正则失配——那本身就是一次漂移，必须失败而不是静默通过。
  assert.ok(keys.size >= 5, `expected the rule engine's message keys, got ${[...keys]}`)
  return keys
}

// #178 的跨行检出：finding 字面量形状是 { kind, severity, field, message_key, ... }
function identityMessageKeys() {
  const source = readFileSync(identityLib, 'utf8')
  const pattern = /kind:\s*"[a-z_]+",\s*severity:\s*"(?:info|warn|strong)",\s*[^,]+,\s*\n?\s*message_key:\s*"([a-z_]+)"/g
  const keys = new Set()
  for (const match of source.matchAll(pattern)) keys.add(match[1])
  assert.ok(keys.size >= 3, `expected the identity detector's message keys, got ${[...keys]}`)
  return keys
}

test('every detector message key has a wording entry', () => {
  const registered = new Set(findingMessageKeys())
  for (const key of detectorMessageKeys()) {
    assert.ok(registered.has(key), `findingMessages.js is missing wording for ${key}`)
  }
})

test('every cross-row detector message key has a wording entry', () => {
  const registered = new Set(findingMessageKeys())
  for (const key of identityMessageKeys()) {
    assert.ok(registered.has(key), `findingMessages.js is missing wording for ${key}`)
  }
})

test('every rule engine message key has a wording entry', () => {
  const registered = new Set(findingMessageKeys())
  for (const key of ruleEngineMessageKeys()) {
    assert.ok(registered.has(key), `findingMessages.js is missing wording for ${key}`)
  }
})

test('each wording renders and stays free of cell text', () => {
  const cases = [
    ['long_digit_run', { runs: ['5333'], run_count: 1 }],
    ['tone_token_count_differs', { pinyin_count: 2, ipa_count: 3 }],
    ['missing_glyph_placeholder', { marks: ['@20000'], mark_count: 1 }],
    ['column_collapse', { reasons: ['unbalanced_bracket'] }],
    ['meaning_is_phonetic_fragment', {}],
    ['phonetic_run_inside_meaning', {}],
    ['mixed_normalization_forms', { minority: 'nfd', nfc: 2276, nfd: 1986 }],
    ['combining_marks_present', { marks: ['0x303'] }],
    ['non_ipa_range_codepoints', { codepoints: ['0x3b6'] }],
    ['cjk_extension_present', { codepoints: ['0x20bb8'] }],
    ['row_width_differs', { cells: 7, headers: 6 }],
    ['confusable_ascii_in_reading', { suggestions: [{ found: 'U+0061', suggested: ['U+0251'] }], positions: [3], hit_count: 1 }],
    ['punctuation_width_mixed_in_column', { pairs: [{ full: 'U+FF08', half: 'U+0028' }], pair_count: 1 }],
    ['required_role_field_empty', { role: 'meaning' }],
    ['pdf_page_backtrack', { from_page: 40, to_page: 12, backtrack: 28 }],
    ['page_entry_count_outlier', { entries_on_page: 31, median_entries: 6, ceiling: 18 }],
    // #178 跨行检出的三条。第一条是**故意的对抗样本**：生产方今天不带这两个键
    // （assist_identity.js 只发 differs_on / partner_count / sources），但措辞不许把词头与
    // 记音渲染进正文（findingMessages.js 里那句隐私承诺）这件事，得在有人把它们塞回来时立刻红，
    // 而不是只靠注释自觉——所以这里偏要带上它们。
    ['same_identity_different_content', {
      partner_count: 2, differs_on: ['释义', '拼音'],
      identity_headword: '喼测试', identity_reading: 'kʰɐt̚5'
    }],
    ['multiple_headwords_in_cell', { segments: 3, sample_lengths: [2, 5, 1] }],
    ['reading_inside_meaning_row', { has_tone_digits: true, has_ipa_marks: true }]
  ]
  for (const [key, params] of cases) {
    const text = renderFindingMessage({ key, params })
    // 短是可以的（「释义列为空」只有五个字，列名本来就在 field 里），
    // 不可以的是空串、退化成正则/FALLBACK、以及把 params 原样吐出来。
    assert.ok(text.length >= 4, `${key} rendered ${JSON.stringify(text)}`)
    assert.ok(!text.startsWith(FALLBACK_PREFIX), `${key} fell through to the fallback: ${text}`)
    assert.ok(!/[{}[\]]/.test(text), `${key} leaked raw params: ${text}`)
    // 别人条目的内容不许出现在这一条的措辞里（字段名与计数可以）。
    for (const secret of [params.identity_headword, params.identity_reading]) {
      if (typeof secret === 'string' && secret.length) {
        assert.ok(!text.includes(secret), `${key} 把词头/记音渲染进了措辞正文：${text}`)
      }
    }
  }
})

test('codepoints are labelled, never rendered as glyphs', () => {
  assert.equal(codepointLabel('0x303'), 'U+0303')
  assert.equal(codepointLabel('U+20BB8'), 'U+20BB8')
  assert.equal(codepointLabel(0x20bb8), 'U+20BB8')
  assert.equal(codepointLabel('𠮷'), '未知码位')
  assert.equal(codepointLabel(-1), '未知码位')
  assert.equal(codepointLabel(null), '未知码位')
  // 组合符措辞即便被塞进真的字符也只能显示码位。
  const text = renderFindingMessage({ key: 'combining_marks_present', params: { marks: ['𠮷', '0x303'] } })
  assert.ok(text.includes('U+0303'), text)
  assert.ok(text.includes('未知码位'), text)
  assert.ok(!text.includes('𠮷'), `wording echoed a glyph instead of a codepoint: ${text}`)
})

test('a missing key falls back without throwing', () => {
  assert.ok(renderFindingMessage({ key: 'brand_new_rule', params: {} }).startsWith(FALLBACK_PREFIX))
  assert.ok(renderFindingMessage({}).startsWith(FALLBACK_PREFIX))
  assert.ok(renderFindingMessage(null).startsWith(FALLBACK_PREFIX))
  // params 缺失或形状错误都不能让措辞函数抛错。
  assert.equal(typeof renderFindingMessage({ key: 'row_width_differs' }), 'string')
  assert.ok(renderFindingMessage({ key: 'long_digit_run', params: { runs: 'not-a-list' } }).length > 8)
})

test('counters fall back to what is derivable, not to zero text', () => {
  assert.ok(renderFindingMessage({ key: 'long_digit_run', params: { runs: ['123', '456'] } }).includes('2'))
  assert.ok(renderFindingMessage({ key: 'row_width_differs', params: { cells: 'abc', headers: 6 } }).includes('0 对 6'))
})

test('renderHints is empty for no data and drops nothing otherwise', () => {
  assert.deepEqual(renderHints([]), [])
  assert.deepEqual(renderHints(undefined), [])
  assert.deepEqual(renderHints(null), [])
  const hints = renderHints([
    { field: '拼音', kind: 'reading_format_invalid', severity: 'strong', highlight: true, message: { key: 'long_digit_run', params: { runs: ['5333'], run_count: 1 } } },
    { field: '释义', kind: 'merged_columns', severity: 'warn', highlight: false, message: { key: 'phonetic_run_inside_meaning', params: {} } }
  ])
  assert.equal(hints.length, 2)
  assert.deepEqual(hints[0], {
    field: '拼音',
    kind: 'reading_format_invalid',
    severity: 'strong',
    highlight: true,
    text: hints[0].text
  })
  assert.equal(hints[1].highlight, false)
  assert.equal(hints[1].field, '释义')
})
