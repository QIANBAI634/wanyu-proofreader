import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const identity = require('../pb_hooks/lib/assist_identity.js')
const rules = require('../pb_hooks/lib/assist_rules.js')
// 挂靠口径的词表由 assist_rules.js 拥有（#208 那边所有疑点都过 anchored()）。#178 也要求
// 每条疑点带 anchor，两边的字面量必须是同一个值，否则改名会各自漂移而谁都不红。
assert.equal(identity.ANCHOR_ENTRY, rules.ANCHOR_ENTRY,
  'anchor 词表漂移：assist_identity 与 assist_rules 的 ANCHOR_ENTRY 不再是同一个值')

const baseUrl = process.env.PB_URL || 'http://127.0.0.1:18091'
const platformAuth = await request('/api/collections/users/auth-with-password', {
  method: 'POST', body: { identity: process.env.APP_ADMIN_EMAIL, password: process.env.APP_ADMIN_PASSWORD }
})
const superAuth = await request('/api/collections/_superusers/auth-with-password', {
  method: 'POST', body: { identity: process.env.PB_SUPER_EMAIL, password: process.env.PB_SUPER_PASSWORD }
})

async function request(url, { method = 'GET', token = '', body, expected = 200 } = {}) {
  const response = await fetch(`${baseUrl}${url}`, {
    method,
    headers: { ...(token ? { Authorization: token } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body)
  })
  const raw = await response.text()
  let payload = null
  if (raw) { try { payload = JSON.parse(raw) } catch { payload = raw } }
  assert.equal(response.status, expected, `${method} ${url}: ${response.status} ${raw}`)
  return payload
}

// ---------- 批次下线的 kind 收口：两套集合必须与产出方一致 ----------
// RULE_KINDS / IDENTITY_KINDS 是手工抄的：#177 与 #178 都用 producer = "rule"，
// 各自只下线自己那批 kind。谁漏抄一个，那个 kind 就永远下线不掉（旧批次堆积、
// 校对端读到已经失效的疑点），而两边各自看自己的表都"正常"。#212 评审核过本 head
// 是对的、但没有东西守着它——这里补上，从两个 lib 的源码里抽出实际产出的 kind 比集合。
{
  const writer = require('../pb_hooks/lib/assist_writer.js')
  const source = (file) => readFileSync(new URL(`../pb_hooks/lib/${file}`, import.meta.url), 'utf8')
  // 规则库统一经 finding(kind, …) 产出；跨行库用 kind: "…" 字面量。
  const emitted = (text, pattern) => [...new Set([...text.matchAll(pattern)].map((m) => m[1]))].sort()
  const ruleKinds = emitted(source('assist_rules.js'), /finding\(\s*"([a-z_]+)"/g)
  const identityKinds = emitted(source('assist_identity.js'), /kind:\s*"([a-z_]+)"/g)
  assert.deepEqual([...writer.RULE_KINDS].sort(), ruleKinds,
    `RULE_KINDS 与 assist_rules.js 的产出不再一致：${JSON.stringify({ declared: [...writer.RULE_KINDS].sort(), emitted: ruleKinds })}`)
  // cross_source_conflict 是**声明了但暂不产出**的那一个：等 #169 的 OCR 结果字段。
  // 写成显式差集而不是放宽整个断言，将来它真的产出了却没进集合会红，反之也红。
  const expectedIdentity = [...new Set([...identityKinds, 'cross_source_conflict'])].sort()
  assert.deepEqual([...writer.IDENTITY_KINDS].sort(), expectedIdentity,
    `IDENTITY_KINDS 与 assist_identity.js 的产出不再一致：${JSON.stringify({ declared: [...writer.IDENTITY_KINDS].sort(), expected: expectedIdentity })}`)
  assert.equal(writer.IDENTITY_KINDS.includes('cross_source_conflict') && !identityKinds.includes('cross_source_conflict'),
    true, 'cross_source_conflict 的缺口应按 #169 记录，两侧注释与断言也要同步改')
  assert.deepEqual(writer.RULE_KINDS.filter((kind) => writer.IDENTITY_KINDS.includes(kind)), [],
    '两条批处理路径的 kind 不得重叠，否则又会互清批次')
}

// assist_writer.js 里不许再出现"一次读 N 条、offset 0"的批量读取形状。
// 这条守卫是被三连击逼出来的：#208 阻断 2（扫描上限 5000）→ retire 的 10 万行下线上限 →
// recomputeIdentity 的 5000 条人工结论与 refreshDifficulty 的 500 条单页疑点。
// 同一个形状换了三个地方，每次都靠人肉发现。现在：批量读取只能走 readAllInChunks /
// retire / loadAllPages，limit 字面量只允许 1（存在性检查）。
{
  const src = readFileSync(new URL('../pb_hooks/lib/assist_writer.js', import.meta.url), 'utf8')
  // 手写一个小扫描器取实参：第一版的正则会漏掉"闭括号写在同一行"的调用，
  // 我拿一个假的上限去验它，结果它照样绿——那就是一条恒真守卫，比没有更糟。
  const callsOf = (text, name) => {
    const found = []
    let from = 0
    for (;;) {
      const at = text.indexOf(`${name}(`, from)
      if (at < 0) return found
      let i = at + name.length + 1
      let depth = 1
      let quote = null
      let buf = ''
      while (i < text.length && depth > 0) {
        const ch = text[i]
        if (quote) { buf += ch; if (ch === quote) quote = null; i += 1; continue }
        if (ch === '"' || ch === "'" || ch === '`') { quote = ch; buf += ch; i += 1; continue }
        if (ch === '(') depth += 1
        else if (ch === ')') { depth -= 1; if (depth === 0) break }
        buf += ch
        i += 1
      }
      found.push(buf)
      from = i + 1
    }
  }
  const topArgs = (inner) => {
    const parts = []
    let depth = 0
    let quote = null
    let buf = ''
    for (const ch of inner) {
      if (quote) { buf += ch; if (ch === quote) quote = null; continue }
      if (ch === '"' || ch === "'" || ch === '`') { quote = ch; buf += ch; continue }
      if (ch === '(' || ch === '[') depth += 1
      if (ch === ')' || ch === ']') depth -= 1
      if (ch === ',' && depth === 0) { parts.push(buf.trim()); buf = ''; continue }
      buf += ch
    }
    if (buf.trim()) parts.push(buf.trim())
    return parts
  }
  const calls = callsOf(src, 'findRecordsByFilter')
  // 扫描器的自检：解析不出参数就等于没有守卫。
  for (const inner of calls) {
    assert.ok(topArgs(inner).length >= 4, `参数解析失败，扫描器自身是恒真的：${JSON.stringify(inner.slice(0, 60))}`)
  }
  // 收敛之后整个文件只剩两处直接读取（retire 的游标与 readAllInChunks 的游标）；
  // 少于两处就说明有人把分块实现拆回了裸调用。
  assert.ok(calls.length >= 2 && calls.length <= 3,
    `assist_writer.js 的直接读取点应只有分块helper那 2–3 处，实际 ${calls.length}`)
  const offenders = calls
    .map((inner) => topArgs(inner)[3] ?? '')
    .filter((limitArg) => /^\d+$/.test(limitArg) && Number(limitArg) > 1)
  assert.deepEqual(offenders, [], `assist_writer.js 里出现了带数字上限的一次性读取：${JSON.stringify(offenders)}`)
  assert.ok(src.includes('function readAllInChunks(') && src.includes('function retire('),
    '分块读取的实现被删了？')
}

const row = (o) => ({ 词条: o.headword ?? '', 拼音: o.pinyin ?? '', 莆田IPA: o.ipa ?? '', 释义: o.meaning ?? '', ...o.extra ?? {} })

// ---------- 纯函数：分组与 R-DEDUP ----------
{
  const entries = [
    { id: 'X1', project: 'p', row: row({ headword: '人', pinyin: 'lang2', meaning: '人类' }) },
    { id: 'X2', project: 'p', row: row({ headword: '人', pinyin: 'lang2', meaning: '别人' }) }
  ]
  const out = identity.findIdentityConflicts(entries)
  assert.equal(out.findings.length, 2, '两条各一条 finding')
  assert.deepEqual(out.findings.map((f) => f.kind).sort(), ['duplicate_identity', 'duplicate_identity'])
  assert.deepEqual(out.findings.map((f) => f.severity), ['strong', 'strong'])
  // 互指：每条的 evidence.partners 必须是另一条的 id
  const x1 = out.findings.find((f) => f.evidence.page === 'X1')
  const x2 = out.findings.find((f) => f.evidence.page === 'X2')
  assert.deepEqual(x1.evidence.partners, ['X2'])
  assert.deepEqual(x2.evidence.partners, ['X1'])
  assert.deepEqual(x1.params.differs_on, ['释义'])
}

// R-DEDUP 反向用例（验收项）：同词头不同拼音 ⇒ 一条 finding 都不许有。
// 这不是"记得判断一下"，而是身份键本身把两条分到不同桶——所以它不可能误合。
{
  const entries = [
    { id: 'Y1', project: 'p', row: row({ headword: '人', pinyin: 'lang2', meaning: '人类' }) },
    { id: 'Y2', project: 'p', row: row({ headword: '人', pinyin: 'nang2', meaning: '另一义' }) }
  ]
  const out = identity.findIdentityConflicts(entries)
  assert.deepEqual(out.findings, [], '同形词头绝不合并（R-DEDUP）')
  assert.equal(out.groups, 2)
}

// 归一化：全/半角、空白、NFC/NFD 差异都要归到同一个身份键上。
{
  const plain = row({ headword: '文', pinyin: 'un2', meaning: '文字' })
  const variants = [
    row({ headword: '　文　', pinyin: 'u n 2', meaning: '文字' }),
    { ...plain, extra: { 备注: '（注）' } },
    { ...plain, extra: { 备注: '(注)' } }
  ]
  const keys = new Set([plain, ...variants].map((item) => identity.entryIdentityKey(item)))
  assert.equal(keys.size, 1, JSON.stringify([...keys]))
  assert.equal(identity.normalizeText('人\u00a0\u3000'), '人', 'NBSP/全角空格都要吃掉')
  assert.equal(identity.normalizeText('（注）'), '(注)', '全角括号折叠到半角')
  assert.equal(identity.entryIdentityKey(row({ headword: '人', pinyin: '' })), null,
    '缺记音就不该产生键，否则会拿不完整的键误伤别的条目')
}

// 三条以上同身份：每两条之间都互指全部同伴。
{
  const entries = ['A', 'B', 'C'].map((id) => ({
    id, project: 'p', row: row({ headword: '一', pinyin: 'ik5', meaning: `义${id}` })
  }))
  const out = identity.findIdentityConflicts(entries)
  assert.equal(out.findings.length, 3)
  for (const finding of out.findings) {
    assert.equal(finding.evidence.partners.length, 2)
    assert.equal(finding.params.partner_count, 2)
  }
}

// 人工结论 not_conflict：整组跳过。
{
  const entries = [
    { id: 'Z1', project: 'p', row: row({ headword: '人', pinyin: 'lang2', meaning: '甲' }) },
    { id: 'Z2', project: 'p', row: row({ headword: '人', pinyin: 'lang2', meaning: '乙' }) }
  ]
  const key = identity.entryIdentityKey(entries[0].row)
  assert.ok(key)
  assert.equal(identity.findIdentityConflicts(entries, new Set([key])).findings.length, 0)
  assert.equal(identity.findIdentityConflicts(entries).findings.length, 2,
    '不标就得报出来：跳过必须显式，不能默认沉默')
}

// merged_columns（规则生产者）的两类形状异常。
{
  const shapes = identity.findRowShapeAnomalies({
    id: 'S1', row: row({ headword: '甲 乙', pinyin: 'ka1', meaning: '东西' })
  })
  assert.deepEqual(shapes.map((f) => f.message_key), ['multiple_headwords_in_cell'])
  assert.equal(shapes[0].kind, 'merged_columns')
  assert.equal(shapes[0].severity, 'strong')
  const tones = identity.findRowShapeAnomalies({ id: 'S2', row: row({ headword: '甲', pinyin: 'ka1', meaning: '说明 ka53 之类' }) })
  assert.deepEqual(tones.map((f) => f.message_key), ['reading_inside_meaning_row'])
  const clean = identity.findRowShapeAnomalies({ id: 'S3', row: row({ headword: '甲', pinyin: 'ka1', meaning: '普通释义，带括号（注）' }) })
  assert.deepEqual(clean, [], '正常释义不该被报成列错位')
}

// 规模：10k 行的纯分组扫描必须是线性量级（防止退化成分组内两两比较）。
{
  const entries = []
  for (let i = 0; i < 10000; i += 1) {
    entries.push({
      id: `K${i}`, project: 'p',
      row: row({ headword: `词${i % 2500}`, pinyin: `pin${i % 2500}`, meaning: `义${i}` })
    })
  }
  const startedAt = Date.now()
  const out = identity.findIdentityConflicts(entries)
  const ms = Date.now() - startedAt
  // 4 个一组同身份、义不同 ⇒ 每组 4 条 finding ⇒ 2500*4
  assert.equal(out.findings.length, 10000, JSON.stringify({ groups: out.groups, findings: out.findings.length }))
  console.log(`IDENTITY_10K ${JSON.stringify({ rows: 10000, groups: out.groups, findings: out.findings.length, ms })}`)
  assert.ok(ms < 4000, `10k 行扫描耗时 ${ms}ms，疑似退化成 O(n^2)`)
}

console.log('PASS: identity detectors, including the R-DEDUP reverse case')

// ---------- 服务端 ----------
const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`
const userIds = []
const mkUser = async (label) => {
  const email = `identity-${label}-${suffix}@example.com`
  const user = await request('/api/collections/users/records', {
    method: 'POST', token: superAuth.token,
    body: { email, password: 'IdentityPass123!', passwordConfirm: 'IdentityPass123!', name: label, role: 'user' }
  })
  userIds.push(user.id)
  const auth = await request('/api/collections/users/auth-with-password', { method: 'POST', body: { identity: email, password: 'IdentityPass123!' } })
  return { ...user, token: auth.token }
}

const boss = await (async () => {
  const email = `identity-manager-${suffix}@example.com`
  const user = await request('/api/collections/users/records', {
    method: 'POST', token: superAuth.token,
    body: { email, password: 'IdentityPass123!', passwordConfirm: 'IdentityPass123!', name: 'identity', role: 'user' }
  })
  userIds.push(user.id)
  const auth = await request('/api/collections/users/auth-with-password', { method: 'POST', body: { identity: email, password: 'IdentityPass123!' } })
  return { ...user, token: auth.token }
})()

let project = null
let pageIds = []
try {
  project = await request('/api/fangji/projects', {
    method: 'POST', token: platformAuth.token, expected: 201, body: { name: `Identity ${suffix}` }
  })
  await request(`/api/fangji/projects/${project.id}/members/${boss.id}`, { method: 'PUT', token: platformAuth.token, body: { role: 'manager' } })

  const mk = async (number, value) => {
    const page = await request('/api/collections/pages/records', {
      method: 'POST', token: superAuth.token,
      body: {
        project: project.id, page_number: number, pdf_page: number, status: 'pending',
        proofread_round: 1, mismatch_count: 0,
        ocr_row_json: JSON.stringify(value), ocr_text: Object.values(value).join(' ')
      }
    })
    pageIds.push(page.id)
    return page
  }
  const p1 = await mk(1, { 词条: '人', 拼音: 'lang2', 莆田IPA: 'laŋ2', 释义: '人类' })
  const p2 = await mk(2, { 词条: '人', 拼音: 'lang2', 莆田IPA: 'laŋ2', 释义: '别人' })
  const p3 = await mk(3, { 词条: '人', 拼音: 'nang2', 莆田IPA: 'naŋ2', 释义: '同形不同音' })
  // p4 同时带两类缺陷：#177 的 reading_format_invalid（ua5333 是压平声调）与
  // #178 的 merged_columns（两个词头挤在一列）。两边各产各的 kind，
  // 下面的交叉断言才有东西可验——否则这个测试是空跑。
  const p4 = await mk(4, { 词条: '甲 乙', 拼音: 'ka1', 莆田IPA: 'ua5333', 释义: '两个词头挤在一列' })

  const first = await request(`/api/fangji/projects/${project.id}/identity/recompute`, { method: 'POST', token: boss.token })
  const current = async () => (await request(`/api/collections/review_findings/records?filter=${encodeURIComponent('superseded_at = ""')}`, { token: superAuth.token }))
    .items.filter((item) => item.project === project.id)

  let findings = await current()
  const dup = findings.filter((item) => item.kind === 'duplicate_identity')
  assert.equal(dup.length, 2, JSON.stringify(findings.map((f) => f.kind)))
  assert.deepEqual(new Set(dup.map((item) => item.page)), new Set([p1.id, p2.id]))
  assert.ok(dup.every((item) => item.producer_version === identity.IDENTITY_VERSION))
  const partnerOfFirst = dup.find((item) => item.page === p1.id)
  assert.deepEqual(JSON.parse(partnerOfFirst.evidence_json).partners, [p2.id], '两条必须互指')

  // 新鲜度这一对断言是 difficulty_stale 的根据，不是装饰：
  // 本 fixture 里 #177 的重算一次都没跑过，所以 p1 的难度三件套此刻仍应是"从没算过"（空）。
  // 也就是说跨行检出确实**没有**顺手刷 tier——它产的那条 strong duplicate_identity 还在窗口期里。
  assert.equal(first.difficulty_stale, true, `本轮有产出却没标记 tier 过期：${JSON.stringify(first)}`)
  const stalePage = await request(`/api/collections/pages/records/${p1.id}`, { token: superAuth.token })
  assert.ok(!stalePage.difficulty_tier && !stalePage.difficulty_basis_json,
    `identity 路径不该刷 tier，实际已写成 ${JSON.stringify([stalePage.difficulty_tier, stalePage.difficulty_basis_json])}`)
  // 窗口由谁关闭：跑一次 #177 的项目重算，tier 才落库。这两条一起把 runbook 那句话变成断言。
  await request(`/api/fangji/projects/${project.id}/findings/recompute`, { method: 'POST', token: boss.token })
  const refreshed = await request(`/api/collections/pages/records/${p1.id}`, { token: superAuth.token })
  assert.ok(refreshed.difficulty_tier, '项目重算之后 tier 仍为空，说明这条链根本没接上')

  // R-DEDUP 反向：同词头不同拼音的第三条不得被牵连，且两条都还在（未被合并、未被删）
  assert.equal(dup.some((item) => item.page === p3.id), false)
  const survivors = await request(`/api/collections/pages/records?filter=${encodeURIComponent(`project = "${project.id}"`)}`, { token: superAuth.token })
  assert.equal(survivors.items.length, 4, '身份冲突检出不许合并或删除任何条目')

  // #175 红线 1 在数据形状上的落点（契约：review-findings.md §8.1 第 1 条，按绝对解释）。
  // identity 生产者曾经把词头与记音的字面值放进 params（全仓无人消费），删键之后由这条断言
  // 保证它们不会换个名字回来：params 里不许出现任何一条的单元格原文。
  // 清单要同时收原始值与归一化值——生产者内部算的是 normalizeText 的结果，只比原文会放过
  // '甲 乙'→'甲乙' 这种折叠形状；也不许按字符集过滤——本 fixture 的记音列（lang2 / nang2 /
  // ka1 / ua5333）全是 ASCII，而那正是被删掉的 identity_reading 的来源列。
  const stringLeaves = (value) => Array.isArray(value)
    ? value.flatMap(stringLeaves)
    : value && typeof value === 'object' ? Object.values(value).flatMap(stringLeaves) : [String(value)]
  const cellText = survivors.items
    .flatMap((page) => Object.values(JSON.parse(page.ocr_row_json || '{}')))
    .flatMap((value) => { const raw = String(value); return raw ? [raw, identity.normalizeText(raw)] : [] })
  assert.ok(cellText.length > 0, 'privacy 扫描的原文清单为空，下面这圈就是恒真')
  const identityFindings = findings.filter((item) => item.producer_version === identity.IDENTITY_VERSION)
  assert.ok(identityFindings.length > 0, 'identity 生产者必须真的产了疑点')
  for (const item of identityFindings) {
    // 契约：anchor 每条必填，不区分行级/非行级（review-findings.md §8.1 第 2 条）。
    // 这条断言就是 #178 侧的落点——读取端不必先判作用域再决定这条有没有口径。
    assert.equal(JSON.parse(item.evidence_json).anchor, identity.ANCHOR_ENTRY,
      `${item.kind} 的 evidence 缺挂靠口径`)
    // 逐叶子比，不比整段序列化结果：键名与中文列名本来就该在 params 里，整段比才需要过滤。
    for (const leaf of stringLeaves(JSON.parse(item.params_json))) {
      for (const value of cellText) {
        assert.equal(leaf === value || (value.length >= 2 && leaf.includes(value)), false,
          `${item.kind} 的 params 带了内容片段：${leaf}`)
      }
    }
  }

  // merged_columns 由规则生产者报出（与 #125 同名 kind、不同生产者）
  const merged = findings.filter((item) => item.kind === 'merged_columns')
  assert.ok(merged.length >= 1)
  assert.equal(merged[0].producer, 'rule')
  assert.equal(merged[0].message_key, 'multiple_headwords_in_cell')

  // cross_source_conflict 今天必须不出现：#169 的 sources 还不存在，
  // 宁可少报也不给虚假结论（下面断言的是"没有"，写反了就是自欺）。
  assert.equal(findings.some((item) => item.kind === 'cross_source_conflict'), false,
    '来源登记(#169)未落地前不得产 cross_source_conflict')

  // 身份键回填可重跑：第二次跑不该再改任何键，也不该产新批次之外的东西
  const before = await request(`/api/collections/pages/records/${p1.id}`, { token: superAuth.token })
  assert.ok(before.entry_identity_key.length > 0)
  const second = await request(`/api/fangji/projects/${project.id}/identity/recompute`, { method: 'POST', token: boss.token })
  assert.equal(second.backfilled_keys, 0, '第二次回填应当无事可做')
  const after = await request(`/api/collections/pages/records/${p1.id}`, { token: superAuth.token })
  assert.equal(after.entry_identity_key, before.entry_identity_key)
  findings = await current()
  assert.equal(findings.filter((item) => item.kind === 'duplicate_identity').length, 2, '重算只剩一份当前批次')

  // 人工结论：标 not_conflict 之后重算不再出现；撤销之后又出现
  const groupKey = identity.entryIdentityKey({ 词条: '人', 拼音: 'lang2' })
  const dismissal = await request(`/api/fangji/projects/${project.id}/dismissals`, {
    method: 'POST', token: boss.token, body: { group_key: groupKey, kind: 'duplicate_identity', note: '确认是两个词条' }
  })
  await request(`/api/fangji/projects/${project.id}/identity/recompute`, { method: 'POST', token: boss.token })
  findings = await current()
  assert.equal(findings.filter((item) => item.kind === 'duplicate_identity').length, 0,
    '人工结论必须在重算后保留')
  assert.equal(findings.filter((item) => item.kind === 'merged_columns').length > 0, true,
    '只该跳过被标的那一组，不能整批沉默')
  await request(`/api/fangji/projects/${project.id}/dismissals/${dismissal.id}`, { method: 'DELETE', token: boss.token, expected: 204 })
  await request(`/api/fangji/projects/${project.id}/identity/recompute`, { method: 'POST', token: boss.token })
  findings = await current()
  assert.equal(findings.filter((item) => item.kind === 'duplicate_identity').length, 2, '撤回结论后应重新报出')

  // 关键交叉验证：#177 与 #178 都写 producer=rule，两边重算不得互相下线对方的 kind
  const beforeRules = await current()
  assert.ok(beforeRules.some((item) => item.kind === 'duplicate_identity')
    && beforeRules.some((item) => item.kind === 'merged_columns'),
    `#178 批次为空，交叉断言没有意义：${JSON.stringify(beforeRules.map((i) => i.kind))}`)
  await request(`/api/fangji/projects/${project.id}/findings/recompute`, { method: 'POST', token: boss.token })
  assert.ok((await current()).some((item) => item.kind === 'reading_format_invalid'),
    '#177 的全量重算必须至少产出一条自己那批的疑点（否则下面的双向断言都是空真）')
  await request(`/api/fangji/projects/${project.id}/findings/recompute`, { method: 'POST', token: boss.token })
  const afterRules = await current()
  assert.equal(afterRules.filter((item) => item.kind === 'merged_columns' || item.kind === 'duplicate_identity').length,
    beforeRules.filter((item) => item.kind === 'merged_columns' || item.kind === 'duplicate_identity').length,
    '#177 的全量重算不得下线 #178 的疑点')
  assert.ok(afterRules.some((item) => item.kind === 'reading_format_invalid'), '#177 自己的批次仍在')
  const before177 = afterRules.filter((item) => item.kind === 'reading_format_invalid').length
  await request(`/api/fangji/projects/${project.id}/identity/recompute`, { method: 'POST', token: boss.token })
  const afterBoth = await current()
  assert.equal(afterBoth.filter((item) => item.kind === 'reading_format_invalid').length, before177,
    '#178 的重算也不得下线 #177 的疑点')

  // 人工结论口只对 manager 开放。
  // 注意平台管理员**本来就能管理项目**（requireManager 走 canManage），
  // 所以拿 platformAdmin 断言 403 是错的；真正的负例是项目内的普通校对员。
  const worker = await mkUser('worker')
  await request(`/api/fangji/projects/${project.id}/members/${worker.id}`, { method: 'PUT', token: platformAuth.token, body: { role: 'proofreader' } })
  await request(`/api/fangji/projects/${project.id}/dismissals`, {
    method: 'POST', token: worker.token, expected: 403, body: { group_key: groupKey, kind: 'duplicate_identity' }
  })
  await request(`/api/fangji/projects/${project.id}/identity/recompute`, { method: 'POST', token: worker.token, expected: 403 })
  await request(`/api/fangji/projects/${project.id}/dismissals`, {
    method: 'POST', token: boss.token, expected: 400, body: { group_key: groupKey, kind: 'not_a_real_kind' }
  })
  // 分组键会被拼进过滤表达式：带引号/括号的值必须被挡在写库之前，
  // 否则一条"人工结论"就能变成一次跨项目读取或越权改写。
  for (const bad of ['x") || (project != "', 'a" && (kind = "b', "y)(z"]) {
    await request(`/api/fangji/projects/${project.id}/dismissals`, {
      method: 'POST', token: boss.token, expected: 400, body: { group_key: bad, kind: 'duplicate_identity' }
    })
  }
  // 真实身份键（含空格与中日韩字符）必须仍然可用——白名单不能严到把正常值挡掉。
  const okDismissal = await request(`/api/fangji/projects/${project.id}/dismissals`, {
    method: 'POST', token: boss.token, body: { group_key: '人 lang2', kind: 'duplicate_identity' }
  })
  assert.ok(okDismissal.id)
  await request(`/api/fangji/projects/${project.id}/dismissals/${okDismissal.id}`, { method: 'DELETE', token: boss.token, expected: 204 })

  console.log('Identity conflicts integration test passed.')
} finally {
  if (project) {
    const dismissals = await request(`/api/collections/finding_dismissals/records?filter=${encodeURIComponent(`project = "${project.id}"`)}`, { token: superAuth.token })
    for (const item of dismissals.items) {
      await request(`/api/collections/finding_dismissals/records/${item.id}`, { method: 'DELETE', token: superAuth.token, expected: 204 })
    }
    const findings = await request(`/api/collections/review_findings/records?filter=${encodeURIComponent(`project = "${project.id}"`)}`, { token: superAuth.token })
    for (const item of findings.items) {
      await request(`/api/collections/review_findings/records/${item.id}`, { method: 'DELETE', token: superAuth.token, expected: 204 })
    }
    await request(`/api/fangji/projects/${project.id}`, { method: 'DELETE', token: platformAuth.token, expected: 204 })
  }
  for (const id of userIds.reverse()) {
    await request(`/api/collections/users/records/${id}`, { method: 'DELETE', token: superAuth.token, expected: 204 })
  }
}
