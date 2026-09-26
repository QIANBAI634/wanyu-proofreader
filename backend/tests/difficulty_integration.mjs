import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const difficulty = require('../pb_hooks/lib/assist_difficulty.js')
const writer = require('../pb_hooks/lib/assist_writer.js')

// 迁移里那两份 select values 是 assist_difficulty.js 的字面量副本。漂移的后果不是"数字偏一点"
// 而是硬失败：PocketBase 会拒绝不在 values 表里的值，于是 refreshDifficulty 的 dao.save 直接报错。
// 而这条路径上没有任何东西守着它——check_migrations.py 对本迁移只查索引不查 select 值，
// 本文件又不 import 迁移文件。所以照 #208 那条先例做源码对账（比集合，顺序不该被钉）。
{
  const migration = readFileSync(
    new URL('../pb_migrations/1789113700_page_difficulty.js', import.meta.url), 'utf8')
  const literal = (name) => {
    const hit = migration.match(new RegExp(`const ${name} = \\[(.*?)\\]`, 's'))
    // 抽不出来就必须红：扫描器失效时下面两条断言会双双变成"空集合等于空集合"的恒真。
    assert.ok(hit, `迁移里找不到 const ${name} = [...]，对账本身失效了`)
    return [...hit[1].matchAll(/"([^"]+)"/g)].map((item) => item[1])
  }
  const fromMigrationTiers = literal('TIERS')
  const fromMigrationBuckets = literal('BLOCKED_BUCKETS')
  // 只挡"扫描器什么都没抽到"这一种失效：再往上报数就会把真正的漂移消息盖掉。
  assert.ok(fromMigrationTiers.length >= 1 && fromMigrationBuckets.length >= 1,
    `从迁移抽出的枚举为空，先怀疑正则：${JSON.stringify({ tiers: fromMigrationTiers, buckets: fromMigrationBuckets })}`)
  assert.deepEqual([...fromMigrationTiers].sort(), [...difficulty.TIERS].sort(),
    `TIERS 漂移：迁移 ${JSON.stringify(fromMigrationTiers)} vs 判定表 ${JSON.stringify(difficulty.TIERS)}`)
  assert.deepEqual([...fromMigrationBuckets].sort(), [...difficulty.BLOCKED_BUCKETS].sort(),
    `BLOCKED_BUCKETS 漂移：迁移 ${JSON.stringify(fromMigrationBuckets)} vs 判定表 ${JSON.stringify(difficulty.BLOCKED_BUCKETS)}`)
}

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

// 每一行判定表都要有一个"只命中这一行"的用例。加一行不写用例，下面的循环就会红。
const CASES = {
  cross_source_conflict: { findings: [{ kind: 'cross_source_conflict', severity: 'warn', field: '释义' }] },
  rights_gate_blocked: { blockedReason: 'rights_gate' },
  scanned_read_blocked: { blockedReason: 'scanned_read' },
  strong_findings_ge_2: { findings: [
    { kind: 'merged_columns', severity: 'strong', field: '莆田IPA' },
    { kind: 'reading_format_invalid', severity: 'strong', field: '拼音' }
  ] },
  reading_and_meaning_change: { roles: { 莆田IPA: 'reading', 释义: 'meaning' } },
  column_merge_blocked: { blockedReason: 'column_merge' },
  strong_findings_eq_1: { findings: [{ kind: 'reading_format_invalid', severity: 'strong', field: '莆田IPA' }] },
  missing_pdf_page: { pdfPage: 0 },
  row_shape_outlier: { fieldCount: 9, projectStats: { medianFieldCount: 6 } },
  warn_findings_ge_3: { findings: [
    { kind: 'char_out_of_repertoire', severity: 'warn', field: '莆田IPA' },
    { kind: 'punctuation_mix', severity: 'warn', field: '释义' },
    { kind: 'confusable_substitution', severity: 'warn', field: '仙游IPA' }
  ] },
  frequent_arbitration: { arbitrationRates: { 莆田IPA: 0.3 } },
  glyph_table_blocked: { blockedReason: 'glyph_table' },
  pure_transcription: { roles: { 词条: 'headword', 拼音: 'reading' }, pdfPage: 3 }
}

const base = { findings: [], pdfPage: 3, blockedReason: 'unknown', fieldCount: 5,
  valueLengths: [2, 3], projectStats: null, arbitrationRates: null, roles: null }

for (const rule of difficulty.TIER_RULES) {
  const input = { ...base, pdfPage: 3, ...CASES[rule.id],
    // 行形状用例要显式带 fieldCount，其余用例保持与中位数一致
    ...(rule.id === 'row_shape_outlier' ? {} : { fieldCount: 5, projectStats: null }) }
  const out = difficulty.deriveDifficulty(input)
  assert.deepEqual(out.basis, [rule.id],
    `规则 ${rule.id} 应当只命中自己这一行，实际 ${JSON.stringify(out.basis)}（输入 ${JSON.stringify(input)}）`)
  assert.equal(out.tier, rule.tier, `${rule.id} 的 tier 应为 ${rule.tier}，实际 ${out.tier}`)
  assert.equal(out.version, difficulty.DIFFICULTY_VERSION)
}
assert.deepEqual(Object.keys(CASES).sort(), difficulty.TIER_RULES.map((rule) => rule.id).sort(),
  '判定表与用例必须一一对应：加一行判定就要加一个用例')

// 上确界而不是多数表决：三条 A/B 与一条 C 同时命中，tier 必须是 C。
const mixed = difficulty.deriveDifficulty({
  ...base, pdfPage: 0, blockedReason: 'scanned_read',
  findings: [{ kind: 'cross_source_conflict', severity: 'warn', field: '释义' }],
  roles: { 莆田IPA: 'reading', 释义: 'meaning' }
})
assert.equal(mixed.tier, 'C')
assert.ok(mixed.basis.includes('cross_source_conflict') && mixed.basis.includes('missing_pdf_page')
  && mixed.basis.includes('reading_and_meaning_change') && mixed.basis.includes('scanned_read_blocked'),
  JSON.stringify(mixed.basis))

// 无信号 ⇒ unknown（不是 A）：#162 依赖这个区分来"原样退回下一条"。
const silent = difficulty.deriveDifficulty({ ...base, pdfPage: 3, roles: null })
assert.equal(silent.tier, 'unknown')
assert.deepEqual(silent.basis, [])
// 从没算过（字段为空）与算过但是 unknown 是两件事，由调用方在库里区分；这里只保证
// 纯函数对"无信号"给出 unknown 而不是猜一个档位。

// #179 的分布缺失时不得产生仲裁信号——把它当 0 会让全体偏 A。
assert.equal(difficulty.deriveDifficulty({ ...base, arbitrationRates: null }).basis
  .includes('frequent_arbitration'), false)
assert.equal(difficulty.deriveDifficulty({ ...base, arbitrationRates: {} }).basis
  .includes('frequent_arbitration'), false)
assert.equal(difficulty.deriveDifficulty({ ...base, arbitrationRates: { 莆田IPA: 0.24 } }).basis
  .includes('frequent_arbitration'), false, '阈值边界 0.25 以下不得触发')

// 稳定可复算：同一份输入两次结果逐字节相同。
const again = difficulty.deriveDifficulty({ ...base, blockedReason: 'column_merge' })
assert.deepEqual(again, difficulty.deriveDifficulty({ ...base, blockedReason: 'column_merge' }))
assert.equal(again.tier, 'B')

// 认不出的阻塞原因退回 unknown，不得顺手猜一个桶。
assert.equal(difficulty.normalizeBlocked('typo_in_source'), 'unknown')
assert.equal(difficulty.blockedReasonFromFindings(
  [{ kind: 'merged_columns', severity: 'strong', field: '释义' }]), 'column_merge')
assert.equal(difficulty.blockedReasonFromFindings([]), 'unknown')

// 读取不许有静默上限：这一整套改造（#208 阻断 2 → retire 分块 → 这里）守的都是同一件事。
// refreshDifficulty 原来是 `limit 500, offset 0` 一次读，读不到的那部分不会参与 tier，
// 而 tier 是持久化的排序键；recomputeIdentity 读人工结论时是 `limit 5000`，
// 而 #178 的 10k 压力 fixture 本身就有 2500 个身份分组——上限不是假想。
{
  const rows = Array.from({ length: 7 }, (_, i) => ({ id: `f${i}` }))
  let reads = 0
  const dao = {
    findRecordsByFilter: (collection, filter, sort, limit, offset) => {
      reads += 1
      return rows.slice(offset, offset + limit)
    }
  }
  assert.deepEqual(writer.readAllInChunks(dao, 'review_findings', 'x', 'kind', { chunk: 3 }).map((r) => r.id),
    rows.map((r) => r.id), '分块读取必须把 7 行全读出来')
  assert.ok(reads >= 3, `chunk=3 时应至少读三块，实际 ${reads} 次：说明读到第一块就停了`)
  reads = 0
  // 行数刚好是块的整数倍时，要多探一次才能确认读完——这是游标读取的固有代价，
  // 断言写在这里是为了下次有人"优化"掉那一次读取时能被发现。
  reads = 0
  assert.deepEqual(writer.readAllInChunks(dao, 'review_findings', 'x', 'kind', { chunk: 7 }).map((r) => r.id),
    rows.map((r) => r.id), '整批刚好一块时也要读全')
  assert.equal(reads, 2, `刚好一块应多探一次确认结束：${reads}`)
  let emptyReads = 0
  const emptyDao = { findRecordsByFilter: () => { emptyReads += 1; return [] } }
  assert.deepEqual(writer.readAllInChunks(emptyDao, 'review_findings', 'x', 'kind', { chunk: 10 }), [],
    '空结果集不该死循环')
  assert.equal(emptyReads, 1, `空结果集应只读一次：${emptyReads}`)
}

console.log('PASS: difficulty signal table walked row by row')

// ---------- 服务端：重算之后 tier 落库，且不从校对端响应里泄漏 ----------
const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`
const password = 'TaskDifficulty123!'
const userIds = []

async function createUser(label) {
  const email = `${label}-${suffix}@example.com`
  const user = await request('/api/collections/users/records', {
    method: 'POST', token: superAuth.token,
    body: { email, password, passwordConfirm: password, name: label, role: 'user' }
  })
  userIds.push(user.id)
  const auth = await request('/api/collections/users/auth-with-password', { method: 'POST', body: { identity: email, password } })
  return { ...user, token: auth.token }
}

const worker = await createUser('difficulty-worker')
const boss = await createUser('difficulty-manager')
const project = await request('/api/fangji/projects', {
  method: 'POST', token: platformAuth.token, expected: 201, body: { name: `Difficulty ${suffix}` }
})
await request(`/api/fangji/projects/${project.id}/members/${worker.id}`, { method: 'PUT', token: platformAuth.token, body: { role: 'proofreader' } })
await request(`/api/fangji/projects/${project.id}/members/${boss.id}`, { method: 'PUT', token: platformAuth.token, body: { role: 'manager' } })

let emptyProject = null
let multi = null
try {
  const messy = await request('/api/collections/pages/records', {
    method: 'POST', token: superAuth.token,
    body: {
      project: project.id, page_number: 1, pdf_page: 0, status: 'pending',
      proofread_round: 1, mismatch_count: 0,
      ocr_row_json: JSON.stringify({ 词条: '甲', 拼音: 'ka1', 莆田IPA: 'ua5333', 仙游IPA: 'ka', 释义: '第一（个）测试' }),
      ocr_text: '甲'
    }
  })
  assert.equal(messy.difficulty_tier ?? '', '', '新条目在算过之前必须是空，不是 unknown')

  const summary = await request(`/api/fangji/projects/${project.id}/findings/recompute`, { method: 'POST', token: boss.token })
  assert.equal(summary.pages, 1)
  assert.ok(summary.difficulty_tiers, JSON.stringify(summary))

  const after = await request(`/api/collections/pages/records/${messy.id}`, { token: superAuth.token })
  assert.ok(['A', 'B', 'C', 'unknown'].includes(after.difficulty_tier), after.difficulty_tier)
  assert.equal(after.difficulty_version, difficulty.DIFFICULTY_VERSION)
  const basis = JSON.parse(after.difficulty_basis_json)
  assert.ok(basis.includes('missing_pdf_page'), JSON.stringify(basis))
  // 规则引擎目前不产 merged_columns，机器也不许把猜出来的桶 stamp 回这一列：
  // `blocked_reason` 非空 = 有人说过（#188 靠这条区分），空 = 没人说过。
  assert.equal(after.blocked_reason, '', `自动路径不得 stamp 人工字段：${after.blocked_reason}`)

  // 幂等且稳定：再算一次结果不变（#180 验收：可复算）。
  const second = await request(`/api/fangji/pages/${messy.id}/findings/recompute`, { method: 'POST', token: boss.token })
  const afterSecond = await request(`/api/collections/pages/records/${messy.id}`, { token: superAuth.token })
  assert.equal(afterSecond.difficulty_tier, after.difficulty_tier)
  assert.equal(afterSecond.difficulty_basis_json, after.difficulty_basis_json)
  assert.equal(second.difficulty_tier, after.difficulty_tier)

  // #180 验收原文是「同一份数据在**两个 `producer_version`** 下结果稳定可复算」。
  // 上面那段只把同一个版本重算了两遍，盖不到这条。真实形状是：一条页面上同时挂着
  // #177 的 l0-v1 与 #178 的 identity-v1 两批疑点，而 tier 必须 (a) 两批都算进来
  // ——漏一批就等于重算顺序会改变 #162 的排序键；(b) 记的是推导自身的版本 tier-v1，
  // 不是任何一个输入批次的 producer_version；(c) 其中一批被下线后回到原始结果，
  // 不重复计数、也不让已下线的行继续影响 tier。
  const strongNow = async () => (await request(
    `/api/collections/review_findings/records?perPage=200&filter=${encodeURIComponent(`page = "${messy.id}" && superseded_at = "" && severity = "strong"`)}`,
    { token: superAuth.token })).items
  const beforeForeign = await strongNow()
  const expectedId = (count) => (count >= 2 ? 'strong_findings_ge_2' : count === 1 ? 'strong_findings_eq_1' : null)
  assert.equal(JSON.parse((await request(`/api/collections/pages/records/${messy.id}`, { token: superAuth.token })).difficulty_basis_json)
    .includes(expectedId(beforeForeign.length)), true,
    `起点就不自洽：${beforeForeign.length} 条 strong 应对应 ${expectedId(beforeForeign.length)}`)

  // 用 ocr 这个生产者而不是再批一条 producer="rule"：在 #212 之前，#177 的下线只按
  // producer 收口，任何 producer="rule" 的第二批（#178 的 identity-v1 就是）都会被
  // 同一次重算顺手标掉——这一点由 #212 的 kindClause 修掉，我在 #211 的正文里也记了。
  // 本测试要量的是 tier 跨版本聚合，不该被那个尚未存在的收口绑住。
  const foreign = await request('/api/collections/review_findings/records', {
    method: 'POST', token: superAuth.token,
    body: {
      page: messy.id, project: project.id, field_name: '释义', kind: 'merged_columns',
      severity: 'strong', message_key: 'column_collapse', params_json: '{}',
      evidence_json: '{}', producer: 'ocr', producer_version: 'ocr-v1',
      produced_at: new Date().toISOString()
    }
  })
  await request(`/api/fangji/pages/${messy.id}/findings/recompute`, { method: 'POST', token: boss.token })
  const mixed = await request(`/api/collections/pages/records/${messy.id}`, { token: superAuth.token })
  const mixedBasis = JSON.parse(mixed.difficulty_basis_json)
  assert.equal(mixedBasis.includes(expectedId(beforeForeign.length + 1)), true,
    `另一个 producer_version 的疑点没被算进 tier：${JSON.stringify({ strong: beforeForeign.length + 1, basis: mixedBasis })}`)
  assert.equal(mixed.difficulty_version, difficulty.DIFFICULTY_VERSION,
    'tier 上记的必须是推导自身的版本，不是任何一个输入批次的 producer_version')
  // 这两行是 #211/#212 评审阻断 2 的牙齿。自动认出的桶必须真的进到本轮 derivation 里
  // （basis 出现 column_merge_blocked，也就是 tier 会因此进 B）；而它**不得**写回
  // blocked_reason：一旦写回，库里就分不出机器 stamp 与人选的桶，`stored || auto` 那种
  // 写法还会让这一列从第一次刷新起永久非空、疑点侧再也没机会执行。
  assert.equal(mixedBasis.includes('column_merge_blocked'), true,
    `注入 merged_columns 强疑点后 basis 里没有自动认出的桶：${JSON.stringify(mixedBasis)}`)
  assert.equal(mixed.blocked_reason, '',
    `自动认出的桶被写进了人工字段：${mixed.blocked_reason}`)

  // 把那条"另一个版本"的疑点下线（#178 的批次就是这么被 kind 收口下线的），tier 要回到原样。
  await request(`/api/collections/review_findings/records/${foreign.id}`, {
    method: 'PATCH', token: superAuth.token, body: { superseded_at: new Date().toISOString() }
  })
  await request(`/api/fangji/pages/${messy.id}/findings/recompute`, { method: 'POST', token: boss.token })
  const rolledBack = await request(`/api/collections/pages/records/${messy.id}`, { token: superAuth.token })
  assert.equal(rolledBack.difficulty_basis_json, after.difficulty_basis_json,
    `下线后没有回到原始结果（重复计数或读到了已下线的行）：${rolledBack.difficulty_basis_json}`)
  assert.equal(rolledBack.difficulty_tier, after.difficulty_tier)
  // 疑点下线后 basis 要回到原样（上面那条），这一列也必须还是"没人说过"。
  // 这条断言就是「不 stamp」这个决定的守卫：将来有人把 blocked_reason 写回这条路径，
  // 这里会红，逼他回来回答"机器写的桶和人写的桶怎么区分、疑点消失后怎么降级"。
  assert.equal(rolledBack.blocked_reason, '',
    `下线疑点之后这一列被机器写过：${rolledBack.blocked_reason}`)

  // 盲校未退化：tier 是筛选维度，不是给校对员的轮次线索。
  // GET /task 用显式字段列表，因此新字段不会跟着下发；这里把它钉成断言，
  // 将来有人把 payload 改成 spread 就会红。
  const claim = await request(`/api/fangji/projects/${project.id}/claim`, { method: 'POST', token: worker.token })
  const task = JSON.stringify(await request(`/api/fangji/pages/${claim.id}/task`, { token: worker.token }))
  for (const leaked of ['difficulty_tier', 'difficulty_basis_json', 'difficulty_version', 'blocked_reason', 'round', 'pass_no']) {
    assert.equal(task.includes(`"${leaked}"`), false, `校对端任务响应泄漏了 ${leaked}`)
  }
  const hints = JSON.stringify(await request(`/api/fangji/pages/${claim.id}/findings`, { token: worker.token }))
  for (const leaked of ['difficulty_tier', 'blocked_reason', 'proofreader']) {
    assert.equal(hints.includes(`"${leaked}"`), false, `疑点响应泄漏了 ${leaked}`)
  }
  // manager 的项目统计口允许看见 tier（那是它的用途），但不得带出他人提交内容。
  const managerView = JSON.stringify(await request(`/api/fangji/projects/${project.id}/findings`, { token: boss.token }))
  assert.equal(managerView.includes('row_json'), false)

  // #212 评审指出：本套件每个项目只建一条 page，「疑点挂错条目」这件事在这里结构上
  // 不可观测。tier 与 hint 不一样——它是**持久化的排序键**，#162 大厅按它筛选排序，
  // 算错的那份会一直留在库里直到下次重算覆盖。所以这里建一个三条页的项目，
  // 并把干净页放在**第一条**：一旦某次重算把别人的疑点摊平到第一条上，
  // 下面「干净页不得带任何由疑点推导出来的 basis」立刻红。
  multi = await request('/api/fangji/projects', {
    method: 'POST', token: platformAuth.token, expected: 201, body: { name: `Multi ${suffix}` }
  })
  await request(`/api/fangji/projects/${multi.id}/members/${boss.id}`, { method: 'PUT', token: platformAuth.token, body: { role: 'manager' } })
  const rows = [
    { 词条: '天', 拼音: 'thin1', 莆田IPA: 'tʰĩ1', 仙游IPA: 'tʰĩ1', 释义: '天空' },
    { 词条: '甲', 拼音: 'ka1', 莆田IPA: 'ua5333', 仙游IPA: 'ka', 释义: '第一（个）测试' },
    { 词条: '人', 拼音: 'lang2', 莆田IPA: 'lɑŋ2', 仙游IPA: 'zuin9999', 释义: '人类' }
  ]
  const pages = []
  for (const [index, row] of rows.entries()) {
    pages.push(await request('/api/collections/pages/records', {
      method: 'POST', token: superAuth.token,
      body: {
        project: multi.id, page_number: index + 1, pdf_page: index + 1, status: 'pending',
        proofread_round: 1, mismatch_count: 0, ocr_row_json: JSON.stringify(row), ocr_text: row.词条
      }
    }))
  }
  const multiSummary = await request(`/api/fangji/projects/${multi.id}/findings/recompute`, { method: 'POST', token: boss.token })
  assert.equal(multiSummary.pages, 3, JSON.stringify(multiSummary))
  const FINDING_IDS = ['cross_source_conflict', 'strong_findings_ge_2', 'strong_findings_eq_1', 'warn_findings_ge_3']
  const currentOf = async (pageId) => (await request(
    `/api/collections/review_findings/records?perPage=200&filter=${encodeURIComponent(`page = "${pageId}" && superseded_at = ""`)}`,
    { token: superAuth.token })).items
  const stored = []
  for (const [index, page] of pages.entries()) {
    const findings = await currentOf(page.id)
    const row = await request(`/api/collections/pages/records/${page.id}`, { token: superAuth.token })
    const basis = JSON.parse(row.difficulty_basis_json || '[]')
    stored.push({ tier: row.difficulty_tier, basis, findings })
    const fromFindings = basis.filter((id) => FINDING_IDS.includes(id))
    // 由疑点推导出来的 basis 必须与**这一条自己**的当前批次数量一致。
    const strong = findings.filter((item) => item.severity === 'strong').length
    if (!strong) assert.deepEqual(fromFindings.filter((id) => id.startsWith('strong_')), [],
      `第 ${index + 1} 条零 strong 疑点却带了 ${JSON.stringify(fromFindings)}：${JSON.stringify(basis)}`)
    else assert.equal(fromFindings.includes(strong >= 2 ? 'strong_findings_ge_2' : 'strong_findings_eq_1'), true,
      `第 ${index + 1} 条有 ${strong} 条 strong 疑点，basis 却没有对应项：${JSON.stringify(basis)}`)
  }
  const [silentPage, firstFlagged, secondFlagged] = stored
  assert.equal(silentPage.findings.length, 0,
    `第一条必须是零疑点的干净条目，实际 ${JSON.stringify(silentPage.findings.map((f) => f.message_key))}`)
  assert.deepEqual(silentPage.basis.filter((id) => FINDING_IDS.includes(id)), [],
    `干净条目被算进了别人的疑点：${JSON.stringify(silentPage.basis)}`)
  assert.ok(firstFlagged.findings.length >= 1 && secondFlagged.findings.length >= 1,
    '另两条必须各自产出疑点，否则上面的比较没有意义')

  // 空项目也要能跑，且不给假数字。
  emptyProject = await request('/api/fangji/projects', {
    method: 'POST', token: platformAuth.token, expected: 201, body: { name: `Empty ${suffix}` }
  })
  await request(`/api/fangji/projects/${emptyProject.id}/members/${boss.id}`, { method: 'PUT', token: platformAuth.token, body: { role: 'manager' } })
  const empty = await request(`/api/fangji/projects/${emptyProject.id}/findings/recompute`, { method: 'POST', token: boss.token })
  assert.equal(empty.pages, 0)
  assert.equal(empty.findings, 0)
  assert.deepEqual(empty.difficulty_tiers, { A: 0, B: 0, C: 0, unknown: 0 })

  console.log('Task difficulty integration test passed.')
} finally {
  await request(`/api/fangji/projects/${project.id}`, { method: 'DELETE', token: platformAuth.token, expected: 204 })
  if (multi) {
    await request(`/api/fangji/projects/${multi.id}`, { method: 'DELETE', token: platformAuth.token, expected: 204 })
  }
  if (emptyProject) {
    await request(`/api/fangji/projects/${emptyProject.id}`, { method: 'DELETE', token: platformAuth.token, expected: 204 })
  }
  for (const id of userIds.reverse()) {
    await request(`/api/collections/users/records/${id}`, { method: 'DELETE', token: superAuth.token, expected: 204 })
  }
}
