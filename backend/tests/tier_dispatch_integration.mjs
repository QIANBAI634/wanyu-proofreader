import assert from 'node:assert/strict'

// #162 按任务难度 A/B/C 分层派发。
//
// 这份套件的核心不是"tier 能不能筛"，而是**默认优先 A 有没有真的改变领取结果**：
// 夹具刻意把标着 B 的那一条放在**第 1 页**，A 放在第 2、3 页。今天的领取按
// `page_number,id` 升序，默认必然给第 1 页；加了层级偏好之后必须给第 2 页。
// 如果反过来把 A 放在第 1 页，这条断言在改动前后都会绿——那就是恒真测试。
//
// tier 一律走**真实生产者**（导入 → 项目级重算 → deriveDifficulty），不手工 UPDATE
// difficulty_tier：手工置值只能证明筛选 SQL 正确，证明不了"大厅里那个数字是算出来的"。
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
const password = 'TierDispatch123!'

async function importCsv(projectId, csv) {
  const upload = new FormData()
  upload.set('file', new Blob([csv]), 'tier.csv')
  upload.set('inspect_only', 'true')
  const job = await api(`/api/fangji/projects/${projectId}/imports/csv`, { method: 'POST', token, body: upload, status: 202 })
  for (let i = 0; i < 200; i++) {
    const current = await api(`/api/collections/import_jobs/records/${job.id}`, { token })
    if (['validated', 'failed'].includes(current.status)) { assert.equal(current.status, 'validated', JSON.stringify(current)); break }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  await api(`/api/fangji/imports/${job.id}/commit`, { method: 'POST', token, status: 202 })
  for (let i = 0; i < 200; i++) {
    const current = await api(`/api/collections/import_jobs/records/${job.id}`, { token })
    if (['completed', 'failed'].includes(current.status)) { assert.equal(current.status, 'completed', JSON.stringify(current)); break }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

async function readerFor(projectId) {
  const user = await api('/api/collections/users/records', {
    method: 'POST',
    body: {
      email: `tier-reader-${suffix}@example.com`, name: `tier-reader-${suffix}`, role: 'user',
      password, passwordConfirm: password
    }
  })
  await api(`/api/fangji/projects/${projectId}/members/${user.id}`, { method: 'PUT', token, body: { role: 'proofreader' } })
  const auth = await api('/api/collections/users/auth-with-password', {
    method: 'POST', body: { identity: `tier-reader-${suffix}@example.com`, password }
  })
  return auth
}

// 「记音」列用 kʰin… 而不是任何含 a/g/| 的值：那三个字符在 hinghwa 键盘里是可混淆映射，
// 会让 R2 以 warn 级命中每一格，于是"零疑点 → A 类"这条判据一条都走不到。
const labeledCsv = '词头,莆田IPA,PDF页码\n甲,kʰin9876,1\n乙,kʰin1,2\n丙,kʰin1,3\n'

const labeled = await api('/api/fangji/projects', { method: 'POST', token, body: { name: `分层派发夹具 ${suffix}` }, status: 201 })
await importCsv(labeled.id, labeledCsv)
await api(`/api/fangji/projects/${labeled.id}/column-roles`, {
  method: 'PUT', token, body: { roles: { 词头: 'headword', 莆田IPA: 'reading' } }
})
await api(`/api/fangji/projects/${labeled.id}/findings/recompute`, { method: 'POST', token })

const pages = await api(`/api/collections/pages/records?filter=${encodeURIComponent(`project="${labeled.id}"`)}`, { token })
const byNumber = new Map(pages.items.map((page) => [page.page_number, page]))
const first = byNumber.get(1)
assert.equal(first.difficulty_tier, 'B', `第 1 页应因 strong 疑点落 B，实得 ${JSON.stringify({ tier: first.difficulty_tier, basis: first.difficulty_basis_json })}`)
assert.match(first.difficulty_basis_json, /strong_findings_eq_1/)
assert.equal(byNumber.get(2).difficulty_tier, 'A', '照抄型零疑点应落 A')
assert.match(byNumber.get(2).difficulty_basis_json, /pure_transcription/)

// 大厅：层级计数必须与"可领取"口径一致，而不是条目总数。
const readerAuth = await readerFor(labeled.id)
const hall = await api('/api/fangji/proofreading-queues', { token: readerAuth.token })
const mine = hall.items.find((item) => item.project.id === labeled.id)
assert.ok(mine, `大厅里没有本项目：${JSON.stringify(hall.items.map((i) => i.project.id))}`)
assert.deepEqual(mine.tiers, { A: 2, B: 1, C: 0, other: 0, unlabeled: 0 }, JSON.stringify(mine))
assert.equal(mine.tierLabeled, 3)
assert.equal(mine.claimable, 3)

// 默认领取必须跳过排在最前的 B 类，给第 2 页那条 A —— 这一条是本套件的全部意义。
const preferred = await api(`/api/fangji/projects/${labeled.id}/claim`, { method: 'POST', token: readerAuth.token })
assert.equal(preferred.id, byNumber.get(2).id, `默认应优先 A 类（第 2 页），实得 ${JSON.stringify(preferred)}`)
assert.equal(preferred.page_number, 2)
// 红线（task-difficulty.md §6）：tier 不出现在校对端任何响应里。分层由服务端完成，
// 校对员拿到的是"哪一条"，不是"这条被机器标成几等"——后者的输入含历史仲裁进入率，
// 那已经是关于别人反复在这条上出事的线索了。
for (const forbidden of ['difficulty_tier', 'difficulty_basis_json', 'difficulty_version', 'blocked_reason', 'round', 'pass_no']) {
  assert.equal(preferred[forbidden], undefined, `领取响应里出现了 ${forbidden}：${JSON.stringify(preferred)}`)
}

// 显式指定层级：拿到的是 B 类那条（第 1 页），证明 tier 是筛选而不是排序提示。
await api(`/api/fangji/pages/${preferred.id}/release`, { method: 'POST', token: readerAuth.token, body: { lease_token: preferred.leaseToken }, status: 204 })
const explicit = await api(`/api/fangji/projects/${labeled.id}/claim`, {
  method: 'POST', token: readerAuth.token, body: { tier: 'B' }
})
assert.equal(explicit.id, first.id, `显式 tier=B 应拿第 1 页，实得 ${JSON.stringify(explicit)}`)
assert.equal(explicit.difficulty_tier, undefined, '显式领层级也不该把档位回写给校对端')

// 该层级一条都没有时必须明说，不能悄悄给一条别的层级——否则大厅的筛选控件在说谎。
await api(`/api/fangji/pages/${explicit.id}/release`, { method: 'POST', token: readerAuth.token, body: { lease_token: explicit.leaseToken }, status: 204 })
await api(`/api/fangji/projects/${labeled.id}/claim`, {
  method: 'POST', token: readerAuth.token, body: { tier: 'C' }, status: 404
})
await api(`/api/fangji/projects/${labeled.id}/claim`, {
  method: 'POST', token: readerAuth.token, body: { tier: 'nonsense' }, status: 400
})

// 渐进增强的反面：一个从没算过 tier 的项目（导入后不重算），行为必须与今天逐字一致。
const unlabeledProject = await api('/api/fangji/projects', { method: 'POST', token, body: { name: `无层级夹具 ${suffix}` }, status: 201 })
await importCsv(unlabeledProject.id, '词头,莆田IPA,PDF页码\n甲,kʰin1,1\n乙,kʰin1,2\n')
const quietReader = await api('/api/collections/users/records', {
  method: 'POST',
  body: {
    email: `tier-quiet-${suffix}@example.com`, name: `tier-quiet-${suffix}`, role: 'user',
    password, passwordConfirm: password
  }
})
await api(`/api/fangji/projects/${unlabeledProject.id}/members/${quietReader.id}`, { method: 'PUT', token, body: { role: 'proofreader' } })
const quietAuth = await api('/api/collections/users/auth-with-password', {
  method: 'POST', body: { identity: `tier-quiet-${suffix}@example.com`, password }
})
const quietPages = await api(`/api/collections/pages/records?filter=${encodeURIComponent(`project="${unlabeledProject.id}"`)}`, { token })
const quietByNumber = new Map(quietPages.items.map((page) => [page.page_number, page]))
assert.equal(quietByNumber.get(1).difficulty_tier, '', '没重算过就该是空串，不能合成 unknown')
const quietHall = await api('/api/fangji/proofreading-queues', { token: quietAuth.token })
const quietRow = quietHall.items.find((item) => item.project.id === unlabeledProject.id)
assert.deepEqual(quietRow.tiers, { A: 0, B: 0, C: 0, other: 0, unlabeled: 2 })
assert.equal(quietRow.tierLabeled, 0)
// 无标签数据时退回「下一条」：拿到的是 page_number 最小的那条。
const quietClaim = await api(`/api/fangji/projects/${unlabeledProject.id}/claim`, { method: 'POST', token: quietAuth.token })
assert.equal(quietClaim.id, quietByNumber.get(1).id, `无层级数据时应退回原顺序，实得 ${JSON.stringify(quietClaim)}`)
// 显式筛一个空层级同样不许改口给别的层级。
// 注意顺序：手上还有未提交任务时，claim 的第一优先级是**把那条任务续发回来**（租约语义，
// 与层级无关）。这里必须先释放，否则测到的是续发而不是筛选。
const resumed = await api(`/api/fangji/projects/${unlabeledProject.id}/claim`, {
  method: 'POST', token: quietAuth.token, body: { tier: 'A' }
})
assert.equal(resumed.id, quietClaim.id, `带层级的 claim 应先续发手上任务，实得 ${JSON.stringify(resumed)}`)
await api(`/api/fangji/pages/${quietClaim.id}/release`, {
  method: 'POST', token: quietAuth.token, body: { lease_token: resumed.leaseToken }, status: 204
})
await api(`/api/fangji/projects/${unlabeledProject.id}/claim`, { method: 'POST', token: quietAuth.token, body: { tier: 'A' }, status: 404 })

// 权限边界不许因分层派发退化：非项目成员、以及项目管理员之外的身份都不能领。
const outsider = await api('/api/collections/users/records', {
  method: 'POST',
  body: { email: `tier-outsider-${suffix}@example.com`, name: `tier-outsider-${suffix}`, role: 'user', password, passwordConfirm: password }
})
const outsiderAuth = await api('/api/collections/users/auth-with-password', {
  method: 'POST', body: { identity: `tier-outsider-${suffix}@example.com`, password }
})
await api(`/api/fangji/projects/${labeled.id}/claim`, { method: 'POST', token: outsiderAuth.token, status: 403 })
await api(`/api/fangji/projects/${labeled.id}/claim`, { method: 'POST', token: outsiderAuth.token, body: { tier: 'A' }, status: 403 })
await api('/api/fangji/proofreading-queues', { token: outsiderAuth.token })

for (const projectId of [labeled.id, unlabeledProject.id]) {
  await api(`/api/collections/projects/records/${projectId}`, { method: 'DELETE', token: superAuth.token, status: 204 })
}

console.log('PASS: 默认优先 A 类会跳过排在最前的 B 条目，显式层级是筛选而非提示，无层级数据时逐字退回原行为，权限边界未退化')
