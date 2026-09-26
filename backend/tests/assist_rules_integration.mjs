import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
// 规则库是纯函数（不碰 DAO、不 require 别的 lib），所以能在 node 里直接加载做表驱动单测。
const rules = require('../pb_hooks/lib/assist_rules.js')
// 写入侧 lib 也只在函数体内碰 DAO 与 goja 全局，模块本身能在 node 里直接载入，
// 所以游标这种"不需要数据也能证伪"的逻辑可以在不起服务器的这一段钉住。
const writer = require('../pb_hooks/lib/assist_writer.js')
const keyboardDefinition = require('../keyboards/hinghwa-dialect.json')

const baseUrl = process.env.PB_URL || 'http://127.0.0.1:18091'
const platformEmail = process.env.APP_ADMIN_EMAIL
const platformPassword = process.env.APP_ADMIN_PASSWORD
const superEmail = process.env.PB_SUPER_EMAIL
const superPassword = process.env.PB_SUPER_PASSWORD
if (!platformEmail || !platformPassword || !superEmail || !superPassword) {
  throw new Error('Set APP_ADMIN_EMAIL, APP_ADMIN_PASSWORD, PB_SUPER_EMAIL and PB_SUPER_PASSWORD.')
}

async function request(path, { method = 'GET', token = '', body, expected = 200 } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { ...(token ? { Authorization: token } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body)
  })
  const raw = await response.text()
  let payload = null
  if (raw) { try { payload = JSON.parse(raw) } catch { payload = raw } }
  assert.equal(response.status, expected, `${method} ${path}: ${response.status} ${raw}`)
  return payload
}

const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`
const password = 'AssistRules123!'
const projectIds = []
const userIds = []
const gateIds = []

const platformAuth = await request('/api/collections/users/auth-with-password', {
  method: 'POST', body: { identity: platformEmail, password: platformPassword }
})
const superAuth = await request('/api/collections/_superusers/auth-with-password', {
  method: 'POST', body: { identity: superEmail, password: superPassword }
})

const ctx = rules.makeContext({ keyboards: [{ definition: keyboardDefinition }] })
const keysOf = (findings) => findings.map((item) => item.message_key).sort()

// ===================== 纯函数部分：逐规则 命中 / 不命中 / 边界 =====================

// 先证明混淆表真的从键盘 hint 编译出来了——表空的话 R2 会一条都不报而测试照样"通过"。
assert.ok(ctx.confusables.size >= 2, `confusables table empty: ${[...ctx.confusables.keys()]}`)
assert.ok(ctx.confusables.get('a')?.includes('U+0251'), 'expected a→ɑ from the shipped keyboard')
assert.ok(ctx.repertoire.size > 120, `repertoire too small: ${ctx.repertoire.size}`)

// R1 char_out_of_repertoire
{
  const hit = rules.ruleCharOutOfRepertoire(ctx, { 释义: '甲→乙' })
  assert.deepEqual(keysOf(hit), ['non_ipa_range_codepoints'], JSON.stringify(hit))
  assert.ok(hit[0].params.codepoints.includes('U+2192'), JSON.stringify(hit[0].params))
  assert.equal(hit[0].severity, 'warn')
  assert.deepEqual(rules.ruleCharOutOfRepertoire(ctx, { 莆田IPA: 'ãɒ̃ʔǾ' }), [])
  assert.deepEqual(rules.ruleCharOutOfRepertoire(ctx, { 释义: '' }), [])
  // 边界：启用键盘里的字符即使在放行区段之外也不算集外——∣(U+2223) 属数学符号区。
  assert.ok(!rules.inAllowed(0x2223), 'U+2223 should be outside the allowed ranges')
  assert.ok(ctx.repertoire.has(0x2223), 'U+2223 should be in the shipped keyboard')
  assert.deepEqual(rules.ruleCharOutOfRepertoire(ctx, { 莆田IPA: 'k∣a' }), [])
}

// R2 confusable_substitution
{
  const hit = rules.ruleConfusables(ctx, { 莆田IPA: 'ka55' })
  assert.deepEqual(keysOf(hit), ['confusable_ascii_in_reading'])
  assert.equal(hit[0].params.hit_count, 1)
  assert.deepEqual(hit[0].params.suggestions[0], { found: 'U+0061', suggested: ['U+0251'] })
  // 拼音列用拉丁字母是方案本身规定的，不得报。
  assert.deepEqual(rules.ruleConfusables(ctx, { 拼音: 'ka55' }), [])
  // 用了真正的 ɑ 也不得报。
  assert.deepEqual(rules.ruleConfusables(ctx, { 莆田IPA: 'kɑ55' }), [])
  // 一格里两个 a 只出一条 finding，但列出两个位置。
  const twice = rules.ruleConfusables(ctx, { 仙游IPA: 'pasa' })
  assert.equal(twice.length, 1)
  assert.deepEqual(twice[0].params.positions, [2, 4])
}

// R6 reading_format_invalid
{
  const flat = rules.ruleReadingFormat(ctx, { 莆田IPA: 'ua5333' })
  assert.deepEqual(keysOf(flat), ['long_digit_run'])
  assert.equal(flat[0].severity, 'strong')
  assert.deepEqual(flat[0].params.runs, ['5333'])
  // 合法长调值 533 / 453 不报；单位调号不报。
  assert.deepEqual(rules.ruleReadingFormat(ctx, { 莆田IPA: 'ua533' }), [])
  assert.deepEqual(rules.ruleReadingFormat(ctx, { 莆田IPA: 'oa453' }), [])
  assert.deepEqual(rules.ruleReadingFormat(ctx, { 莆田IPA: 'a2' }), [])
  // 边界：缺字占位符 @20000 带五位数字串，那是登记序号不是压平声调。
  assert.deepEqual(rules.ruleReadingFormat(ctx, { 莆田IPA: 'a@20000' }), [])
  // 55 是两位调值，不触发 long_digit_run；只该报两列调号数量不等。
  const mismatch = rules.ruleReadingFormat(ctx, { 拼音: 'ka1', 莆田IPA: 'kʰa55' })
  assert.deepEqual(keysOf(mismatch), ['tone_token_count_differs'])
  assert.deepEqual(mismatch[0].params, { pinyin_count: 1, ipa_count: 2 })
  // 缺列不猜：只有拼音列时不报调号数量不等。
  assert.deepEqual(rules.ruleReadingFormat(ctx, { 拼音: 'ka1' }), [])
}

// R3 格级组合符 + 列级编码形式
{
  // NFD 写法（a + U+0303）才带组合符；预合成的 ã (U+00E3) 一个都不带。
  // 这条区分正是 R3 存在的全部理由，所以两种写法都要断言，不能只测一边。
  const marks = rules.ruleCombiningMarks(ctx, { 莆田IPA: 'a\u0303' })
  assert.deepEqual(keysOf(marks), ['combining_marks_present'])
  assert.equal(marks[0].severity, 'info')
  assert.deepEqual(marks[0].params.marks, ['U+0303'])
  assert.deepEqual(rules.ruleCombiningMarks(ctx, { 莆田IPA: '\u00e3' }), [])
  assert.deepEqual(rules.ruleCombiningMarks(ctx, { 莆田IPA: 'ka' }), [])
  assert.deepEqual(rules.ruleCombiningMarks(ctx, { 释义: 'a\u0303' }), [])
  // 只有真正带「形式之差」的值才算数：'ka' 既属 NFC 又属 NFD，是形式中性的，
  // 不能拿它充当 NFC 样本（否则整列中性值也会被误判成一种形式）。
  const nfc = '\u00e3'                  // 预合成 ã
  const nfd = '\u0061\u0303'           // a + 组合鼻化符
  assert.notEqual(nfc, nfd)
  const mixed = rules.ruleColumnForms({ 仙游IPA: [nfc, nfd, nfd, nfd] })
  assert.deepEqual(keysOf(mixed), ['mixed_normalization_forms'])
  assert.equal(mixed[0].params.minority, 'nfc')
  assert.deepEqual(mixed[0].params.nfc, 1)
  assert.deepEqual(mixed[0].params.nfd, 3)
  // 全列同形不报。
  assert.deepEqual(rules.ruleColumnForms({ 仙游IPA: [nfc, nfc] }), [])
  // 中性值 + 单一形式也不报：只有两种形式真的并存才算异常。
  assert.deepEqual(rules.ruleColumnForms({ 仙游IPA: ['ka', nfd, nfd] }), [])
}

// R4 punctuation_mix
{
  const mixed = rules.rulePunctuationMix({ 释义: ['甲（乙）', '丙(丁)'] })
  assert.deepEqual(keysOf(mixed), ['punctuation_width_mixed_in_column'])
  assert.deepEqual(mixed[0].params.pairs[0], { full: 'U+FF08', half: 'U+0028' })
  assert.deepEqual(rules.rulePunctuationMix({ 释义: ['甲（乙）', '丙（丁）'] }), [])
}

// R5 missing_field：无角色必须安全跳过（#170 未落地时的真实状态）
{
  assert.deepEqual(rules.ruleMissingField(ctx, { 词条: '甲', 释义: '' }), [])
  assert.deepEqual(rules.ruleMissingField(rules.makeContext({ roles: {} }), { 词条: '甲' }), [])
  const roleCtx = rules.makeContext({ roles: { 词条: 'headword', 释义: 'meaning', 拼音: 'reading' } })
  const hit = rules.ruleMissingField(roleCtx, { 词条: '甲', 释义: '', 拼音: 'ka1' })
  assert.deepEqual(keysOf(hit), ['required_role_field_empty'])
  assert.equal(hit[0].field, '释义')
  assert.equal(hit[0].severity, 'strong')
  // 非必填角色（region）空着不报。
  assert.deepEqual(rules.ruleMissingField(rules.makeContext({ roles: { 地区: 'region' } }), { 地区: '' }), [])
}

// R7 page_outlier：两个判据各自的阈值都要先达标才报
{
  const monotonic = Array.from({ length: 30 }, (_, i) => ({ order: i + 1, pdfPage: Math.ceil((i + 1) / 2) }))
  assert.deepEqual(rules.rulePageOrderBacktrack(monotonic), [])
  const back = rules.rulePageOrderBacktrack([
    { order: 1, pdfPage: 40 }, { order: 2, pdfPage: 12 }
  ])
  assert.deepEqual(keysOf(back), ['pdf_page_backtrack'])
  assert.equal(back[0].params.backtrack, 28)
  // 容差内（回退 1 页）不报——这是 R7 的边界，不是实现细节。
  assert.deepEqual(rules.rulePageOrderBacktrack([{ order: 1, pdfPage: 12 }, { order: 2, pdfPage: 11 }]), [])
  // 样本不足 20 页时密度判据必须沉默，不给假数字。
  const thin = Array.from({ length: 10 }, (_, i) => ({ order: i + 1, pdfPage: 1 }))
  assert.deepEqual(rules.rulePageDensityOutliers(thin), [])
  const dense = []
  for (let page = 1; page <= 24; page += 1) {
    const count = page === 7 ? 30 : 6
    for (let i = 0; i < count; i += 1) dense.push({ order: dense.length + 1, pdfPage: page })
  }
  const outliers = rules.rulePageDensityOutliers(dense)
  assert.deepEqual(keysOf(outliers), ['page_entry_count_outlier'])
  assert.equal(outliers[0].params.entries_on_page, 30)
  assert.equal(outliers[0].params.median_entries, 6)
  assert.deepEqual(rules.rulePageDensityOutliers(
    Array.from({ length: 144 }, (_, i) => ({ order: i + 1, pdfPage: Math.floor(i / 6) + 1 }))), [])
}

// runProjectRules 的挂靠：每条返回值都必须带着**它自己那条目**的 id。
// 上一版签名是 (ctx, rows, columns, entries)，摊平后 finding 里没有任何条目标识，
// 写入端只能一律挂到项目第一条上——于是第 2 条的原样内容片段发给了第 1 条的校对员，
// 而第 2、3 条自己的 hints 变成空（#208 评审阻断 1）。这段不起服务器就能钉住那个形状：
// 只要挂靠再塌回第一条，P1 的空断言与 P2/P3 的等值断言会同时红。
{
  const nfc = 'tʰĩ1'                      // 预合成 ĩ：NFC 样本
  const nfd = 'thin\u0301'                // n + 组合锐音符：同列的 NFD 样本
  const entries = [
    { pageId: 'P1', order: 1, pdfPage: 10, row: { 词条: '天', 拼音: 'thin1', 莆田IPA: nfc, 释义: '天空（京）' } },
    { pageId: 'P2', order: 2, pdfPage: 30, row: { 词条: '甲', 拼音: 'ka1', 莆田IPA: nfd, 释义: '第一(个)' } },
    { pageId: 'P3', order: 3, pdfPage: 12, row: { 词条: '鸭', 拼音: 'ah7', 莆田IPA: 'kaʔ7', 释义: '家禽' } }
  ]
  const out = rules.runProjectRules(ctx, entries)
  assert.ok(out.length > 0, 'fixture must actually produce findings')
  const anchors = [rules.ANCHOR_ENTRY, rules.ANCHOR_COLUMN, rules.ANCHOR_PDF_PAGE]
  for (const item of out) {
    assert.ok(anchors.includes(item.evidence.anchor), JSON.stringify(item.evidence))
    assert.ok(entries.some((entry) => entry.pageId === item.page),
      `finding 挂到了不存在的条目：${JSON.stringify({ m: item.message_key, page: item.page })}`)
  }
  // 逐条规则必须各归各条目：期望值由 runPageRules 现算，不在测试里另写一套。
  const rowScoped = (pageId) => keysOf(out.filter((item) =>
    item.page === pageId && item.evidence.anchor === rules.ANCHOR_ENTRY))
  for (const entry of entries) {
    assert.deepEqual(rowScoped(entry.pageId), keysOf(rules.runPageRules(ctx, entry.row)),
      `row findings of ${entry.pageId}`)
  }
  // 列级与页级疑点的挂靠口径（docs/plans/2026-09-25-assist-rules.md §挂靠）：
  // 列级挂扫描顺序第一条并带 anchor 标记；R7 挂该 PDF 页的第一个条目。
  const columnItems = out.filter((item) => item.evidence.anchor === rules.ANCHOR_COLUMN)
  assert.deepEqual(columnItems.map((item) => item.message_key).sort(),
    ['mixed_normalization_forms', 'punctuation_width_mixed_in_column'],
    JSON.stringify(columnItems.map((item) => item.message_key)))
  // 单条重算靠 PROJECT_ONLY_MESSAGE_KEYS 排除项目级疑点，所以"非格级 anchor 的 key"
  // 必须恰好等于它，而"格级 anchor 的 key"必须恰好等于 CELL_MESSAGE_KEYS：
  // 两份清单要正好划分引擎产出的全部 key，新增规则漏归类就在这里红。
  const anchoredKeys = (scope) => [...new Set(out.filter((item) =>
    item.evidence.anchor === scope).map((item) => item.message_key))].sort()
  // 分类守卫以**源码产出的 key 集合**为基准，不拿"这份 fixture 触发到什么"当基准：
  // 三条目的 fixture 触发不了 page_entry_count_outlier（密度判据要 ≥20 页），
  // 用观测集合做基准会把"没触发"误判成"清单错了"，也会让漏归类的 key 蒙混过去。
  const rulesSource = readFileSync(new URL('../pb_hooks/lib/assist_rules.js', import.meta.url), 'utf8')
  const emittedKeys = [...new Set([...rulesSource.matchAll(
    /finding\(\s*"[a-z_]+"\s*,\s*"[a-z]+"\s*,[^,]+,\s*"([a-z_]+)"/g)].map((m) => m[1]))].sort()
  assert.ok(emittedKeys.length >= 9, `从源码抽出的 key 太少，先怀疑正则：${JSON.stringify(emittedKeys)}`)
  assert.deepEqual(emittedKeys,
    [...new Set([...rules.CELL_MESSAGE_KEYS, ...rules.PROJECT_ONLY_MESSAGE_KEYS])].sort(),
    '引擎产出的 key 必须被格级/项目级两份清单恰好划分，既不能漏也不能多')
  assert.deepEqual(rules.CELL_MESSAGE_KEYS.filter((key) => rules.PROJECT_ONLY_MESSAGE_KEYS.includes(key)), [],
    '两份清单不得重叠')
  // 挂靠方向只断言子集：观测到的 key 必须落在它该落的那份清单里。
  for (const scope of [rules.ANCHOR_COLUMN, rules.ANCHOR_PDF_PAGE]) {
    for (const key of anchoredKeys(scope)) {
      assert.ok(rules.PROJECT_ONLY_MESSAGE_KEYS.includes(key), `${scope} 挂靠的 ${key} 不在项目级清单里`)
    }
  }
  for (const key of anchoredKeys(rules.ANCHOR_ENTRY)) {
    assert.ok(rules.CELL_MESSAGE_KEYS.includes(key), `格级挂靠的 ${key} 不在 CELL 清单里`)
  }
  // 反向也要有：两份清单里若出现源码根本不产的 key（改名/删规则后的残留），必须红。
  for (const key of [...rules.CELL_MESSAGE_KEYS, ...rules.PROJECT_ONLY_MESSAGE_KEYS]) {
    assert.ok(emittedKeys.includes(key), `清单里的 ${key} 已不是引擎产出的 key`)
  }
  // 漏归类在 runProjectRules 里直接抛错，这一段证明确实会抛（不抛就是静默少一条排除项，
  // 症状出现在别处：项目级疑点被单条重算吃掉）。导出的数组与模块内是同一个对象，所以
  // 这里临时摘掉一项就能复现"新增规则忘了登记"，测完必须放回。
  const digitRow = { 词条: '甲', 拼音: 'ka1', 莆田IPA: 'ua5333', 释义: '第一（个）' }
  assert.ok(rules.runPageRules(ctx, digitRow).some((item) => item.message_key === 'long_digit_run'),
    '样本行必须真的产 long_digit_run，否则下面这段是空转')
  const cellKeys = rules.CELL_MESSAGE_KEYS
  const registeredAt = cellKeys.indexOf('long_digit_run')
  const removed = cellKeys.splice(registeredAt, 1)
  assert.deepEqual(removed, ['long_digit_run'], 'CELL 清单里应当有 long_digit_run')
  try {
    assert.throws(() => rules.runProjectRules(ctx, [{ pageId: 'P1', order: 1, pdfPage: 1, row: digitRow }]),
      /未归类/, '未归类的格级 key 必须让 runProjectRules 抛错')
  } finally {
    cellKeys.splice(registeredAt, 0, ...removed)
  }
  assert.deepEqual(cellKeys[registeredAt], 'long_digit_run', '这段守卫自己不许把清单改坏')
  for (const item of columnItems) {
    assert.equal(item.page, 'P1', '列级疑点必须挂在第一条目上')
    // 列级 params 只允许计数与码位标签：它挂在无辜的条目上，绝不能带原样内容片段。
    assert.deepEqual(Object.keys(item.params).sort(),
      item.message_key === 'mixed_normalization_forms' ? ['minority', 'nfc', 'nfd'] : ['pair_count', 'pairs'],
      JSON.stringify(item.params))
    for (const value of Object.values(item.params)) {
      assert.doesNotMatch(JSON.stringify(value), /[^\x20-\x7e]/,
        `列级 params 混进了非 ASCII 字符（原样内容片段）：${JSON.stringify(value)}`)
    }
    // 直接钉住 #175 红线 1 的形状：任何条目的原样单元格内容都不许出现在 params 里。
    for (const entry of entries) {
      for (const value of Object.values(entry.row)) {
        if (!value || /^[\x20-\x7e]*$/.test(value)) continue
        assert.ok(!JSON.stringify(item.params).includes(String(value)),
          `params 泄漏了 ${entry.pageId} 的原样内容：${item.message_key}`)
      }
    }
  }
  const backtracked = out.filter((item) => item.message_key === 'pdf_page_backtrack')
  assert.equal(backtracked.length, 1, JSON.stringify(out.map((item) => item.message_key)))
  assert.equal(backtracked[0].page, 'P3', 'R7 疑点要挂在回退到的那一页（P3 的 pdf_page=12）上')
  assert.equal(backtracked[0].evidence.anchor, rules.ANCHOR_PDF_PAGE)
  assert.equal(backtracked[0].evidence.page, 12, 'evidence.page 仍然是 PDF 页号')
}

// 下线旧批次也必须一块接一块读完。一次读满上限就停是 #208 评审阻断 2 的镜像形状：
// 没被下线的行会永远以「当前批次」的身份留在库里，也就是旧疑点再也撤不下来。
// 上限在本项目的口径下是可及的（保险丝允许 5 万条目，实测 10k 条目产 2.9 万条疑点），
// 所以这不是假想场景。fake dao 在这里模拟 SQL 语义：结果集只含尚未下线的行、
// offset 越过的是本轮决定保留的那些行。
{
  const mkRecord = (id, stamp) => ({
    id,
    superseded: '',
    set(key, value) { if (key === 'superseded_at') this.superseded = String(value) },
    getString(key) { return key === 'produced_at' ? stamp : '' }
  })
  const run = (count, stampOf) => {
    const records = Array.from({ length: count }, (_, i) => mkRecord(`r${i}`, stampOf(i)))
    let reads = 0
    let writes = 0
    const dao = {
      findRecordsByFilter: (collection, filter, sort, limit, offset) => {
        reads += 1
        const current = records.filter((record) => record.superseded === '')
        return current.slice(offset, offset + limit)
      },
      save: () => { writes += 1 }
    }
    return { records, dao, stats: () => ({ reads, writes }) }
  }

  const all = run(5, () => '2026-09-25 00:00:00.001Z')
  const retiredAll = writer.retire(all.dao, null, ['producer = "rule"'], () => true, 'STAMP', { chunk: 2 })
  assert.equal(retiredAll, 5, `五份当前批次必须全部下线，实际 ${retiredAll}`)
  assert.deepEqual(all.records.filter((record) => record.superseded === '').map((record) => record.id), [],
    '不得有行留在当前批次里')
  assert.ok(all.stats().reads >= 3, `chunk=2 时至少要读三块，只读一块就是原来的静默截断：${JSON.stringify(all.stats())}`)
  assert.equal(all.stats().writes, 5, '每行只写一次')

  // 保留最新一批的那条（settleBatch 的形状）：offset 必须按"保留数"前进，否则死循环或漏行。
  const mixed = run(5, (i) => `2026-09-25 00:00:00.00${i}Z`)
  const retiredOld = writer.retire(mixed.dao, null, ['producer = "rule"'],
    (record) => record.getString('produced_at') < '2026-09-25 00:00:00.004Z', 'STAMP', { chunk: 2 })
  assert.equal(retiredOld, 4, `只该下线比它更早的四批：${retiredOld}`)
  assert.equal(mixed.records[4].superseded, '', '最新一批必须留着')
  assert.deepEqual(mixed.records.filter((record) => record.superseded === '').map((record) => record.id), ['r4'])
  assert.ok(mixed.stats().reads < 10, `读取轮数失控（疑似死循环）：${JSON.stringify(mixed.stats())}`)

  // 空作用域：一轮就返回，不做无谓的第二次读。
  const none = run(0, () => 'x')
  assert.equal(writer.retire(none.dao, null, [], () => true, 'STAMP', { chunk: 2 }), 0)
  assert.equal(none.stats().reads, 1)
}

// 全量重算的条目游标：必须翻完整批，超限必须在**任何写入之前**退出。
// 上一版是 PAGE_SCAN_CAP = 5000 的一次性读取 + 按 project 全量下线，第 5001 条往后的
// 当前批次被标 superseded 却没有新批次替换，那些条目从此永久读不到疑点（#208 评审阻断 2）。
{
  const total = 7
  const all = Array.from({ length: total }, (_, i) => ({ id: `pg${i}` }))
  const dao = {
    findRecordsByFilter: (collection, filter, sort, limit, offset) =>
      collection === 'pages' ? all.slice(offset, offset + limit) : (() => { throw new Error(`unexpected ${collection}`) })()
  }
  assert.deepEqual(writer.loadAllPages(dao, 'proj', { chunk: 3 }).map((page) => page.id),
    all.map((page) => page.id), '游标必须按同一顺序翻完全部条目')
  assert.deepEqual(writer.loadAllPages(dao, 'proj', { chunk: total }).map((page) => page.id),
    all.map((page) => page.id), '整批一次读完时也不能漏条目')
  assert.deepEqual(writer.loadAllPages(dao, 'proj', { chunk: 1 }).map((page) => page.id),
    all.map((page) => page.id), 'chunk=1 是游标最容易露馅的形状')
  assert.throws(() => writer.loadAllPages(dao, 'proj', { chunk: 3, refusal: 4 }), /保险丝/)
  assert.ok(writer.PROJECT_SCAN_REFUSAL >= 10000,
    `保险丝必须容得下 #178 验收的 10k 行项目：${writer.PROJECT_SCAN_REFUSAL}`)
  // 保险丝还得真的"约束内存"，不能只是"最后拒算"：数一数抛错之前 dao 交出了多少行。
  // 上面那条 /保险丝/ 断言在"读全再判"的实现下同样会绿——它测的是会不会拒算，
  // 掉的是拒算前读了多少行，而那正是唯一会变的一维（#212 复审阻断）。
  const counted = (total) => {
    const handed = { rows: 0 }
    const rows = Array.from({ length: total }, (_, i) => ({ id: `q${i}` }))
    return {
      handed,
      dao: {
        findRecordsByFilter: (collection, filter, sort, limit, offset) => {
          const slice = collection === 'pages' ? rows.slice(offset, offset + limit) : []
          handed.rows += slice.length
          return slice
        }
      }
    }
  }
  const oversize = counted(20)
  assert.throws(() => writer.loadAllPages(oversize.dao, 'proj', { chunk: 3, refusal: 4 }), /保险丝/)
  assert.ok(oversize.handed.rows <= 4 + 3,
    `拒算前已读出 ${oversize.handed.rows} 行，保险丝没约束住内存（上限应是 refusal + chunk）`)
  // 计数器自己也必须被证明在数：同一份 dao 读全时恰好 20 行，否则上面那条是恒真的。
  const readWhole = counted(20)
  assert.equal(writer.loadAllPages(readWhole.dao, 'proj', { chunk: 3, refusal: 999 }).length, 20)
  assert.equal(readWhole.handed.rows, 20, `计数器没数到真实读取行数：${readWhole.handed.rows}`)
  // 「超限不会写坏数据」靠的是代码顺序：扫描必须先于第一次写。读源码钉住这个顺序，
  // 因为把 supersede 挪到扫描之前以后，任何黑盒断言都要先造出 5 万条目才看得见。
  const writerSource = readFileSync(new URL('../pb_hooks/lib/assist_writer.js', import.meta.url), 'utf8')
  const start = writerSource.indexOf('function recomputeProject(')
  assert.ok(start >= 0, 'assist_writer.js 里找不到 recomputeProject')
  const projectBody = writerSource.slice(start, writerSource.indexOf('\n}\n', start))
  const scanAt = projectBody.indexOf('loadAllPages(dao, projectId)')
  const firstWrite = Math.min(projectBody.indexOf('supersede('), projectBody.indexOf('insertFinding('))
  assert.ok(scanAt >= 0, 'recomputeProject 必须用分批游标读条目，不能有硬上限')
  assert.ok(firstWrite > scanAt, `第一次写必须晚于整批扫描：scan@${scanAt} firstWrite@${firstWrite}`)
}

// 已知取舍（不是 bug，但必须写下来）：R1 的放行集合是「启用键盘字符 ∪ 固定区段」，
// 而 IPA 调号字母 U+02E5..U+02E9（˥˦˧˨˩）既不在莆仙键盘里、也不在放行区段里。
// 莆仙三套方案用数字标调，所以今天这是正确行为；一旦项目改用调号字母记音，
// R1 会把每一条都报成集外字符——届时改的是这里的区段，不是去关掉规则。
{
  const toneLetter = rules.ruleCharOutOfRepertoire(ctx, { 莆田IPA: 'la\u02e5' })
  assert.deepEqual(keysOf(toneLetter), ['non_ipa_range_codepoints'])
  assert.deepEqual(toneLetter[0].params.codepoints, ['U+02E5'])
}

// 反向用例：一批"正常莆仙条目"（含鼻化 ɒ̃、Ǿ、ʔ、数字调号、合法占位符）
// 不得产生任何 R1/R2 命中——#177 的验收要求，误报数在下面量化打印。
{
  const normal = [
    { 词条: '人', 拼音: 'lang2', 莆田IPA: 'lɑŋ2', 仙游IPA: 'lyŋ2', 释义: '人类' },
    { 词条: '天', 拼音: 'thin1', 莆田IPA: 'tʰĩ1', 仙游IPA: 'tʰĩ1', 释义: '天空' },
    // 低元音在莆仙 IPA 里写作 ɑ（U+0251），这正是键盘 hint 存在的原因；
    // 用 ASCII a 会被 R2 命中，那是命中不是误报。
    { 词条: '鸭', 拼音: 'ah7', 莆田IPA: 'ɑʔ7', 仙游IPA: 'ɑʔ7', 释义: '家禽' },
    { 词条: '火', 拼音: 'he2', 莆田IPA: 'hɔ̃53', 仙游IPA: 'he53', 释义: '火焰' },
    { 词条: '雨', 拼音: 'hy3', 莆田IPA: 'hy21', 仙游IPA: 'hɔ̃21', 释义: '降水' },
    { 词条: '黄', 拼音: 'huang2', 莆田IPA: 'huɑŋ533', 仙游IPA: 'hɔŋ533', 释义: '颜色', 备注: '@20000' },
    { 词条: '四', 拼音: 'si4', 莆田IPA: 'sɨ453', 仙游IPA: 'sɨ453', 释义: '数目' },
    // #177 验收点名的三个字符：ɒ̃（组合鼻化）、Ǿ、ʔ。
    { 词条: '花', 拼音: 'ue1', 莆田IPA: 'huɒ̃533', 仙游IPA: 'huǾ533', 释义: '植物', 备注: '带ʔ尾' }
  ]
  const flagged = []
  for (const row of normal) {
    flagged.push(...rules.ruleCharOutOfRepertoire(ctx, row), ...rules.ruleConfusables(ctx, row))
  }
  console.log(`ASSIST_FP_RATE ${JSON.stringify({
    normal_rows: normal.length,
    r1_r2_findings: flagged.length,
    keys: keysOf(flagged)
  })}`)
  assert.deepEqual(flagged, [], `false positives on normal entries: ${JSON.stringify(flagged)}`)
}

console.log('PASS: assist rules unit matrix')

// ===================== 服务端部分：写入、门控联动、只标同生产者、耗时 =====================

async function createUser(label) {
  const email = `${label}-${suffix}@example.com`
  const user = await request('/api/collections/users/records', {
    method: 'POST', token: superAuth.token, body: { email, password, passwordConfirm: password, name: label, role: 'user' }
  })
  userIds.push(user.id)
  const auth = await request('/api/collections/users/auth-with-password', { method: 'POST', body: { identity: email, password } })
  return { ...user, token: auth.token }
}

async function createProject(name, proofreaders, managers = []) {
  const project = await request('/api/fangji/projects', {
    method: 'POST', token: platformAuth.token, expected: 201, body: { name: `${name} ${suffix}` }
  })
  projectIds.push(project.id)
  for (const user of proofreaders) {
    await request(`/api/fangji/projects/${project.id}/members/${user.id}`, { method: 'PUT', token: platformAuth.token, body: { role: 'proofreader' } })
  }
  for (const user of managers) {
    await request(`/api/fangji/projects/${project.id}/members/${user.id}`, { method: 'PUT', token: platformAuth.token, body: { role: 'manager' } })
  }
  return project
}

async function createPage(projectId, pageNumber, row) {
  return request('/api/collections/pages/records', {
    method: 'POST', token: superAuth.token,
    body: {
      project: projectId, page_number: pageNumber, pdf_page: pageNumber,
      ocr_row_json: JSON.stringify(row), ocr_text: Object.values(row).join(' '),
      proofread_round: 1, mismatch_count: 0, status: 'pending'
    }
  })
}

async function setGate({ version = rules.RULES_VERSION, kind, messageKey, gate }) {
  const row = await request('/api/collections/assist_rule_gates/records', {
    method: 'POST', token: superAuth.token,
    body: { producer: 'rule', producer_version: version, kind, message_key: messageKey, gate, sample_n: 200, precision_hat: 0.95 }
  })
  gateIds.push(row.id)
  return row
}

const worker = await createUser('assist-worker')
const boss = await createUser('assist-manager')

try {
  const project = await createProject('Assist rules', [worker], [boss])
  // 行数据先命名，期望值由**纯函数**算出：写入路径必须忠实持久化规则输出，
  // 不许在断言里另写一套"我以为规则会报什么"。
  const trappedRow = { 词条: '甲', 拼音: 'ka1', 莆田IPA: 'ua5333', 仙游IPA: 'ka', 释义: '第一（个）测试' }
  const cleanRow = { 词条: '天', 拼音: 'thin1', 莆田IPA: 'tʰĩ1', 仙游IPA: 'tʰĩ1', 释义: '天空' }
  // 三行里必须有**非首条目**也产疑点，否则"其他条目为空"的断言恒真：上一版只有第 1 页
  // 产疑点，于是全项目疑点塌到第一条目上也照样全绿（#208 评审阻断 1 + 测试恒真那条）。
  // paged 行带四样：压平声调(格级 strong，数字串 9999 与 trapped 的 5333 可区分)、
  // NFD 写法(与 clean 的预合成 ĩ 构成列级 R3 的两种形式)、半角括号(与 trapped 的全角构成列级 R4)。
  const pagedRow = { 词条: '人', 拼音: 'lang2', 莆田IPA: 'kʰi\u03032', 仙游IPA: 'zuin9999', 释义: '人类(智人)' }
  const trapped = await createPage(project.id, 1, trappedRow)
  const clean = await createPage(project.id, 2, cleanRow)
  const paged = await createPage(project.id, 3, pagedRow)
  // 第 4 条刻意把 pdf_page 回退到 1：这会触发 R7 的 pdf_page_backtrack，并按挂靠口径
  // 挂在"该 PDF 页的第一个条目"= trapped 上。目的不是测 R7 本身（纯函数段测过），
  // 而是让"单条目重算会不会吃掉挂在 trapped 上的项目级疑点"在 API 层可观测——
  // 上一轮我只排除了列级两条，R7 照样被吃掉（#212 的评审抓到这条）。
  // 三列记音照抄 cleanRow：R2 的混淆表把 IPA 列里的 'a' 当成 ɑ，随手写个 'sai1' 就会
  // 给这条多出两格疑点，"它自己没有格级疑点"这个前提就没了。
  const backRow = { 词条: '山', 拼音: 'thin1', 莆田IPA: 'tʰĩ1', 仙游IPA: 'tʰĩ1', 释义: '山峰' }
  const backPage = await request('/api/collections/pages/records', {
    method: 'POST', token: superAuth.token,
    body: {
      project: project.id, page_number: 4, pdf_page: 1, ocr_row_json: JSON.stringify(backRow),
      ocr_text: Object.values(backRow).join(' '), proofread_round: 1, mismatch_count: 0, status: 'pending'
    }
  })
  const expectedFor = (row) => rules.runPageRules(ctx, row)
    .map((item) => `${item.kind}/${item.message_key}`).sort()
  assert.ok(expectedFor(trappedRow).length >= 4, 'trapped row must exercise several rules')
  assert.ok(expectedFor(pagedRow).length >= 1, 'non-first entry must produce its own findings')
  assert.deepEqual(expectedFor(cleanRow), [], 'clean row must be silent for the comparison to mean anything')
  // 第 4 条也要求"格级全静"，否则"R7 只挂在第一条上"这条断言会被它自己的格级疑点混脏。
  assert.deepEqual(expectedFor(backRow), [], 'backtracking row must be cell-silent')
  assert.deepEqual(expectedFor(trappedRow).filter((key) => key.endsWith('long_digit_run')),
    ['reading_format_invalid/long_digit_run'])
  assert.notDeepEqual(JSON.stringify(expectedFor(trappedRow)), JSON.stringify(expectedFor(pagedRow)),
    '两行的疑点集合必须可区分，否则挂错条目也测不出来')

  const recompute = await request(`/api/fangji/projects/${project.id}/findings/recompute`, { method: 'POST', token: boss.token })
  await request(`/api/fangji/projects/${project.id}/findings/recompute`, { method: 'POST', token: worker.token, expected: 403 })
  assert.deepEqual({
    pages: recompute.pages, unanchored: recompute.unanchored,
    superseded: recompute.superseded, settled: recompute.settled
  }, { pages: 4, unanchored: 0, superseded: 0, settled: 0 },
  '首次全量重算：扫完 4 条、无挂靠失败、无旧批次可下线或收尾')
  const managerView = await request(`/api/fangji/projects/${project.id}/findings`, { token: boss.token })
  const keyOf = (item) => `${item.kind}/${item.message.key}`
  const anchorOf = (item) => item.evidence?.anchor ?? ''
  const onEntry = (pageId) => managerView.items.filter((item) =>
    item.page === pageId && anchorOf(item) === rules.ANCHOR_ENTRY).map(keyOf).sort()
  // 逐条疑点各归各条目。这三条断言一起才叫可证伪：挂靠塌回第一条时，trapped 会多出
  // paged 的那份、paged 变空、clean 仍然空——前两条就会红。
  assert.deepEqual(onEntry(trapped.id), expectedFor(trappedRow), JSON.stringify(onEntry(trapped.id)))
  assert.deepEqual(onEntry(paged.id), expectedFor(pagedRow), JSON.stringify(onEntry(paged.id)))
  assert.deepEqual(onEntry(clean.id), [], `clean entry flagged: ${JSON.stringify(onEntry(clean.id))}`)
  const trappedKeys = onEntry(trapped.id)
  assert.ok(trappedKeys.includes('reading_format_invalid/long_digit_run'), JSON.stringify(trappedKeys))
  assert.ok(trappedKeys.includes('confusable_substitution/confusable_ascii_in_reading'), JSON.stringify(trappedKeys))
  assert.ok(trappedKeys.includes('char_out_of_repertoire/non_ipa_range_codepoints'), JSON.stringify(trappedKeys))
  // 干净条目一条都不该有——包括 info 级与列级挂靠，否则"零信号条目"这个前提就不成立了。
  assert.deepEqual(managerView.items.filter((item) => item.page === clean.id), [],
    `clean entry flagged: ${JSON.stringify(managerView.items.filter((item) => item.page === clean.id))}`)
  // 列级疑点的挂靠口径：只能落在扫描顺序第一条上（#176 规定 page 必填）。
  const columnItems = managerView.items.filter((item) => anchorOf(item) === rules.ANCHOR_COLUMN)
  assert.deepEqual(columnItems.map(keyOf).sort(),
    ['encoding_form_anomaly/mixed_normalization_forms', 'punctuation_mix/punctuation_width_mixed_in_column'],
    JSON.stringify(columnItems.map(keyOf)))
  for (const item of columnItems) {
    assert.equal(item.page, trapped.id, '列级疑点必须且只能挂在第一条目上')
  }
  assert.equal(managerView.items.filter((item) =>
    item.page !== trapped.id && anchorOf(item) === rules.ANCHOR_COLUMN).length, 0,
    '列级疑点只许出现在挂靠的那一条目上')
  assert.deepEqual(managerView.items.filter((item) =>
    ![rules.ANCHOR_ENTRY, rules.ANCHOR_COLUMN, rules.ANCHOR_PDF_PAGE].includes(anchorOf(item))), [],
    '每条落库的疑点都必须带挂靠口径')
  // #175 红线 1 的形状：任何一条疑点的 params 都不许带上别的条目的原样内容。
  const rowJson = { [trapped.id]: JSON.stringify(trappedRow), [clean.id]: JSON.stringify(cleanRow),
    [paged.id]: JSON.stringify(pagedRow), [backPage.id]: JSON.stringify(backRow) }
  const cellText = [trappedRow, cleanRow, pagedRow, backRow].flatMap((row) => Object.values(row))
    .filter((value) => !/^[\x20-\x7e]*$/.test(String(value)))
  for (const item of managerView.items) {
    const serialized = JSON.stringify(item.message.params)
    for (const value of cellText) {
      assert.ok(!serialized.includes(value), `${keyOf(item)} 的 params 带了原样内容片段`)
    }
    for (const run of item.message.params?.runs ?? []) {
      assert.ok((rowJson[item.page] ?? '').includes(run), `${keyOf(item)} 的 ${run} 不属于它挂靠的那一条`)
    }
  }
  for (const item of managerView.items) {
    assert.equal(item.producer, 'rule')
    assert.equal(item.producer_version, rules.RULES_VERSION)
    assert.equal(item.gate, 'off', '新规则必须一入库就对校对端不可见')
  }

  // 与 #176 联动：一条 gate 行都没有时，在手校对员也拿不到任何 hint。
  const claim = await request(`/api/fangji/projects/${project.id}/claim`, { method: 'POST', token: worker.token })
  assert.equal(claim.id, trapped.id)
  const beforeGate = await request(`/api/fangji/pages/${trapped.id}/findings`, { token: worker.token })
  assert.deepEqual(beforeGate.hints, [])

  await setGate({ kind: 'reading_format_invalid', messageKey: 'long_digit_run', gate: 'strong' })
  const afterGate = await request(`/api/fangji/pages/${trapped.id}/findings`, { token: worker.token })
  assert.deepEqual(afterGate.hints.map((hint) => hint.message.key), ['long_digit_run'])
  assert.equal(afterGate.hints[0].highlight, true)

  // 评审阻断 1 的后果第 1 层是「在手者拿到别人条目的疑点」，所以必须在**消费端**钉住：
  // 同一个 message_key、同一个 gate 下，两个读者各自只看到自己那一行的数字串。
  const pagedGate = await request(`/api/fangji/pages/${paged.id}/findings`, { token: boss.token })
  assert.deepEqual(pagedGate.hints.map((hint) => hint.message.key), ['long_digit_run'],
    JSON.stringify(pagedGate.hints.map((hint) => hint.message.key)))
  assert.deepEqual(pagedGate.hints[0].message.params.runs, ['9999'],
    `第 3 条的读者只能看到第 3 条自己的数字串：${JSON.stringify(pagedGate.hints[0].message.params)}`)
  assert.deepEqual(afterGate.hints[0].message.params.runs, ['5333'],
    '第 1 条的读者不能拿到第 3 条的内容')

  // 重算只下线同 producer 的旧批次：OCR(#125) 与 bundle_import(#124) 的行不能被动。
  const ocrRow = await request('/api/collections/review_findings/records', {
    method: 'POST', token: superAuth.token,
    body: {
      page: trapped.id, project: project.id, field_name: '莆田IPA', kind: 'merged_columns',
      severity: 'strong', message_key: 'column_collapse', params_json: '{}', evidence_json: '{}',
      producer: 'ocr', producer_version: 'ocr-v1', produced_at: '2026-09-01'
    }
  })
  const ruleRowsOf = async (pageId) => {
    const list = await request(`/api/collections/review_findings/records?perPage=200&sort=created&filter=${encodeURIComponent(`page = "${pageId}" && producer = "rule"`)}`, { token: superAuth.token })
    // 这个口子自己就会静默截断：并发重算一节要看的就是"到底留下了几份批次"，
    // 读口被 30 条默认分页挡住就会把重复看成"没有重复"。
    assert.equal(list.items.length, list.totalItems, `读取被分页截断：${list.items.length}/${list.totalItems}`)
    return list
  }
  const anchorOfRaw = (row) => JSON.parse(row.evidence_json || '{}').anchor ?? ''
  const current = (rows) => rows.filter((row) => row.superseded_at === '')
  const entryRows = (rows) => current(rows).filter((row) => anchorOfRaw(row) === rules.ANCHOR_ENTRY)
  const columnRows = (rows) => current(rows).filter((row) => anchorOfRaw(row) === rules.ANCHOR_COLUMN)
  const keysOfRaw = (rows) => rows.map((row) => `${row.kind}/${row.message_key}`).sort()
  const beforeRecompute = await ruleRowsOf(trapped.id)
  assert.deepEqual(keysOfRaw(entryRows(beforeRecompute.items)), expectedFor(trappedRow))
  assert.equal(columnRows(beforeRecompute.items).length, 2, '列级疑点此刻挂在第一条目上')
  await request(`/api/fangji/pages/${trapped.id}/findings/recompute`, { method: 'POST', token: worker.token })
  const afterRuleRows = await ruleRowsOf(trapped.id)
  const freshRuleRows = entryRows(afterRuleRows.items)
  assert.deepEqual(keysOfRaw(freshRuleRows), expectedFor(trappedRow),
    '重算后应当只剩一份当前批次')
  // 单条重算判定不了列级规则，所以它不得顺手抹掉挂在这一条身上的列级疑点：
  // 那些只有项目级重算会重新产出，被抹掉就是静默永久丢失。
  assert.equal(columnRows(afterRuleRows.items).length, 2, '单条重算必须保留列级疑点')
  // R7 的页级疑点也挂在 trapped 上（pdf_page=1 的第一条），单条重算同样不许吃掉它。
  const pageLevelOf = (rows) => current(rows).filter((row) =>
    anchorOfRaw(row) === rules.ANCHOR_PDF_PAGE)
  assert.deepEqual(pageLevelOf(beforeRecompute.items).map((row) => row.message_key), ['pdf_page_backtrack'],
    `全量重算后 trapped 上该有一条页级疑点：${JSON.stringify(beforeRecompute.items.map((r) => [r.message_key, anchorOfRaw(r)]))}`)
  assert.deepEqual(pageLevelOf(afterRuleRows.items).map((row) => row.message_key), ['pdf_page_backtrack'],
    '单条目重算不得吃掉挂在它身上的页级(R7)疑点——它判定不了整页，只有项目重算会再产出')
  const backRows = await ruleRowsOf(backPage.id)
  assert.deepEqual(keysOfRaw(entryRows(backRows.items)), expectedFor(backRow),
    '回退那条的格级疑点各归各条目')
  assert.deepEqual(pageLevelOf(backRows.items).map((row) => row.message_key), [],
    '页级(R7)疑点挂在 pdf_page 的第一条目上，不该分到回退那条自己')
  assert.ok(afterRuleRows.items.filter((row) => row.superseded_at !== '').length >= expectedFor(trappedRow).length,
    '旧批次必须留在库里')
  assert.ok(freshRuleRows.every((row) => row.produced_at !== ''))
  const ocrAfter = await request(`/api/collections/review_findings/records/${ocrRow.id}`, { token: superAuth.token })
  assert.equal(ocrAfter.superseded_at, '', '规则重算不得下线 OCR 生产者的疑点')
  const ruleFinding = freshRuleRows.find((row) => row.message_key === 'long_digit_run')
  assert.equal(ruleFinding.severity, 'strong')

  // 同一条目上的并发重算：可观测结果必须仍然是"一份当前批次"。
  // 上一轮的非阻断项——两边的下线都发生在插入之前，交错时会留下两份批次（hint 成倍重复）。
  // 插入后按 produced_at 收敛（retainNewestBatch）让结论与交错顺序无关。
  const concurrent = await Promise.all(Array.from({ length: 8 }, () =>
    request(`/api/fangji/pages/${trapped.id}/findings/recompute`, { method: 'POST', token: boss.token })))
  assert.equal(concurrent.length, 8, '并发重算请求不得有失败')
  const raced = await ruleRowsOf(trapped.id)
  const currentEntry = entryRows(raced.items)
  const currentSet = [...new Set(currentEntry.map((row) => `${row.kind}/${row.message_key}`))].sort()
  const expectedSet = [...new Set(expectedFor(trappedRow))].sort()
  // 校对端可见的疑点集合必须与规则算出来的一致：不缺席（残缺批次会让某个 key 彻底消失），
  // 也不多出一个规则根本不产的东西。这是并发交错下唯一稳定成立的不变量——
  // "恰好一份批次"在 JSVM 让出运行时的 DAO 调用点上不成立（见 assist_writer.js 的收尾注释）。
  assert.deepEqual(currentSet, expectedSet,
    `并发重算后的当前批次：${JSON.stringify({ current: currentEntry.map((row) => [row.message_key, row.produced_at]), expected: expectedSet })}`)
  // 库里至少留着一份完整的批次（同毫秒的几批可以并存，那是重复不是丢信号）。
  const batches = new Map()
  for (const row of currentEntry) batches.set(row.produced_at, [...(batches.get(row.produced_at) ?? []), row])
  const largest = Math.max(...[...batches.values()].map((rows) => rows.length))
  // 重复量只打印不断言：`produced_at` 是 #176 schema 里唯一的批次标记，同一毫秒开始的
  // 几批在数据上无法区分（实测见 docs/plans/2026-09-25-assist-rules.md §4）。
  // 把「不许重复」写成断言要么逼出 #176 的 schema 改动，要么让这个测试随时序飘红。
  console.log(`ASSIST_CONCURRENCY ${JSON.stringify({
    requests: concurrent.length, current_rows: currentEntry.length,
    distinct_keys: currentSet.length, distinct_batches: batches.size,
    largest_batch: largest, repeat_factor: Number((currentEntry.length / currentSet.length).toFixed(2))
  })}`)
  assert.ok([...batches.values()].some((rows) =>
    [...new Set(rows.map((row) => `${row.kind}/${row.message_key}`))].sort().join() === expectedSet.join()),
    `当前批次里没有一份是完整的：${JSON.stringify([...batches.keys()])}`)
  assert.equal(columnRows(raced.items).length, 2, '并发重算同样不得波及列级疑点')
  assert.ok(raced.totalItems > expectedFor(trappedRow).length + 2 + 5,
    `8 次并发重算应当在库里留下多份历史批次（否则这个测试没测到交错）：${raced.totalItems}`)
  assert.equal(columnRows(raced.items).length, 2, '并发重算同样不得波及列级疑点')

  // 提交路径：刚提交的那一行要立刻参与判定，而不是等全量重算。
  const submit = await request(`/api/fangji/pages/${trapped.id}/submit`, {
    method: 'POST', token: worker.token,
    body: {
      rowJson: JSON.stringify({ 词条: '甲', 拼音: 'ka1', 莆田IPA: 'ua9999', 仙游IPA: 'ka', 释义: '第一（个）测试' }),
      text: '甲 ka1', leaseToken: claim.leaseToken
    }
  })
  assert.ok(submit)
  const submitted = await request(`/api/collections/review_findings/records?filter=${encodeURIComponent(`page = "${trapped.id}" && producer = "rule" && superseded_at = ""`)}`, { token: superAuth.token })
  const runs = submitted.items.filter((row) => row.message_key === 'long_digit_run')
  assert.equal(runs.length, 1)
  assert.deepEqual(JSON.parse(runs[0].params_json).runs, ['9999'], '应对刚提交的行重算，而不是导入原文')

  // p95：三种形状都要量（静默行、单疑点行、多疑点行，含真实的下线 + 插入）。
  // 上一轮只测了静默行，那个数字不代表提交路径。
  //
  // 50 ms 这条**不当 CI 断言**：计时含 HTTP 往返与 runner 调度，同一份代码在 GitHub 上
  // 两次跑出 p95 = 11 ms 和 52 ms（见 docs/plans/2026-09-25-assist-rules.md §5），当门禁
  // 就是一支随时会红的旗。#177 验收第 70 行的原话是"p95 < 50 ms，日志或测试记录为证"，
  // 所以这里打印 ASSIST_P95 作为记录、只留一条灾难线（结构性回退会到秒级：整项目重扫、
  // N+1、两两全比都在这个量级），50 ms 由人对着打印数字核。
  const PERF_DISASTER_MS = 500
  const timed = async (label, pageId, findings) => {
    const durations = []
    for (let i = 0; i < 30; i += 1) {
      const startedAt = Date.now()
      await request(`/api/fangji/pages/${pageId}/findings/recompute`, { method: 'POST', token: boss.token })
      durations.push(Date.now() - startedAt)
    }
    durations.sort((a, b) => a - b)
    const p95 = durations[Math.floor(durations.length * 0.95) - 1]
    console.log(`ASSIST_P95 ${JSON.stringify({
      case: label, findings, samples: durations.length,
      p50: durations[Math.floor(durations.length / 2)], p95, max: durations[durations.length - 1],
      acceptance_budget_ms: 50, disaster_gate_ms: PERF_DISASTER_MS
    })}`)
    assert.ok(p95 < PERF_DISASTER_MS,
      `${label} 单条重算 p95 = ${p95} ms，超过灾难线 ${PERF_DISASTER_MS} ms（提交路径被改成整项目扫描级别的开销）`)
    return p95
  }
  await timed('silent_row', clean.id, 0)
  await timed('one_finding', paged.id, expectedFor(pagedRow).length)
  const busy = await timed('many_findings', trapped.id, expectedFor(trappedRow).length)
  assert.ok(busy > 0, '计时必须真的走过 HTTP 往返，不能恒为 0')

  console.log('Assist rules integration test passed.')
} finally {
  for (const id of gateIds.reverse()) {
    await request(`/api/collections/assist_rule_gates/records/${id}`, { method: 'DELETE', token: superAuth.token, expected: 204 })
  }
  for (const projectId of projectIds.reverse()) {
    await request(`/api/fangji/projects/${projectId}`, { method: 'DELETE', token: platformAuth.token, expected: 204 })
  }
  for (const userId of userIds.reverse()) {
    await request(`/api/collections/users/records/${userId}`, { method: 'DELETE', token: superAuth.token, expected: 204 })
  }
}
