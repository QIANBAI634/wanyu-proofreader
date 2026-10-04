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
// 校对员拿到的是"哪一条"，不是"这条被机器标成几等"——后者是别人对这条的判断，
// 输入里含 `blocked_reason` 这种人工结论（#239 结论 A 之后已不含任何来自他人 attempt 的东西）。
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

// ---------- #244：同 PDF 页邻接 与 难度优先 的组合 ----------
//
// #232 把循环改成「filters 在外、passes 在内」，为的就是这一条：同页的兄弟条目不许被
// 「全项目还剩一条 A」抢走。`tier_dispatch`（本文件上半）与 `pdf_reuse` 各测了一半，
// 两套可以同时全绿而组合是坏的——那正是评审留下的这条测试债。
//
// 夹具刻意摆成：pn1/pdf1 = A（先领走并提交）、pn2/pdf1 = B（同页兄弟）、
// pn3/pdf2 = A（干扰项）。旧的 passes 外层顺序会先扫全项目找 A 而给出 pn3；
// 新顺序必须先给 pn2。这条断言就是 #244 验收第 4 条要的变异验证靶子。
function comboPDF() {
  const objects = ['', '<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R 4 0 R 5 0 R 6 0 R] /Count 4 >>']
  for (let i = 0; i < 4; i += 1) {
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 11 0 R >> >> /Contents ${7 + i} 0 R >>`)
  }
  for (let i = 0; i < 4; i += 1) {
    const content = `BT /F1 24 Tf 50 700 Td (COMBO_PAGE_${i + 1}) Tj ET\n`
    objects.push(`<< /Length ${content.length} >>\nstream\n${content}endstream`)
  }
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')
  let out = '%PDF-1.4\n'
  const offsets = [0]
  for (let i = 1; i < objects.length; i += 1) { offsets.push(out.length); out += `${i} 0 obj\n${objects[i]}\nendobj\n` }
  const xref = out.length
  out += `xref\n0 ${objects.length}\n0000000000 65535 f \n`
  for (const offset of offsets.slice(1)) out += `${String(offset).padStart(10, '0')} 00000 n \n`
  return out + `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
}

// 邻接筛选读的是 project_files（status=ready + 同 file），而 CSV 导入不建这个记录，
// 所以这一支必须走真 PDF 上传；tier 仍然由真实生产者算（列角色 + 项目级重算），
// 不手工 UPDATE difficulty_tier——与上面那半份套件的纪律一致。
const combo = await api('/api/fangji/projects', { method: 'POST', token, body: { name: `组合领取夹具 ${suffix}` }, status: 201 })
const pdfForm = new FormData()
pdfForm.set('file', new Blob([comboPDF()], { type: 'application/pdf' }), 'combo.pdf')
const queued = await api(`/api/fangji/projects/${combo.id}/files/pdf`, { method: 'POST', token, body: pdfForm, status: 202 })
let comboFile = null
for (let i = 0; i < 200; i += 1) {
  comboFile = await api(`/api/collections/project_files/records/${queued.id}`, { token })
  if (comboFile.status === 'ready') break
  assert.notEqual(comboFile.status, 'failed', JSON.stringify(comboFile))
  await new Promise((resolve) => setTimeout(resolve, 100))
}
assert.equal(comboFile.status, 'ready', JSON.stringify(comboFile))

// 四个格子要能各自失效，夹具就得让"同页内 A 排在 B 之后"与"别页还有 A"同时成立：
// pn1/pdf1=A 先被领走；pn2/pdf1=B 的 page_number 比 pn3/pdf1=A 小，所以邻接层内
// 若不走层级偏好，第一个撞到的就是 B；pn4/pdf2=A 则是邻接层空手时的干扰项，
// 用来钉"层级在外层会抢走同页兄弟"这个旧 bug。
const comboRows = [
  { page_number: 1, pdf_page: 1, 词头: '甲', 莆田IPA: 'kʰin1' },
  { page_number: 2, pdf_page: 1, 词头: '乙', 莆田IPA: 'kʰin9876' },
  { page_number: 3, pdf_page: 1, 词头: '丙', 莆田IPA: 'kʰin1' },
  { page_number: 4, pdf_page: 2, 词头: '丁', 莆田IPA: 'kʰin1' }
]
const comboPages = []
for (const row of comboRows) {
  const values = { 词头: row.词头, 莆田IPA: row.莆田IPA }
  comboPages.push(await api('/api/collections/pages/records', {
    method: 'POST', token: superAuth.token,
    body: {
      project: combo.id, project_file: comboFile.id,
      page_number: row.page_number, pdf_page: row.pdf_page,
      ocr_row_json: JSON.stringify(values), ocr_text: row.词头,
      row_headers_json: JSON.stringify(['词头', '莆田IPA']),
      proofread_round: 1, mismatch_count: 0, status: 'pending'
    }
  }))
}
await api(`/api/fangji/projects/${combo.id}/column-roles`, {
  method: 'PUT', token, body: { roles: { 词头: 'headword', 莆田IPA: 'reading' } }
})
await api(`/api/fangji/projects/${combo.id}/findings/recompute`, { method: 'POST', token })
const comboFresh = await api(`/api/collections/pages/records?filter=${encodeURIComponent(`project="${combo.id}"`)}`, { token })
const comboTier = new Map(comboFresh.items.map((page) => [page.page_number, page.difficulty_tier]))
assert.deepEqual([...comboTier.entries()].sort(), [[1, 'A'], [2, 'B'], [3, 'A'], [4, 'A']],
  `组合夹具的档位没摆对：${JSON.stringify([...comboTier.entries()])}`)

const comboReader = await api('/api/collections/users/records', {
  method: 'POST',
  body: { email: `tier-combo-${suffix}@example.com`, name: `tier-combo-${suffix}`, role: 'user', password, passwordConfirm: password }
})
await api(`/api/fangji/projects/${combo.id}/members/${comboReader.id}`, { method: 'PUT', token, body: { role: 'proofreader' } })
const comboAuth = await api('/api/collections/users/auth-with-password', {
  method: 'POST', body: { identity: `tier-combo-${suffix}@example.com`, password }
})
const comboClaim = (body = {}) => api(`/api/fangji/projects/${combo.id}/claim`, { method: 'POST', token: comboAuth.token, body })
// 提交内容按**该条自己的行**取：写死一份 rowJson 现在不影响结论，但以后谁在这段上
// 追加"提交后 tier 会不会变"之类的断言，写死的那份会先咬他一口。
const rowByPage = new Map(comboPages.map((page, index) => [page.id, comboRows[index]]))
const comboSubmit = (task) => {
  const row = rowByPage.get(task.id)
  return api(`/api/fangji/pages/${task.id}/submit`, {
    method: 'POST', token: comboAuth.token,
    body: { rowJson: JSON.stringify({ 词头: row.词头, 莆田IPA: row.莆田IPA }), text: row.词头, leaseToken: task.leaseToken }
  })
}

const firstCombo = await comboClaim()
assert.equal(firstCombo.id, comboPages[0].id, `默认应先给 A 类里的第 1 页，实得 ${JSON.stringify(firstCombo)}`)
await comboSubmit(firstCombo)

// 格子一（邻接层**内部**的层级偏好）：同页剩 pn2=B（page_number 更小）与 pn3=A。
// 层级判定若只在最外层生效，这里会先撞到 pn2 —— 评审抓到的就是这一格以前从没被走过。
const samePagePreferred = await comboClaim({ previousTaskId: firstCombo.id })
assert.equal(samePagePreferred.id, comboPages[2].id,
  `同页内 A 没赢过排在它前面的 B（拿到第 ${samePagePreferred.page_number} 页 = 邻接层没走层级偏好）`)
await comboSubmit(samePagePreferred)

// 格子二（邻接优先于全项目）：同页只剩 pn2=B，别页还有 pn4=A。
// 旧的 passes 外层顺序会先扫全项目找 A 而给出 pn4，这一条就是它的变异靶子。
const adjacent = await comboClaim({ previousTaskId: samePagePreferred.id })
assert.equal(adjacent.id, comboPages[1].id,
  `同 PDF 页兄弟条目被全项目的 A 抢走了（拿到第 ${adjacent.page_number} 页 = 旧循环顺序）`)
await comboSubmit(adjacent)

// 格子三（同页耗尽才回到全项目）：仍然 A 优先。
const fallback = await comboClaim({ previousTaskId: adjacent.id })
assert.equal(fallback.id, comboPages[3].id, `同页无可领取项后应回到全项目，实得 ${JSON.stringify(fallback)}`)
assert.equal(fallback.page_number, 4)

// 显式层级仍是硬筛选：组合夹具里没有 C 档，找不到就 404，不许悄悄给一条别的档。
await comboSubmit(fallback)
await api(`/api/fangji/projects/${combo.id}/claim`, { method: 'POST', token: comboAuth.token, body: { tier: 'C' }, status: 404 })

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

for (const projectId of [labeled.id, unlabeledProject.id, combo.id]) {
  await api(`/api/collections/projects/records/${projectId}`, { method: 'DELETE', token: superAuth.token, status: 204 })
}

console.log('PASS: 默认优先 A 类会跳过排在最前的 B 条目，显式层级是筛选而非提示，无层级数据时逐字退回原行为，邻接层内部仍 A 优先且邻接优先于全项目的 A，权限边界未退化')
