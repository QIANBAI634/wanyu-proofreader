import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

// #234 管理端机器疑点入口的接口侧套件。
//
// 它要钉住的核心不是"路由能返回 200"，而是那句话：
// **列级与页级判据只有跑过项目级重算才存在**。所以先证明它们在重算前确实不在，
// 再证明点一次按钮之后它们出现了 —— 这才是"没有入口就永远不会算"的反证。
// 反过来，如果只做"列表能读出来"的断言，那么哪怕重算入口永远没人接，套件照样全绿。
const require = createRequire(import.meta.url)
const identity = require('../pb_hooks/lib/assist_identity.js')

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
const password = 'AssistAdmin123!'
const project = await api('/api/fangji/projects', { method: 'POST', token, body: { name: `管理端疑点夹具 ${suffix}` }, status: 201 })

async function importCsv(csv) {
  const form = new FormData()
  form.set('file', new Blob([csv]), 'assist.csv')
  form.set('inspect_only', 'true')
  const job = await api(`/api/fangji/projects/${project.id}/imports/csv`, { method: 'POST', token, body: form, status: 202 })
  for (const want of ['validated', 'completed']) {
    let settled = false
    for (let i = 0; i < 200 && !settled; i++) {
      const current = await api(`/api/collections/import_jobs/records/${job.id}`, { token })
      assert.notEqual(current.status, 'failed', `${want}: ${JSON.stringify(current)}`)
      if (current.status === want) settled = true
      else await new Promise((resolve) => setTimeout(resolve, 100))
    }
    assert.ok(settled, `导入没有进入 ${want}`)
    if (want === 'validated') await api(`/api/fangji/imports/${job.id}/commit`, { method: 'POST', token, status: 202 })
  }
}

// 释义列里同时出现全角与半角括号 —— R4 是列级判据，必须看到整列才判得出来。
await importCsv('词条,拼音,释义,PDF页码\n甲,ka1,第一（个）测试,1\n乙,ka2,第二(个)测试,2\n')

async function findingsOf(query = '') {
  const view = await api(`/api/fangji/projects/${project.id}/findings${query}`, { token })
  return view
}

// 同一身份（词条+拼音 归一后相同）的两条：给跨行判据和人工结论对照组用。
await importCsv('词条,拼音,释义,PDF页码\n人,lang2,人类,3\n人,lang2,别人,4\n')

const before = await findingsOf()
assert.deepEqual(before.items, [], `重算前不该有任何疑点（列级判据没跑过）：${JSON.stringify(before.items)}`)

const recompute = await api(`/api/fangji/projects/${project.id}/findings/recompute`, { method: 'POST', token })
assert.ok(recompute.pages >= 2, JSON.stringify(recompute))
const after = await findingsOf()
const columnKinds = after.items.filter((item) => item.message.key === 'punctuation_width_mixed_in_column')
assert.ok(columnKinds.length >= 1,
  `点一次项目级重算后应出现列级标点判据，实得 ${JSON.stringify(after.items.map((i) => [i.kind, i.message.key]))}`)
for (const item of columnKinds) {
  assert.equal(item.field, '释义')
  // 管理端口必须带 gate 与判据数字，否则"off 仍统计"这半条设计无法核实。
  for (const field of ['gate', 'gate_sample_n', 'gate_precision_hat', 'producer', 'producer_version']) {
    assert.ok(Object.hasOwn(item, field), `统计口缺少 ${field}：${JSON.stringify(item)}`)
  }
}
// `gate_rows_truncated` 与 gate 放行通道同属 #230，本支基线上还没有那个字段，
// 所以这里不钉它；#230 的 gate_release 套件已经在端到端上钉过了。

// kind 与 producer 过滤器：白名单外的值只能退化成"不加该过滤"，绝不能被拼进过滤表达式。
// 这条不是假想：值里带 `") || (producer = "ocr` 时，一旦它进了 filter 文本，`&&` 的高优先级
// 会让后半段变成一条既不受 project 也不受 superseded_at 约束的析取分支，
// 任意项目的 manager 就能读到全库疑点。
const filtered = await findingsOf('?kind=page_outlier')
assert.deepEqual(filtered.items.map((item) => item.kind).filter((k) => k !== 'page_outlier'), [])
const hostile = await findingsOf(`?kind=${encodeURIComponent('punctuation_mix") || (producer = "ocr')}`)
assert.ok(hostile.items.length >= 1, '非法 kind 应退化为不加过滤，而不是报错或返回空')
assert.ok(hostile.items.every((item) => item.project === project.id),
  `过滤参数越权读到了别的项目：${JSON.stringify(hostile.items.map((i) => i.project))}`)
assert.ok(hostile.items.every((item) => item.producer === 'rule'), '注入出来的 producer 分支生效了')

// ---------- 人工结论的读路径（此前只写不读） ----------
const rows = [
  { 词条: '人', 拼音: 'lang2', 释义: '人类' },
  { 词条: '人', 拼音: 'lang2', 释义: '别人' }
]
const groupKey = identity.identityParts(rows[0]).key
assert.ok(groupKey, '拿不到分组键，下面的对照组就没有意义')
await api(`/api/fangji/projects/${project.id}/identity/recompute`, { method: 'POST', token })
const withIdentity = await findingsOf()
assert.ok(withIdentity.items.some((item) => item.kind === 'duplicate_identity'),
  `跨行重算应产出同身份分歧，实得 ${JSON.stringify(withIdentity.items.map((i) => i.kind))}`)

const beforeDismissals = await api(`/api/fangji/projects/${project.id}/dismissals`, { token })
assert.deepEqual(beforeDismissals.items, [], '新项目不该带着人工结论')

const dismissal = await api(`/api/fangji/projects/${project.id}/dismissals`, {
  method: 'POST', token, body: { group_key: groupKey, kind: 'duplicate_identity', note: '确认是两个词条' }
})
const listed = await api(`/api/fangji/projects/${project.id}/dismissals`, { token })
assert.equal(listed.items.length, 1, JSON.stringify(listed))
const only = listed.items[0]
assert.equal(only.id, dismissal.id)
assert.equal(only.group_key, groupKey)
assert.equal(only.kind, 'duplicate_identity')
assert.equal(only.status, 'not_conflict')
assert.match(only.note, /确认是两个词条/)
assert.ok(only.decided_by, '必须能看出是谁判的')
assert.equal(typeof only.decided_by_name, 'string')
assert.ok(only.created, '判定时间必须可读')
assert.equal(listed.truncated, false)
assert.ok(listed.limit >= 1)

// 结论生效：整组跳过，重算后不再报这一组
await api(`/api/fangji/projects/${project.id}/identity/recompute`, { method: 'POST', token })
assert.equal((await findingsOf()).items.some((item) => item.kind === 'duplicate_identity'), false,
  '人工结论必须在重算后保留')

await api(`/api/fangji/projects/${project.id}/dismissals/${only.id}`, { method: 'DELETE', token, status: 204 })
assert.deepEqual((await api(`/api/fangji/projects/${project.id}/dismissals`, { token })).items, [],
  '撤回后必须从列表里消失（撤回是物理删除，不留痕）')

// ---------- 权限矩阵：这个区块只对 manager，proofreader 与非成员一律 403 ----------
const member = await api('/api/collections/users/records', {
  method: 'POST',
  body: { email: `assist-member-${suffix}@example.com`, name: `assist-member-${suffix}`, role: 'user', password, passwordConfirm: password }
})
await api(`/api/fangji/projects/${project.id}/members/${member.id}`, { method: 'PUT', token, body: { role: 'proofreader' } })
const memberAuth = await api('/api/collections/users/auth-with-password', {
  method: 'POST', body: { identity: `assist-member-${suffix}@example.com`, password }
})
const outsider = await api('/api/collections/users/records', {
  method: 'POST',
  body: { email: `assist-outside-${suffix}@example.com`, name: `assist-outside-${suffix}`, role: 'user', password, passwordConfirm: password }
})
const outsiderAuth = await api('/api/collections/users/auth-with-password', {
  method: 'POST', body: { identity: `assist-outside-${suffix}@example.com`, password }
})

for (const [who, auth] of [['proofreader 成员', memberAuth], ['项目外用户', outsiderAuth]]) {
  await api(`/api/fangji/projects/${project.id}/dismissals`, { token: auth.token, status: 403 })
  await api(`/api/fangji/projects/${project.id}/findings`, { token: auth.token, status: 403 })
  await api(`/api/fangji/projects/${project.id}/findings/recompute`, { method: 'POST', token: auth.token, status: 403 })
  await api(`/api/fangji/projects/${project.id}/identity/recompute`, { method: 'POST', token: auth.token, status: 403 })
  await api(`/api/fangji/projects/${project.id}/dismissals`, { method: 'POST', token: auth.token, status: 403, body: { group_key: groupKey, kind: 'duplicate_identity' } })
  console.log(`PASS: ${who} 四个口与写入口全部 403`)
}
// 未登录也进不来
await api(`/api/fangji/projects/${project.id}/dismissals`, { status: 401 })

for (const projectId of [project.id]) {
  await api(`/api/collections/projects/records/${projectId}`, { method: 'DELETE', token: superAuth.token, status: 204 })
}

console.log('PASS: 列级判据只在项目级重算后存在、统计口带 gate 与判据数字、人工结论可读可撤、权限矩阵按身份收口')
