import assert from 'node:assert/strict'

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
    headers: {
      ...(token ? { Authorization: token } : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' })
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  })
  const raw = await response.text()
  let payload = null
  if (raw) {
    try { payload = JSON.parse(raw) } catch { payload = raw }
  }
  assert.equal(response.status, expected, `${method} ${path}: ${response.status} ${raw}`)
  return payload
}

const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`
const password = 'ReviewFindings123!'
const projectIds = []
const userIds = []
const gateIds = []
const findingIds = []

const platformAuth = await request('/api/collections/users/auth-with-password', {
  method: 'POST', body: { identity: platformEmail, password: platformPassword }
})
const superAuth = await request('/api/collections/_superusers/auth-with-password', {
  method: 'POST', body: { identity: superEmail, password: superPassword }
})

// 疑点响应里绝不允许出现的字段：他人的提交内容（#175 红线 1）与任何轮次线索。
const concealedKeys = [
  'round', 'pass_no', 'row_json', 'proofread_row_json', 'proofread_text',
  'first_proofreader', 'second_proofreader', 'proofread_round', 'submitted',
  'proofreader', 'reviewer', 'arbitrated_by', 'text'
]

function assertNothingConcealed(payload, label) {
  const serialized = JSON.stringify(payload)
  for (const field of concealedKeys) {
    assert.equal(serialized.includes(`"${field}"`), false, `${label} leaked ${field}`)
  }
}

async function createUser(label) {
  const email = `${label}-${suffix}@example.com`
  const user = await request('/api/collections/users/records', {
    method: 'POST', token: superAuth.token,
    body: { email, password, passwordConfirm: password, name: label, role: 'user' }
  })
  userIds.push(user.id)
  const auth = await request('/api/collections/users/auth-with-password', {
    method: 'POST', body: { identity: email, password }
  })
  return { ...user, token: auth.token }
}

async function createProject(name, users, managers = []) {
  const project = await request('/api/fangji/projects', {
    method: 'POST', token: platformAuth.token, expected: 201,
    body: { name: `${name} ${suffix}` }
  })
  projectIds.push(project.id)
  for (const user of users) {
    await request(`/api/fangji/projects/${project.id}/members/${user.id}`, {
      method: 'PUT', token: platformAuth.token, body: { role: 'proofreader' }
    })
  }
  for (const user of managers) {
    await request(`/api/fangji/projects/${project.id}/members/${user.id}`, {
      method: 'PUT', token: platformAuth.token, body: { role: 'manager' }
    })
  }
  return project
}

async function createPage(projectId, pageNumber) {
  return request('/api/collections/pages/records', {
    method: 'POST', token: superAuth.token,
    body: {
      project: projectId,
      page_number: pageNumber,
      pdf_page: pageNumber,
      ocr_row_json: JSON.stringify({ 词条: `条目${pageNumber}` }),
      ocr_text: `条目${pageNumber}`,
      proofread_round: 1,
      mismatch_count: 0,
      status: 'pending'
    }
  })
}

const gateRows = new Map()

async function setGate({ producer = 'rule', version = 'v1', kind, messageKey, gate, sampleN = 150, precision = 0.9 }) {
  const body = {
    producer,
    producer_version: version,
    kind,
    message_key: messageKey,
    gate,
    sample_n: sampleN,
    precision_hat: precision,
    evaluated_at: new Date().toISOString().slice(0, 10)
  }
  const key = `${producer}|${version}|${kind}|${messageKey}`
  // 登记表以规则身份为唯一键，改档必须 PATCH 同一行——重复 POST 会撞唯一索引。
  // #176 的「同一 kind 不同 message_key 可分别置档」正是靠这个键成立的。
  if (gateRows.has(key)) {
    return request(`/api/collections/assist_rule_gates/records/${gateRows.get(key)}`, {
      method: 'PATCH', token: superAuth.token, body
    })
  }
  const row = await request('/api/collections/assist_rule_gates/records', {
    method: 'POST', token: superAuth.token, body
  })
  gateRows.set(key, row.id)
  gateIds.push(row.id)
  return row
}

async function createFinding(page, project, {
  kind = 'merged_columns',
  messageKey = 'column_collapse',
  severity = 'strong',
  field = '词条',
  version = 'v1',
  params = {},
  evidence = {},
  producedAt = new Date().toISOString().slice(0, 10)
} = {}) {
  const row = await request('/api/collections/review_findings/records', {
    method: 'POST', token: superAuth.token,
    body: {
      page,
      project,
      field_name: field,
      kind,
      severity,
      message_key: messageKey,
      params_json: JSON.stringify(params),
      evidence_json: JSON.stringify(evidence),
      producer: 'rule',
      producer_version: version,
      produced_at: producedAt
    }
  })
  findingIds.push(row.id)
  return row
}

async function listFindings(filter) {
  const rows = await request(`/api/collections/review_findings/records?filter=${encodeURIComponent(filter)}`, {
    token: superAuth.token
  })
  return rows.items
}

const first = await createUser('findings-first')
const second = await createUser('findings-second')
const outsider = await createUser('findings-outsider')
const boss = await createUser('findings-manager')

try {
  const project = await createProject('Findings contract', [first, second], [boss])
  const pageA = await createPage(project.id, 1)
  const pageB = await createPage(project.id, 2)

  // ---- 未认证 / 非成员 / 未在手：一律拒绝（#176 验收：三类身份）----
  await request(`/api/fangji/pages/${pageA.id}/findings`, { expected: 401 })
  await request(`/api/fangji/pages/${pageA.id}/findings`, { token: outsider.token, expected: 403 })
  await request(`/api/fangji/projects/${project.id}/findings`, { token: outsider.token, expected: 403 })
  // 项目成员但条目不在手上：不给（否则猜到 pageId 就能读别人条目的疑点）
  await request(`/api/fangji/pages/${pageA.id}/findings`, { token: second.token, expected: 403 })
  await createFinding(pageA.id, project.id)
  await request(`/api/fangji/pages/${pageA.id}/findings`, { token: second.token, expected: 403 })

  // 先让 first 认领 pageA，之后才可读它的疑点
  const claim = await request(`/api/fangji/projects/${project.id}/claim`, {
    method: 'POST', token: first.token
  })
  assert.equal(claim.id, pageA.id)

  // ---- 登记表缺行 = off：仍写库、仍统计，但一条都不给校对端 ----
  const off = await request(`/api/fangji/pages/${pageA.id}/findings`, { token: first.token })
  assert.deepEqual(off.hints, [])
  const managerView = await request(`/api/fangji/projects/${project.id}/findings`, { token: boss.token })
  assert.equal(managerView.items.length, 1, 'off 档的 finding 必须仍在管理端可见')
  assert.equal(managerView.items[0].gate, 'off')
  assert.equal(managerView.items[0].highlight, undefined)

  // ---- gate=warn：放行 warn+strong，不高亮 ----
  await setGate({ kind: 'merged_columns', messageKey: 'column_collapse', gate: 'warn' })
  const warnish = await request(`/api/fangji/pages/${pageA.id}/findings`, { token: first.token })
  assert.equal(warnish.hints.length, 1)
  assert.equal(warnish.hints[0].highlight, false, 'warn 档不得高亮')
  assert.equal(warnish.hints[0].kind, 'merged_columns')
  assert.deepEqual(warnish.hints[0].message.params, {})
  assertNothingConcealed(warnish, 'warn-gated hints')

  // ---- info 永不进校对端，即便档位是 strong ----
  const infoRow = await createFinding(pageA.id, project.id, {
    kind: 'encoding_form_anomaly', messageKey: 'combining_marks_present', severity: 'info',
    field: '仙游IPA', params: { marks: ['0x303'] }
  })
  await setGate({ kind: 'encoding_form_anomaly', messageKey: 'combining_marks_present', gate: 'strong' })
  const withInfo = await request(`/api/fangji/pages/${pageA.id}/findings`, { token: first.token })
  assert.equal(withInfo.hints.length, 1, 'info 级 finding 不得出现在校对端')
  assert.equal(withInfo.hints[0].kind, 'merged_columns')
  const infoVisible = await request(`/api/fangji/projects/${project.id}/findings`, { token: boss.token })
  assert.ok(infoVisible.items.some((item) => item.id === infoRow.id), 'info 仍要能在管理端统计里查到')

  // ---- 同一 kind、不同 message_key 必须能分别置档 ----
  await createFinding(pageA.id, project.id, {
    kind: 'merged_columns', messageKey: 'phonetic_run_inside_meaning', severity: 'warn'
  })
  // 两条同 kind 的规则先都放行，再把其中一条置 off，才能证明门控是按规则身份
  // 而不是按 kind 起作用的。
  await setGate({ kind: 'merged_columns', messageKey: 'phonetic_run_inside_meaning', gate: 'warn' })
  await setGate({ kind: 'merged_columns', messageKey: 'column_collapse', gate: 'off' })
  const onlyOneRule = await request(`/api/fangji/pages/${pageA.id}/findings`, { token: first.token })
  assert.deepEqual(onlyOneRule.hints.map((hint) => hint.message.key), ['phonetic_run_inside_meaning'],
    '把 column_collapse 置 off 之后，同 kind 的另一条规则不应被连带关闭')
  assert.equal(onlyOneRule.hints[0].severity, 'warn')
  const siblingManagerView = await request(`/api/fangji/projects/${project.id}/findings?kind=merged_columns`, { token: boss.token })
  assert.equal(siblingManagerView.items.length, 2)

  // ---- gate=strong：strong 高亮、warn 仍作次要标记（下限语义，两档同集合）----
  await setGate({ kind: 'merged_columns', messageKey: 'column_collapse', gate: 'strong' })
  await setGate({ kind: 'merged_columns', messageKey: 'phonetic_run_inside_meaning', gate: 'strong' })
  const strongGated = await request(`/api/fangji/pages/${pageA.id}/findings`, { token: first.token })
  assert.equal(strongGated.hints.length, 2)
  const byKey = Object.fromEntries(strongGated.hints.map((hint) => [hint.message.key, hint]))
  assert.equal(byKey.column_collapse.highlight, true)
  assert.equal(byKey.column_collapse.severity, 'strong')
  assert.equal(byKey.phonetic_run_inside_meaning.highlight, false)
  assert.equal(byKey.phonetic_run_inside_meaning.severity, 'warn')

  // ---- warn 与 strong 放行的是同一个集合，只差高亮（门槛文件 §2 的下限语义）----
  // 上面两段各自只数了一个严重性：warn 档那一次页面上只有一条 strong 疑点，
  // strong 档这一次两条都在。把同一批疑点在两档之间来回切，才能证明
  // "多放行一档"不是靠集合变大实现的——两档集合相同，差的是高亮。
  await setGate({ kind: 'merged_columns', messageKey: 'column_collapse', gate: 'warn' })
  await setGate({ kind: 'merged_columns', messageKey: 'phonetic_run_inside_meaning', gate: 'warn' })
  const warnTier = await request(`/api/fangji/pages/${pageA.id}/findings`, { token: first.token })
  assert.deepEqual(warnTier.hints.map((hint) => hint.message.key).sort(),
    strongGated.hints.map((hint) => hint.message.key).sort(),
    `warn 档与 strong 档放行的集合必须相同：${JSON.stringify(warnTier.hints.map((hint) => hint.message.key))}`)
  assert.deepEqual(warnTier.hints.map((hint) => hint.severity).sort(),
    strongGated.hints.map((hint) => hint.severity).sort(), '同集合也要同严重性')
  assert.deepEqual(warnTier.hints.map((hint) => hint.highlight), [false, false],
    'warn 档下两条都不该高亮，包括 strong 级那条')
  assert.ok(strongGated.hints.some((hint) => hint.highlight === true),
    'strong 档至少有一条高亮，否则上面"只差高亮"的比较是在比两个空集')

  // 两档都关掉：校对端归零，管理端两条都在。
  await setGate({ kind: 'merged_columns', messageKey: 'column_collapse', gate: 'off' })
  await setGate({ kind: 'merged_columns', messageKey: 'phonetic_run_inside_meaning', gate: 'off' })
  const allOff = await request(`/api/fangji/pages/${pageA.id}/findings`, { token: first.token })
  assert.deepEqual(allOff.hints, [], '两条规则都置 off 后校对端不得还剩疑点')
  const offManager = await request(`/api/fangji/projects/${project.id}/findings?kind=merged_columns`, { token: boss.token })
  assert.equal(offManager.items.length, 2, 'off 只挡校对端，管理端统计两条都要在')

  // ---- 重算：写新批次 + 标旧批次 superseded_at，只读到最新批次，旧批次仍在库 ----
  // 第二个人认领到哪一页由两遍投票决定（默认拿到同一页做独立第二遍），
  // 所以这里按「second 实际在手的条目」断言，不假定具体是哪一页；
  // 本段用 kind=page_outlier 与前面的计数彼此隔离。
  await request(`/api/fangji/pages/${pageB.id}/findings`, { token: second.token, expected: 403 })
  const secondClaim = await request(`/api/fangji/projects/${project.id}/claim`, { method: 'POST', token: second.token })
  const held = secondClaim.id
  const batch = {
    kind: 'page_outlier', messageKey: 'batch_marker',
    producedAt: '2026-09-01', params: { reasons: ['old_batch'] }
  }
  const stale = await createFinding(held, project.id, batch)
  await setGate({ kind: 'page_outlier', messageKey: 'batch_marker', gate: 'warn' })
  const beforeRecompute = await request(`/api/fangji/pages/${held}/findings`, { token: second.token })
  assert.deepEqual(beforeRecompute.hints.map((hint) => hint.message.params), [{ reasons: ['old_batch'] }])
  const fresh = await createFinding(held, project.id, {
    ...batch, producedAt: '2026-09-02', params: { reasons: ['new_batch'] }
  })
  await request(`/api/collections/review_findings/records/${stale.id}`, {
    method: 'PATCH', token: superAuth.token, body: { superseded_at: new Date().toISOString().slice(0, 10) }
  })
  const afterRecompute = await request(`/api/fangji/pages/${held}/findings`, { token: second.token })
  assert.equal(afterRecompute.hints.length, 1, '只返回未 superseded 的当前批次')
  assert.deepEqual(afterRecompute.hints[0].message.params, { reasons: ['new_batch'] })
  const bothBatches = await listFindings(`page = "${held}" && kind = "page_outlier"`)
  assert.equal(bothBatches.length, 2, '旧批次必须留在库里（不覆写、不物删）')
  assert.ok(bothBatches.find((row) => row.id === stale.id).superseded_at !== '')
  assert.equal(bothBatches.find((row) => row.id === fresh.id).superseded_at, '')

  // ---- 不可覆写：除 superseded_at 之外的任何字段改动都要被拒 ----
  // held 是 pageB：两遍投票把第二个校对员派到下一页，不是重复派同一页。
  // page 的篡改目标必须是「另一页」，否则这是一次空操作，断言会恒真。
  const otherPage = held === pageA.id ? pageB.id : pageA.id
  for (const [field, value] of [['severity', 'info'], ['kind', 'merged_columns'],
    ['message_key', 'tampered'], ['produced_at', '2020-01-01'], ['params_json', '{"tampered":true}'],
    ['field_name', '释义'], ['round', 3], ['producer_version', 'v9'], ['page', otherPage]]) {
    await request(`/api/collections/review_findings/records/${fresh.id}`, {
      method: 'PATCH', token: superAuth.token, expected: 403, body: { [field]: value }
    })
  }
  const untouched = await listFindings(`id = "${fresh.id}"`)
  assert.equal(untouched.length, 1)
  assert.equal(untouched[0].severity, 'strong')
  assert.equal(untouched[0].kind, "page_outlier")

  // ---- 校对员不能用集合 API 直接读疑点（集合规则全 null，只有 fangji 路由放行）----
  await request('/api/collections/review_findings/records', { token: first.token, expected: 403 })
  await request('/api/collections/assist_rule_gates/records', { token: first.token, expected: 403 })
  // manager 也不得把 off 档的疑点当成校对端已放行
  const paged = await request(`/api/fangji/projects/${project.id}/findings?page=1&per=1`, { token: boss.token })
  assert.equal(paged.items.length, 1)
  assert.equal(paged.hasMore, true)
  assert.equal(paged.truncated, undefined)
  assert.equal(warnish.truncated, false, '未超上限时要显式说"没截断"（否则前端无法区分"没有"与"被截断"）')

  // 回归：kind / producer 是 URL 参数，曾经被原样拼进过滤表达式。
  // 塞一个 `x") || (producer = "rule` 就能在 && 优先级之外多出一条不受 project
  // 与 superseded_at 约束的析取分支 ⇒ 任意项目的 manager 可读全库疑点。
  // 枚举参数现在走白名单：非法值等同"没传这个参数"。
  const intruderProject = await createProject('Findings intruder', [], [boss])
  const intruderPage = await createPage(intruderProject.id, 1)
  await createFinding(intruderPage.id, intruderProject.id, { kind: 'merged_columns', messageKey: 'column_collapse' })
  const allOfProject = await request(`/api/fangji/projects/${project.id}/findings`, { token: boss.token })
  assert.ok(allOfProject.items.length >= 3,
    `注入用例要求本项目确实有多条当前批次，否则"等同没传参数"的比较是空真：${allOfProject.items.length}`)
  assert.ok(allOfProject.items.every((item) => item.project === project.id))

  for (const [name, payload] of [
    ['kind', 'x") || (producer = "rule'],
    ['producer', 'a") || (project != ""'],
    ['kind', 'merged_columns") || (kind = "page_outlier']
  ]) {
    const hit = await request(`/api/fangji/projects/${project.id}/findings?`
      + `${name}=${encodeURIComponent(payload)}`, { token: boss.token })
    assert.deepEqual(hit.items.map((item) => item.project).filter((id) => id !== project.id), [],
      `非法 ${name} 越界读到了别的项目：${JSON.stringify(hit.items.map((i) => [i.project, i.kind]))}`)
    assert.deepEqual(hit.items.map((item) => `${item.kind}`).sort(),
      allOfProject.items.map((item) => `${item.kind}`).sort(),
      `非法 ${name} 应当等同"没传这个参数"，而不是把结果筛成空集`)
  }

  console.log('Review findings integration test passed.')
} finally {
  for (const id of findingIds.reverse()) {
    await request(`/api/collections/review_findings/records/${id}`, { method: 'DELETE', token: superAuth.token, expected: 204 })
  }
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
