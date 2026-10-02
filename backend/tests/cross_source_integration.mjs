import assert from 'node:assert/strict'

// #178 跨来源冲突的端到端套件。
//
// 纯函数层的三向判定在 identity_integration.mjs 里已经钉住，这里要证的是**另一件事**：
// 登记来源要能真的从导入批次流到身份判据里。写入端原来拿 `project_file` 当 source 用
// （#169 落地前的替身）——文件不是来源：同一来源可以分多个文件导入，不同来源也能合成
// 一个文件，用它判跨来源会同时造出漏报与误报。所以这条链路必须用真实对象跑一遍：
// 建 sources → 带 source_id 导入 → identity/recompute → 疑点落库 → findings/recompute → tier 上 C。
//
// C 档在这一支之前是"判定表里有、实际到不了"的：cross_source_conflict 是 TIER_RULES 里
// 唯一一条 C 判据，而它从来没有生产者。这段断言就是那个缺口被补上的证据。
const base = process.env.PB_URL || 'http://127.0.0.1:18091'

async function api(path, { method = 'GET', token = '', body, status = 200 } = {}) {
  const form = body instanceof FormData
  const response = await fetch(base + path, {
    method,
    headers: { Authorization: token, ...(!form && body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? (form ? body : JSON.stringify(body)) : undefined
  })
  const raw = await response.text()
  let data = null
  if (raw) { try { data = JSON.parse(raw) } catch { data = raw } }
  assert.equal(response.status, status, `${method} ${path} -> ${response.status} ${raw}`)
  return data
}

const platform = await api('/api/collections/users/auth-with-password', {
  method: 'POST', body: { identity: process.env.APP_ADMIN_EMAIL, password: process.env.APP_ADMIN_PASSWORD }
})
const token = platform.token
const superAuth = await api('/api/collections/_superusers/auth-with-password', {
  method: 'POST', body: { identity: process.env.PB_SUPER_EMAIL, password: process.env.PB_SUPER_PASSWORD }
})

const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`
const HEADERS = '词条,拼音,释义,PDF页码'

async function createProject(name) {
  return api('/api/fangji/projects', { method: 'POST', token, body: { name }, status: 201 })
}

async function createSource(label) {
  // logical_id 由服务端生成（/^src-[0-9a-f]{8}$/），不能自带。
  return api('/api/fangji/sources', {
    method: 'POST', token, status: 201,
    body: {
      title: `跨来源夹具 ${label} ${suffix}`, format: 'csv',
      holder: '测试权利主体', scope: '测试地区', status: 'restricted'
    }
  })
}

// 两段等待都要做：只等 validated 就 commit、commit 之后不确认 completed，
// 对照组可能只落进一条条目，"同来源不许报跨来源"会变成因为没得比而通过的空断言。
async function importCsv(projectId, csv, name, sourceLogicalId = '') {
  const form = new FormData()
  form.set('file', new Blob([csv]), name)
  form.set('inspect_only', 'true')
  if (sourceLogicalId) form.set('source_id', sourceLogicalId)
  const job = await api(`/api/fangji/projects/${projectId}/imports/csv`, { method: 'POST', token, body: form, status: 202 })
  for (const want of ['validated', 'completed']) {
    let settled = false
    for (let i = 0; i < 200 && !settled; i++) {
      const current = await api(`/api/collections/import_jobs/records/${job.id}`, { token })
      assert.notEqual(current.status, 'failed', `${want}: ${JSON.stringify(current)}`)
      if (current.status === want) settled = true
      else await new Promise((resolve) => setTimeout(resolve, 100))
    }
    assert.ok(settled, `导入作业没有进入 ${want}`)
    if (want === 'validated') await api(`/api/fangji/imports/${job.id}/commit`, { method: 'POST', token, status: 202 })
  }
  return job
}

async function findingsOf(projectId) {
  const view = await api(`/api/fangji/projects/${projectId}/findings`, { token })
  return view.items
}

// ---------- 主夹具：同一身份、两个登记来源、释义互斥 ----------
const project = await createProject(`跨来源夹具 ${suffix}`)
const sourceA = await createSource('A')
const sourceB = await createSource('B')
await importCsv(project.id, `${HEADERS}\n人,lang2,人类,1\n`, 'a.csv', sourceA.logical_id)
await importCsv(project.id, `${HEADERS}\n人,lang2,别人,2\n`, 'b.csv', sourceB.logical_id)

const identityRun = await api(`/api/fangji/projects/${project.id}/identity/recompute`, { method: 'POST', token })
assert.ok(identityRun.findings >= 2, `两条条目应各产一条跨来源疑点，实得 ${JSON.stringify(identityRun)}`)
assert.equal(identityRun.producer_version, 'identity-v3')
// 两个来源都登记齐了，所以"来源不足"的计数必须是 0——它是最容易悄悄变绿的数字。
assert.equal(identityRun.unattributed_groups, 0, JSON.stringify(identityRun))
assert.equal(identityRun.difficulty_stale, true, '跨行检出不刷 tier，必须显式告诉调用方')

const items = await findingsOf(project.id)
const cross = items.filter((item) => item.kind === 'cross_source_conflict')
assert.equal(cross.length, 2, `同一身份的两条各应有一条跨来源疑点：${JSON.stringify(items.map((i) => [i.kind, i.message.key]))}`)
for (const item of cross) {
  assert.equal(item.message.key, 'same_identity_across_sources')
  assert.equal(item.severity, 'strong')
  assert.deepEqual(item.message.params.differs_on, ['释义'])
  assert.equal(item.message.params.sources.length, 2, '冲突来源集合要如实列出两个登记来源')
  assert.equal(item.producer_version, 'identity-v3', '判据语义变更必须升版，否则新旧批次混在同一档位身份下')
  assert.equal(item.evidence.anchor, 'entry')
  // 词头/记音/释义的字面值不许进 params（review-findings.md §8.1 按绝对解释执行）
  const serialized = JSON.stringify(item.message.params)
  for (const leaked of ['lang2', '人类', '别人']) {
    assert.equal(serialized.includes(leaked), false, `params 里出现了内容字面值 ${leaked}：${serialized}`)
  }
}
// 两个 kind 互斥：同一事实不许有两份疑点（那会把 tier 推两次、队列里也出现重复条目）。
assert.equal(items.some((item) => item.kind === 'duplicate_identity'), false,
  JSON.stringify(items.map((i) => i.kind)))

// ---------- C 档：cross_source_conflict 是 TIER_RULES 里唯一一条 C 判据 ----------
const difficultyRun = await api(`/api/fangji/projects/${project.id}/findings/recompute`, { method: 'POST', token })
assert.equal(difficultyRun.pages, 2, JSON.stringify(difficultyRun))
assert.equal(difficultyRun.difficulty_tiers?.C, 2,
  `重算收尾应把两条都推到 C，实得 ${JSON.stringify(difficultyRun.difficulty_tiers)}`)
const pages = await api(`/api/collections/pages/records?filter=${encodeURIComponent(`project="${project.id}"`)}`, { token })
const tiered = pages.items.filter((page) => page.difficulty_tier === 'C')
assert.equal(tiered.length, 2, `两条都应因跨来源冲突落 C，实得 ${JSON.stringify(pages.items.map((p) => [p.page_number, p.difficulty_tier, p.difficulty_basis_json]))}`)
for (const page of tiered) assert.match(page.difficulty_basis_json, /cross_source_conflict/)

// ---------- 对照组 1：同一来源的两批，必须退回 duplicate_identity ----------
const control = await createProject(`同来源对照 ${suffix}`)
await importCsv(control.id, `${HEADERS}\n人,lang2,人类,1\n`, 'one.csv', sourceA.logical_id)
await importCsv(control.id, `${HEADERS}\n人,lang2,别人,2\n`, 'two.csv', sourceA.logical_id)
const controlRun = await api(`/api/fangji/projects/${control.id}/identity/recompute`, { method: 'POST', token })
assert.equal(controlRun.unattributed_groups, 1,
  `同来源这一组要计入"来源不足以判跨来源"，实得 ${JSON.stringify(controlRun)}`)
const controlItems = await findingsOf(control.id)
assert.equal(controlItems.some((item) => item.kind === 'cross_source_conflict'), false,
  '同一来源内部的分歧不许升级成跨来源冲突——那会把"两次录入不一致"说成"两份材料互斥"')
assert.ok(controlItems.some((item) => item.kind === 'duplicate_identity'),
  `对照组应落 duplicate_identity，实得 ${JSON.stringify(controlItems.map((i) => i.kind))}`)

// ---------- 对照组 2：完全没关联来源，同样不许凭空报跨来源（#178 正文要求） ----------
const unknownSource = await createProject(`无来源对照 ${suffix}`)
await importCsv(unknownSource.id, `${HEADERS}\n人,lang2,人类,1\n`, 'u1.csv')
await importCsv(unknownSource.id, `${HEADERS}\n人,lang2,别人,2\n`, 'u2.csv')
await api(`/api/fangji/projects/${unknownSource.id}/identity/recompute`, { method: 'POST', token })
const unknownItems = await findingsOf(unknownSource.id)
assert.equal(unknownItems.some((item) => item.kind === 'cross_source_conflict'), false,
  '来源未知时只报同身份分歧，避免虚假结论')
assert.ok(unknownItems.some((item) => item.kind === 'duplicate_identity'),
  JSON.stringify(unknownItems.map((i) => i.kind)))

// ---------- #170 列角色：换正本（列名不是莆仙词表）时判据要跟着走 ----------
// 这一节证的是**接线**，不是纯函数：identityColumns() 在 identity_integration.mjs 里已经能算，
// 但如果 recomputeIdentity 不把项目的 column_roles_json 传进去，跨行检出对蒙古语正本就是
// 一条都产不出来，而响应里只会显示"这一批很干净"。所以先跑未标角色的对照，再标角色跑第二遍，
// 两次都断言 identity_column_source，让回退路径留在响应里可看见。
const MONGO_HEADERS = '词,转写,含义,PDF页码'
const mongoProject = await createProject(`跨来源角色夹具 ${suffix}`)
await importCsv(mongoProject.id, `${MONGO_HEADERS}\nаа,aa,父亲,1\n`, 'm1.csv', sourceA.logical_id)
await importCsv(mongoProject.id, `${MONGO_HEADERS}\nаа,aa,大叔,2\n`, 'm2.csv', sourceB.logical_id)

const beforeRoles = await api(`/api/fangji/projects/${mongoProject.id}/identity/recompute`, { method: 'POST', token })
assert.equal(beforeRoles.identity_column_source, 'hardcoded',
  '未标列角色时必须显式暴露"用的是硬编码词表"')
assert.equal(beforeRoles.unkeyed_rows, 2, JSON.stringify(beforeRoles))
assert.equal(beforeRoles.findings, 0, `词表认不得的列名不该产疑点：${JSON.stringify(beforeRoles)}`)
assert.equal((await findingsOf(mongoProject.id)).length, 0)

await api(`/api/fangji/projects/${mongoProject.id}/column-roles`, {
  method: 'PUT', token,
  body: { roles: { 词: 'headword', 转写: 'reading', 含义: 'meaning' } }
})
const afterRoles = await api(`/api/fangji/projects/${mongoProject.id}/identity/recompute`, { method: 'POST', token })
assert.equal(afterRoles.identity_column_source, 'roles', JSON.stringify(afterRoles))
assert.equal(afterRoles.unkeyed_rows, 0, '标了角色后这些行必须真的进入比较')
assert.ok(afterRoles.findings >= 2, JSON.stringify(afterRoles))
assert.equal(afterRoles.uncomparable_groups, 0, `标齐了三段角色就不该有"没在比较"的组：${JSON.stringify(afterRoles)}`)
const mongoItems = (await findingsOf(mongoProject.id)).filter((i) => i.kind === 'cross_source_conflict')
assert.equal(mongoItems.length, 2, JSON.stringify((await findingsOf(mongoProject.id)).map((i) => i.kind)))
for (const item of mongoItems) {
  assert.deepEqual(item.message.params.differs_on, ['含义'],
    '分歧列名来自角色，不能再是写死的「释义」')
}

// 再把角色退回到"只标词头与记音"：这一格走角色路径、可比列为空，于是同一条数据
// 从"2 条跨来源冲突"掉到 0。0 本身不是错，错的是没人说得清它为什么是 0 ——
// uncomparable_groups 必须报出"这一组根本没被比较"（#238 评审阻断 2 要求端到端可测）。
await api(`/api/fangji/projects/${mongoProject.id}/column-roles`, {
  method: 'PUT', token,
  body: { roles: { 词: 'headword', 转写: 'reading' } }
})
const bareRun = await api(`/api/fangji/projects/${mongoProject.id}/identity/recompute`, { method: 'POST', token })
assert.equal(bareRun.identity_column_source, 'roles', JSON.stringify(bareRun))
assert.equal(bareRun.findings, 0, `可比列为空时不该凭空产疑点：${JSON.stringify(bareRun)}`)
assert.equal(bareRun.uncomparable_groups, 1, JSON.stringify(bareRun))
assert.equal(bareRun.unkeyed_rows, 0, '身份键仍然有效，所以这不是"没算出键"那一格')

for (const projectId of [project.id, control.id, unknownSource.id, mongoProject.id]) {
  await api(`/api/collections/projects/records/${projectId}`, { method: 'DELETE', token: superAuth.token, status: 204 })
}

console.log('PASS: 登记来源能从导入批次流到身份判据，跨来源冲突各报一条并推 C 档，同来源与无来源两组对照都退回 duplicate_identity')
