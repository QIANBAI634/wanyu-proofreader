import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  adapterNotice,
  conversionJobStatusLabel,
  conversionSummaryLines,
  normalizationBadgeClass,
  normalizationStatusLabel,
  schemeOptionLabel,
  testOnlySchemeIds
} from '../src/lib/schemeConversion.js'

const style = readFileSync(new URL('../src/style.css', import.meta.url), 'utf8').replace(/\r\n/g, '\n')

const job = (overrides) => ({
  total_count: 10000, exact_count: 9000, reviewed_count: 720,
  ambiguous_count: 241, unsupported_count: 39, skipped_count: 0, failed_count: 0,
  ...overrides
})

test('自动确定 sums EXACT and REVIEWED', () => {
  // #114 §8 的「共处理 10000 / 自动确定 9720 / 需人工确认 241 / 暂未支持 39」
  // 就是这四个数对得上；把 REVIEWED 单列会让 9720 这个数字算不出来。
  const lines = conversionSummaryLines(job())
  const byKey = Object.fromEntries(lines.map((line) => [line.key, line.count]))
  assert.equal(byKey.total, 10000)
  assert.equal(byKey.auto, 9720)
  assert.equal(byKey.ambiguous, 241)
  assert.equal(byKey.unsupported, 39)
})

test('四行之和加跳过与处理失败等于共处理', () => {
  // 三条不变式一起钉：四行互不重叠、没有没被列出来的分支、失败也进求和。
  // 最后那条样例是必需的：后端三个失败分支都是 failed++ 且 total++，夹具全是
  // failed_count: 0 时这条断言恒真，覆盖不到「完成，部分条目写入失败」那种作业。
  for (const sample of [
    job(),
    job({ skipped_count: 12, total_count: 10012 }),
    job({ total_count: 0, exact_count: 0, reviewed_count: 0, ambiguous_count: 0, unsupported_count: 0 }),
    job({ failed_count: 7, total_count: 10007 })
  ]) {
    const lines = conversionSummaryLines(sample)
    const byKey = Object.fromEntries(lines.map((line) => [line.key, line.count]))
    assert.equal(
      byKey.auto + byKey.ambiguous + byKey.unsupported + byKey.skipped + byKey.failed,
      byKey.total,
      JSON.stringify(sample)
    )
  }
})

test('处理失败单列一行，不让差额无从解释', () => {
  const byKey = Object.fromEntries(conversionSummaryLines(job({ failed_count: 7 })).map((line) => [line.key, line.count]))
  assert.equal(byKey.failed, 7)
  // 单列而不是并进「跳过」：两者成因不同，合并会掩盖掉「写库失败」这个可行动的信号。
  assert.equal(byKey.skipped, 0)
})

test('缺字段的作业显示 0 而不是 NaN', () => {
  const lines = conversionSummaryLines(null)
  for (const line of lines) assert.equal(line.count, 0)
  assert.equal(conversionJobStatusLabel(undefined), '未开始')
  assert.equal(normalizationStatusLabel(''), '未转换')
})

test('未转换的条目要能与「转换过但不是这个状态」区分开', () => {
  assert.equal(normalizationStatusLabel('AMBIGUOUS'), '需人工确认')
  assert.equal(normalizationStatusLabel('NOPE'), 'NOPE', '取值表外的状态原样显示，不能吞成空白')
  assert.equal(conversionJobStatusLabel('failed'), '失败')
})

test('状态到 badge 类的映射是逐条钉住的', () => {
  // 只断言「类名在样式表里存在」是不够的：把 EXACT 与 UNSUPPORTED 的修饰类对调，
  // 两侧的类名都仍然存在，而页面上「自动确定」会画成红色——正是 #129 那类静默错误。
  // 所以取值在这里逐条写死，样式表检查只负责「这些类名真的定义了」。
  assert.equal(normalizationBadgeClass('EXACT'), 'badge badge-approved')
  assert.equal(normalizationBadgeClass('REVIEWED'), 'badge badge-proofread')
  assert.equal(normalizationBadgeClass('AMBIGUOUS'), 'badge badge-arbitration')
  assert.equal(normalizationBadgeClass('UNSUPPORTED'), 'badge badge-rejected')
  // 未转换与取值表外的状态只给基础类，不冒充任何一种结论。
  assert.equal(normalizationBadgeClass(''), 'badge')
  assert.equal(normalizationBadgeClass('NOPE'), 'badge')
})

test('方案选择器把「仅测试」标在选项上', () => {
  // 规则文件自己声明能不能跑真实作业。这句话要在按钮之前就看得见，否则管理员点下去
  // 收到一个 400，只会以为是界面坏了。
  const runnable = { source_scheme_id: 'a', canonical_scheme_id: 'b', rule_version: 'v1', rule_status: 'production' }
  const fixture = { source_scheme_id: 'x', canonical_scheme_id: 'y', rule_version: 'v0', rule_status: 'test' }
  assert.equal(schemeOptionLabel(runnable), 'a → b（v1）')
  assert.match(schemeOptionLabel(fixture), /^x → y（v0）.*仅测试/)
  // 判据是 === 'production'，不是 !== 'test'：服务端将来多一个取值时，不认识的那个
  // 必须落在「不能跑真实作业」这一侧，与后端 MayDriveRealJobs 同口径。
  assert.match(schemeOptionLabel({ ...fixture, rule_status: 'NOPE' }), /仅测试/)
  assert.match(schemeOptionLabel({}), /仅测试/)

  const ids = testOnlySchemeIds([runnable, fixture, { source_scheme_id: 'z' }])
  assert.deepEqual(ids, ['x', 'z'])
  assert.deepEqual(testOnlySchemeIds([runnable]), [])
  assert.deepEqual(testOnlySchemeIds(undefined), [])
})

test('every badge class exists in the stylesheet', () => {
  // #129 记过一类债：引用了不存在的类名，静默走 fallback，页面上看不出来。
  for (const status of ['EXACT', 'REVIEWED', 'AMBIGUOUS', 'UNSUPPORTED', 'UNKNOWN']) {
    for (const name of normalizationBadgeClass(status).split(/\s+/)) {
      assert.match(style, new RegExp(`\\.${name}\\s*\\{`), `${name} must exist in style.css`)
    }
  }
})

test('adapter notice is shown as configuration, not as a result', () => {
  assert.equal(adapterNotice({ notice: '' }), '')
  assert.equal(adapterNotice(null), '')
  assert.match(adapterNotice({ notice: '本实例没有配置规则目录（环境变量 FANGJI_SCHEME_ADAPTER_DIR）' }),
    /没有配置规则目录/)
})
