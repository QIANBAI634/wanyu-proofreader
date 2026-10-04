import assert from 'node:assert/strict'

// #228 门控放行通道的验收套件。逐条对着 issue 的 8 条验收标准断言。
//
// 与 findings_integration.mjs 的分工：那边测「gate 值如何影响下发」，用超级用户手工置档；
// 本套件测「档位是怎么来的、谁能改、改不动会怎样」，所以主疑点走**真实生产者**
// （列角色 + 项目级重算产出的 R5 missing_field），只有需要一个「没进变更集的规则」
// 当反向对照时才手工落一条别的身份的疑点。
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
  method: 'POST',
  body: { identity: process.env.APP_ADMIN_EMAIL, password: process.env.APP_ADMIN_PASSWORD }
})
const token = platform.token
const superAuth = await api('/api/collections/_superusers/auth-with-password', {
  method: 'POST',
  body: { identity: process.env.PB_SUPER_EMAIL, password: process.env.PB_SUPER_PASSWORD }
})

const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`
const password = 'GateRelease123!'
const gateIds = []

// 主夹具：一次 CSV 导入 + 列角色标注 + 项目级重算，产出真实的 R5 疑点。
const project = await api('/api/fangji/projects', { method: 'POST', token, body: { name: `门控放行夹具 ${suffix}` }, status: 201 })
const upload = new FormData()
upload.set('file', new Blob(['词头,释义,PDF页码\n同身份词头A,,1\n同身份词头B,合成释义,2\n']), 'gate.csv')
upload.set('inspect_only', 'true')
const job = await api(`/api/fangji/projects/${project.id}/imports/csv`, { method: 'POST', token, body: upload, status: 202 })
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

await api(`/api/fangji/projects/${project.id}/column-roles`, {
  method: 'PUT', token, body: { roles: { 词头: 'headword', 释义: 'meaning' } }
})
const recompute = await api(`/api/fangji/projects/${project.id}/findings/recompute`, { method: 'POST', token })
assert.ok(recompute.findings >= 1, `重算应至少产出一条疑点，实得 ${JSON.stringify(recompute)}`)

const pages = await api(`/api/collections/pages/records?filter=${encodeURIComponent(`project="${project.id}"`)}`, { token })
// 只认「空释义那一页」——它是 R5 的真实靶子。
const target = pages.items.find((page) => JSON.parse(page.ocr_row_json).释义 === '')
assert.ok(target, `没找到空释义条目：${JSON.stringify(pages.items.map((p) => p.ocr_row_json))}`)

const RULE_IDENTITY = {
  producer: 'rule',
  producer_version: 'l0-v1',
  kind: 'missing_field',
  message_key: 'required_role_field_empty'
}

const managerView = await api(`/api/fangji/projects/${project.id}/findings`, { token })
const seeded = managerView.items.find((item) => item.kind === RULE_IDENTITY.kind)
assert.ok(seeded, `管理端应看到 ${RULE_IDENTITY.kind}，实得 ${JSON.stringify(managerView.items.map((i) => i.kind))}`)
assert.equal(seeded.gate, 'off', '新登记的规则初始一律 off')
assert.equal(seeded.gate_sample_n, 0)
assert.equal(managerView.gate_rows_truncated, false, '统计口必须显式写 gate_rows_truncated')

// 校对员身份：把条目领在自己手上才有读 hints 的资格。
const reader = await api('/api/collections/users/records', {
  method: 'POST',
  body: {
    email: `gate-reader-${suffix}@example.com`, name: `reader-${suffix}`, role: 'user',
    password, passwordConfirm: password
  }
})
const readerAuth = await api('/api/collections/users/auth-with-password', {
  method: 'POST', body: { identity: `gate-reader-${suffix}@example.com`, password }
})
await api(`/api/fangji/projects/${project.id}/members/${reader.id}`, { method: 'PUT', token, body: { role: 'proofreader' } })
const claim = await api(`/api/fangji/projects/${project.id}/claim`, { method: 'POST', token: readerAuth.token })
assert.equal(claim.id, target.id, `套件假设领到的是空释义那条（页 1），实得 ${JSON.stringify(claim)}`)

const closedGate = await api(`/api/fangji/pages/${target.id}/findings`, { token: readerAuth.token })
assert.deepEqual(closedGate.hints, [], 'gate 全 off 时校对端必须一条不给')
// 验收标准 6：「gate 全 off」与「零疑点」必须在字段级可区分。
// 只有 hints: [] 时两者长得一模一样，而这正是把"没放行"读成"这批很干净"的入口。
assert.equal(closedGate.suppressed_by_gate, 1, '被门控挡掉的条数必须显式给出来')
assert.equal(closedGate.gate_rows_truncated, false)

// 门控表是全局的：项目 manager 也读不到，只有平台管理员可以。
await api('/api/fangji/gates', { token: readerAuth.token, status: 403 })
const emptyTable = await api('/api/fangji/gates', { token })
assert.equal(emptyTable.items.length, 0, '除测试夹具外不该有别的登记行')
assert.equal(emptyTable.truncated, false)

const entry = (over = {}) => ({ ...RULE_IDENTITY, ...over })
const approved = { approved_by: `gate-suite-${suffix}`, approved_at: new Date().toISOString() }

// 验收标准 4：判据不满足不得放行。warn 档要 n ≥ 150，这里 n=120 必须被拒。
const refused = await api('/api/fangji/gates/changeset', {
  method: 'POST', token,
  body: {
    changeset: `cs-refused-${suffix}`,
    entries: [entry({ gate: 'warn', sample_n: 120, precision_hat: 0.65, ...approved })]
  }
})
assert.equal(refused.applied, 0, JSON.stringify(refused))
assert.equal(refused.refused, 1)
assert.match(refused.entries[0].reason, /warn 档要求的 150/, `拒绝理由要说清缺哪一条，实得 ${refused.entries[0].reason}`)
assert.equal((await api('/api/fangji/gates', { token })).items.length, 0, '被拒的条目不许留下登记行')
assert.deepEqual((await api(`/api/fangji/pages/${target.id}/findings`, { token: readerAuth.token })).hints, [])

// 验收标准 4 的另一半：n=120、p̂=0.95 允许直接跳 strong（门槛文档 §5 明确允许跳档）。
const released = await api('/api/fangji/gates/changeset', {
  method: 'POST', token,
  body: {
    changeset: `cs-released-${suffix}`,
    entries: [entry({ gate: 'strong', sample_n: 120, precision_hat: 0.95, ...approved })]
  }
})
assert.equal(released.applied, 1, JSON.stringify(released))
const table = await api('/api/fangji/gates', { token })
assert.equal(table.items.length, 1)
const row = table.items[0]
gateIds.push(row.id ?? '')
assert.equal(row.gate, 'strong')
assert.equal(row.sample_n, 120)
assert.equal(row.precision_hat, 0.95)
assert.equal(row.approved_by, `gate-suite-${suffix}`)
assert.equal(row.changeset, `cs-released-${suffix}`)
assert.equal(row.applied_by, platform.record.id, '谁应用的必须落库，不能只写批准人')
assert.equal(row.revoked_at, '', '未经人工降档不该有降档标记')

// 验收标准 2：管理端看到 gate 与判据数字，校对端只拿到放行档的 hint，
// 且 highlight 仅在 severity=strong 且 gate=strong 时为真。
const afterRelease = await api(`/api/fangji/projects/${project.id}/findings`, { token })
const releasedView = afterRelease.items.find((item) => item.message.key === RULE_IDENTITY.message_key)
assert.equal(releasedView.gate, 'strong')
assert.equal(releasedView.gate_sample_n, 120)
assert.equal(releasedView.gate_precision_hat, 0.95)
const opened = await api(`/api/fangji/pages/${target.id}/findings`, { token: readerAuth.token })
assert.equal(opened.hints.length, 1, JSON.stringify(opened))
assert.equal(opened.hints[0].kind, 'missing_field')
assert.equal(opened.hints[0].highlight, true, 'strong 疑点 + strong 档必须高亮')
assert.equal(opened.suppressed_by_gate, 0)
for (const forbidden of ['producer', 'producer_version', 'round', 'gate', 'confidence']) {
  assert.equal(opened.hints[0][forbidden], undefined, `校对端不许看到 ${forbidden}`)
}

// 验收标准 3：未列入变更集的规则保持 off——同一页上补一条别的身份的疑点当反向对照。
const other = await api('/api/collections/review_findings/records', {
  method: 'POST', token: superAuth.token, status: 200,
  body: {
    project: project.id, page: target.id, field_name: '词头', round: 1,
    kind: 'encoding_form_anomaly', severity: 'warn', message_key: 'combining_marks_present',
    params_json: '{}', evidence_json: '{}', producer: 'rule',
    producer_version: 'l0-v1', produced_at: new Date().toISOString(), superseded_at: ''
  }
})
const mixed = await api(`/api/fangji/pages/${target.id}/findings`, { token: readerAuth.token })
assert.equal(mixed.hints.length, 1, '没进变更集的那条规则仍不许下发')
assert.equal(mixed.suppressed_by_gate, 1, '但它要计入「被门控挡住」，不能被当成不存在')
// warn 级疑点在 strong 档下可见但不高亮（高亮只属于 strong×strong）。
const warnRow = await api('/api/collections/assist_rule_gates/records', {
  method: 'POST', token: superAuth.token,
  body: {
    producer: 'rule', producer_version: 'l0-v1', kind: 'encoding_form_anomaly',
    message_key: 'combining_marks_present', gate: 'strong', sample_n: 300, precision_hat: 0.97
  }
})
gateIds.push(warnRow.id)
const highlighted = await api(`/api/fangji/pages/${target.id}/findings`, { token: readerAuth.token })
assert.equal(highlighted.hints.length, 2)
const warnHint = highlighted.hints.find((hint) => hint.kind === 'encoding_form_anomaly')
assert.equal(warnHint.severity, 'warn')
assert.equal(warnHint.highlight, false, 'warn 级即使在 strong 档也不许高亮')
assert.equal(highlighted.suppressed_by_gate, 0)

// 验收标准 5：幂等与回滚。同一变更集重放结果一致，不产生第二行。
const replay = await api('/api/fangji/gates/changeset', {
  method: 'POST', token,
  body: {
    changeset: `cs-released-${suffix}`,
    entries: [entry({ gate: 'strong', sample_n: 120, precision_hat: 0.95, ...approved })]
  }
})
assert.equal(replay.applied, 0, JSON.stringify(replay))
assert.equal(replay.unchanged, 1)
assert.equal((await api('/api/fangji/gates', { token })).items.length, 2, '重放不许增加登记行')

// kill switch：降档必须显式可审计，且重放同一个变更集不许把它抬回去。
const revoked = await api('/api/fangji/gates/revoke', {
  method: 'POST', token, body: { ...RULE_IDENTITY, note: '误报率复核中' }
})
assert.equal(revoked.action, 'revoked')
const afterRevoke = await api('/api/fangji/gates', { token })
const revokedRow = afterRevoke.items.find((item) => item.message_key === RULE_IDENTITY.message_key)
assert.equal(revokedRow.gate, 'off')
assert.ok(revokedRow.revoked_at, '降档时间必须留痕')
assert.equal(revokedRow.revoked_by, platform.record.id)
assert.match(revokedRow.note, /误报率复核中/)
// 降档只挡住它自己那条规则：另一条已放行的 warn 必须照旧下发，
// 否则 kill switch 就变成了全局关闸，那不该是它的语义。
const afterRevokeHints = await api(`/api/fangji/pages/${target.id}/findings`, { token: readerAuth.token })
assert.deepEqual(afterRevokeHints.hints.map((hint) => hint.kind), ['encoding_form_anomaly'],
  JSON.stringify(afterRevokeHints))
assert.equal(afterRevokeHints.suppressed_by_gate, 1, '降档的那条要计入「被门控挡住」')
// 幂等：再撤一次不产生新状态。
const revokeTwice = await api('/api/fangji/gates/revoke', { method: 'POST', token, body: RULE_IDENTITY })
assert.equal(revokeTwice.action, 'unchanged')
const replayAfterRevoke = await api('/api/fangji/gates/changeset', {
  method: 'POST', token,
  body: { changeset: `cs-released-${suffix}`, entries: [entry({ gate: 'strong', sample_n: 120, precision_hat: 0.95, ...approved })] }
})
assert.equal(replayAfterRevoke.locked, 1, JSON.stringify(replayAfterRevoke))
assert.equal(replayAfterRevoke.applied, 0, '人工降过档的规则不许被重放抬升')
assert.equal((await api('/api/fangji/gates', { token })).items.find((i) => i.message_key === RULE_IDENTITY.message_key).gate, 'off')

// 重新放行必须显式撤销降档标记，之后同一份变更集才生效（回滚路径可走通）。
const restored = await api('/api/fangji/gates/revoke', {
  method: 'POST', token, body: { ...RULE_IDENTITY, restore: true, note: '复核结束，精度重新达标' }
})
assert.equal(restored.action, 'restored')
assert.equal(restored.gate, 'off', '撤销降档标记只清标记，不自动改档位')
const releasedAgain = await api('/api/fangji/gates/changeset', {
  method: 'POST', token,
  body: { changeset: `cs-released-2-${suffix}`, entries: [entry({ gate: 'strong', sample_n: 120, precision_hat: 0.95, ...approved })] }
})
assert.equal(releasedAgain.applied, 1, JSON.stringify(releasedAgain))
assert.equal((await api(`/api/fangji/pages/${target.id}/findings`, { token: readerAuth.token })).hints.length, 2)

// 验收标准 7：截断要有可判定信号。表里已有 2 行，limit=1 时必须报 truncated。
const clipped = await api('/api/fangji/gates?limit=1', { token })
assert.equal(clipped.items.length, 1)
assert.equal(clipped.truncated, true, '截断时必须返回可判定信号，不允许静默少给')
assert.equal(clipped.limit, 1)

// 空变更集与非法身份都要被挡下：这个口是唯一写入通道，不能容忍拼进过滤表达式的输入。
await api('/api/fangji/gates/changeset', { method: 'POST', token, body: { changeset: 'cs-empty', entries: [] }, status: 400 })
const hostile = await api('/api/fangji/gates/changeset', {
  method: 'POST', token,
  body: {
    changeset: 'cs-hostile',
    entries: [{ ...RULE_IDENTITY, kind: 'x") || (producer = "ocr', gate: 'strong', sample_n: 200, precision_hat: 0.99, ...approved }]
  }
})
assert.equal(hostile.applied, 0, JSON.stringify(hostile))
assert.equal(hostile.refused, 1)
assert.match(hostile.entries[0].reason, /非法字符/)

// 验收标准 7（真灌数据，不靠等价推理）：超过 MAX_GATE_ROWS = 2000 时，两个 findings 口
// 都必须显式报 gate_rows_truncated。只断言"字段存在且为 false"证明不了那一支代码会触发，
// 而那一支正是"规则静默变 off 的幽灵"的来源。
// 这里灌 2001 行（比上限多一行即可）。数据目录是一次性的，不必清理。
for (let i = 0; i < 2001; i++) {
  await api('/api/collections/assist_rule_gates/records', {
    method: 'POST', token: superAuth.token,
    body: {
      producer: 'rule', producer_version: `flood-${i}`, kind: 'page_outlier',
      message_key: 'page_number_outlier', gate: 'off', sample_n: 10, precision_hat: 0.5
    }
  })
}
const flooded = await api(`/api/fangji/pages/${target.id}/findings`, { token: readerAuth.token })
assert.equal(flooded.gate_rows_truncated, true, '超过 MAX_GATE_ROWS 必须返回可判定信号')
const floodedManager = await api(`/api/fangji/projects/${project.id}/findings`, { token })
assert.equal(floodedManager.gate_rows_truncated, true, '统计口共用同一个上限与同一个信号')

// 门控表读取口也必须带通道（#254 第 3 件事的另一半：`/admin/gate-rules` 以前只有
// 档位与样本数，"等证据"与"永远拿不到"在两栏数字上长得一模一样）。
const gateTable = await api('/api/fangji/gates', { token })
assert.ok(gateTable.items.length >= 1, JSON.stringify(gateTable))
for (const row of gateTable.items) {
  assert.ok(['scored', 'unscored', 'unknown'].includes(row.scoring_channel),
    `门控表读到的通道不可判定：${JSON.stringify([row.kind, row.message_key, row.scoring_channel])}`)
}
const noChannelRow = await api('/api/collections/assist_rule_gates/records', {
  method: 'POST', token: superAuth.token,
  body: {
    producer: 'rule', producer_version: 'identity-v3', kind: 'merged_columns',
    message_key: 'multiple_headwords_in_cell', gate: 'off', sample_n: 0, precision_hat: null,
    evaluated_at: new Date().toISOString().slice(0, 10)
  }
})
gateIds.push(noChannelRow.id)
const gateTableAfter = await api('/api/fangji/gates', { token })
const mergedRow = gateTableAfter.items.find((row) => row.kind === 'merged_columns')
assert.equal(mergedRow?.scoring_channel, 'unscored', JSON.stringify(mergedRow))
assert.ok(gateTableAfter.items.some((row) => row.scoring_channel === 'scored'),
  '表里一条"可打分"都没有：这组断言退化成只看一种')

// ---------- #254：判据"能不能拿到精度"必须一处定义、漏归类要红 ----------
const { createRequire } = await import('node:module')
const nodeRequire = createRequire(import.meta.url)
const rulesLib = nodeRequire('../pb_hooks/lib/assist_rules.js')
const coverage = nodeRequire('../pb_hooks/lib/rule_coverage.js')
const { buildChangeset } = await import('../../scripts/assist/gate_changeset.mjs')

// 规则引擎自己声明的 key 划分（CELL + PROJECT_ONLY）与通道表必须**双向相等**。
// 只判单向包含会放过"表上登记了却根本不产出的判据"，那正是这份表要消灭的另一种沉默。
const keysForVersion = (list) => [...new Set(list.filter((e) => e.producer_version === rulesLib.RULES_VERSION)
  .map((e) => e.message_key))].sort()
const engineMessageKeys = [...new Set([
  ...rulesLib.CELL_MESSAGE_KEYS, ...rulesLib.PROJECT_ONLY_MESSAGE_KEYS
])].sort()
assert.deepEqual(keysForVersion([...coverage.SCORED, ...coverage.UNSCORED]), engineMessageKeys,
  '通道表与规则引擎的 key 划分不一致')

// 反证：断言必须能失败。从表里抽掉一条已登记的无通道判据，上面那条相等就必须红——
// 否则"漏归类就红"这句承诺是恒真的。
const droppedOne = coverage.UNSCORED.filter((e) => e.message_key !== 'mixed_normalization_forms')
assert.notDeepEqual(keysForVersion([...coverage.SCORED, ...droppedOne]), engineMessageKeys,
  '删掉一条归类后断言仍然成立：这条门禁是恒真的')

// merged_columns 这一族是 #254 报的那件事：在产、却两栏都不提。
assert.ok(coverage.UNSCORED.some((e) => e.kind === 'merged_columns' && e.reason),
  'merged_columns 没有被点名为无通道')
assert.equal(coverage.channelOf({ producer_version: rulesLib.RULES_VERSION, kind: 'missing_field', message_key: 'required_role_field_empty' }), 'scored')
assert.equal(coverage.channelOf({ producer_version: 'no-such-version', kind: 'x', message_key: 'y' }), 'unknown')

const allScored = coverage.SCORED.map((e) => ({
  rule: e.rule, kind: e.kind, message_key: e.message_key,
  hits: 200, precision: 0.95, gate: { gate: 'warn', basis: '反证用', note: '' }, wilson: { lower: 0.9, upper: 0.98 }
}))
const meta = { approvedBy: 'suite@example.com', approvedAt: '2026-10-02T00:00:00.000Z', producerVersion: rulesLib.RULES_VERSION, changesetId: 'cs-suite-coverage' }
const full = buildChangeset({ scored: allScored, scope_roles: true }, meta)
assert.equal(full.entries.length, coverage.SCORED.length)
assert.equal(full.no_channel.length, coverage.UNSCORED.length)
assert.ok(full.no_channel.some((e) => e.kind === 'merged_columns'))
// 少一条在作用域内的可打分判据 → 必须红，而不是安静地少一栏。
assert.throws(() => buildChangeset({ scored: allScored.slice(1), scope_roles: true }, meta), /漏了/)
// 没给列角色时 R5 不在作用域内，缺它不该红（否则这条门禁会在真实用法上误报）。
assert.doesNotThrow(() => buildChangeset(
  { scored: allScored.filter((e) => e.message_key !== 'required_role_field_empty'), scope_roles: false }, meta))
assert.throws(() => buildChangeset({ scored: allScored }, meta), /scope_roles/)

// 管理端读取口必须真的把通道带出来（这条同时验 goja 侧的 `${__hooks}` 相对加载）。
const channelView = await api(`/api/fangji/projects/${project.id}/findings?per=200`, { token })
assert.ok(channelView.items.length >= 1, '统计口没有可读的疑点')
for (const item of channelView.items) {
  assert.ok(['scored', 'unscored', 'unknown'].includes(item.scoring_channel),
    `管理端读到的通道值不可判定：${JSON.stringify([item.kind, item.message.key, item.scoring_channel])}`)
}
const hintPayload = await api(`/api/fangji/pages/${target.id}/findings`, { token: readerAuth.token })
for (const hint of hintPayload.hints) {
  // 校对端不下发通道：档位与"能不能打分"都是放行侧的事，下发过去只会被当置信度读。
  assert.equal('scoring_channel' in hint, false, '校对端读到了通道字段')
}

for (const id of gateIds.filter(Boolean)) {
  await api(`/api/collections/assist_rule_gates/records/${id}`, { method: 'DELETE', token: superAuth.token, status: 204 })
}
await api(`/api/collections/projects/records/${project.id}`, { method: 'DELETE', token: superAuth.token, status: 204 })

console.log('PASS: gate 变更集只能由平台管理员经判据放行，幂等、可降档且重放不抬升，未下发与零疑点在字段级可区分')
