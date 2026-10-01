import test from 'node:test'
import assert from 'node:assert/strict'
import {
  isHan, isIpa, isLatin, isToneDigit, isCircledNumber, isMeaningSeparator,
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
})
