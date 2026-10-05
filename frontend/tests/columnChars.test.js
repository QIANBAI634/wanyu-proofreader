import test from 'node:test'
import assert from 'node:assert/strict'
import {
  isHan, isIpa, isLatin, isToneDigit, isCircledNumber,
  isMeaningSeparator, isPlaceholderChar,
  charClass, readingSpans
} from '../src/lib/columnChars.js'

test('isHan covers unified and extension planes', () => {
  assert.equal(isHan('徛'), true)
  assert.equal(isHan('啊'), true)
  assert.equal(isHan('𢶀'), true) // Ext B
  assert.equal(isHan('㙟'), true) // Ext A
  assert.equal(isHan('a'), false)
  assert.equal(isHan('ŋ'), false)
  assert.equal(isHan(''), false)
})

test('isIpa covers IPA block, modifiers and combining marks', () => {
  assert.equal(isIpa('ŋ'), true)
  assert.equal(isIpa('ɒ'), true)
  assert.equal(isIpa('̃'), true) // combining tilde
  assert.equal(isIpa('ʰ'), true) // modifier letter
  assert.equal(isIpa('a'), false)
  assert.equal(isIpa('徛'), false)
})

test('isToneDigit and isCircledNumber', () => {
  assert.equal(isToneDigit('5'), true)
  assert.equal(isToneDigit('a'), false)
  assert.equal(isCircledNumber('①'), true)
  assert.equal(isCircledNumber('⑳'), true)
  assert.equal(isCircledNumber('1'), false)
})

test('charClass returns dominant category', () => {
  assert.equal(charClass('徛'), 'han')
  assert.equal(charClass('站、立'), 'han')
  assert.equal(charClass('kiā'), 'reading')
  assert.equal(charClass('ɑ533'), 'reading')
  assert.equal(charClass('a̤̍'), 'reading')
  assert.equal(charClass('徛 kiā'), 'mixed') // 词头 + 音读合并
  assert.equal(charClass(''), 'empty')
  assert.equal(charClass('   '), 'empty')
})

test('readingSpans returns codepoint half-open intervals', () => {
  // '徛 kiā' → 读音段 'kiā' 在码位 [2,5)（徛=0，空格=1，k=2，i=3，ā=4）
  assert.deepEqual(readingSpans('徛 kiā'), [[2, 5]])
  assert.deepEqual(readingSpans('徛'), [])
  // 多段读音
  assert.deepEqual(readingSpans('徛 kiā 啊 a'), [[2, 5], [8, 9]])
})

test('isLatin covers accented latin', () => {
  assert.equal(isLatin('a'), true)
  assert.equal(isLatin('ā'), true) // Latin Extended-A
  assert.equal(isLatin('ø'), true) // Latin-1 Supplement
  assert.equal(isLatin('徛'), false)
  assert.equal(isLatin(''), false)
})

test('isMeaningSeparator and isPlaceholderChar', () => {
  assert.equal(isMeaningSeparator('：'), true)
  assert.equal(isMeaningSeparator('‖'), true)
  assert.equal(isMeaningSeparator('啊'), false)

  const pua = String.fromCodePoint(0xE123)
  const ids = String.fromCodePoint(0x2FF0)
  assert.equal(isPlaceholderChar(pua), true)
  assert.equal(isPlaceholderChar(ids), true)
  assert.equal(isPlaceholderChar('徛'), false)
})

test('charClass treats placeholder as content (han)', () => {
  const pua = String.fromCodePoint(0xE123)
  const ids = String.fromCodePoint(0x2FF0)
  assert.equal(charClass(pua), 'han')
  assert.equal(charClass(ids), 'han')
  assert.equal(charClass(pua + ' kiā'), 'mixed') // 集外字词头 + 音读合并
})

test('charClass strips @hex placeholder (blocking regression)', () => {
  // @20000 是「打不出的字」占位，不是声调数字——五个 hex 位不能被当读音类。
  assert.equal(charClass('@20000'), 'han')
  assert.equal(charClass('甲@20000'), 'han')
  assert.equal(charClass('@20000 kiā'), 'mixed') // @hex 词头 + 音读
})

test('charClass does not treat isolated digits as reading', () => {
  // 孤立数字/年份不是读音，只有跟在读音字符后的才是声调。
  assert.equal(charClass('1978'), 'other')
  assert.equal(charClass('①1978年成立'), 'han')
  assert.equal(charClass('kiā533'), 'reading') // 读音后的声调数字仍是 reading
})
