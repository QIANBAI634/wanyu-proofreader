import assert from 'node:assert/strict'

// AI 辅助校对的**端到端验收**套件：一条链路从导入跑到校对员看见高亮，再跑回看不见。
//
// 与既有套件的分工：生产者各自的判据由 `assist_rules` / `identity` / `cross_source` 钉，
// 门控写入通道由 `gate_release` 钉，界面状态由 `assist_browser` 钉。这一支钉的是
// **它们串起来之后**才成立的那件事——目标里"可在校对流程中实际意义上起作用，
// 需在服务上实地验证"那句，此前只能靠一次性脚本或人眼看截图来证明。
//
// 五段断言按链路顺序排：
//   A 在产判据全部有归类（#254 的性质，从"表写对了"升级成"真产出的东西被表覆盖"）
//   B 规则没放行时，校对员读到空 hints，但知道有东西被挡住
//   C 人工放行后 hints 真下发，且命中区间切回原文切出来的就是那个词头
//   D kill switch 之后又回到 B 的状态（放行不是单向棘轮）
//   E 大厅的分层计数与可领取数对得上账，且 tier 不出现在校对端任何响应里
const base = process.env.PB_URL || 'http://127.0.0.1:18091'
const { createRequire } = await import('node:module')
const coverage = createRequire(import.meta.url)('../pb_hooks/lib/rule_coverage.js')

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
  assert.equal(response.status, status, `${method} ${path} -> ${response.status} ${String(raw).slice(0, 300)}`)
  return data
}

const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`
const password = 'AssistChain123!'
const platform = await api('/api/collections/users/auth-with-password', {
  method: 'POST', body: { identity: process.env.APP_ADMIN_EMAIL, password: process.env.APP_ADMIN_PASSWORD }
})
const superAuth = await api('/api/collections/_superusers/auth-with-password', {
  method: 'POST', body: { identity: process.env.PB_SUPER_EMAIL, password: process.env.PB_SUPER_PASSWORD }
})

const reader = await api('/api/collections/users/records', {
  method: 'POST', token: superAuth.token,
  body: { email: `chain-reader-${suffix}@example.com`, name: `chain-reader-${suffix}`, role: 'user', password, passwordConfirm: password }
})
const readerAuth = await api('/api/collections/users/auth-with-password', {
  method: 'POST', body: { identity: `chain-reader-${suffix}@example.com`, password }
})

const project = await api('/api/fangji/projects', {
  method: 'POST', token: platform.token, status: 201, body: { name: `端到端验收 ${suffix}` }
})
await api(`/api/fangji/projects/${project.id}/members/${reader.id}`, {
  method: 'PUT', token: platform.token, body: { role: 'proofreader' }
})

// 三份形状各有用途：`甲 乙` 产 identity-v3 的 strong `multiple_headwords_in_cell`
// （带 char_offsets，且它是"无打分通道"那一族的代表）；`lang2` 产 l0-v1 的
// `confusable_ascii_in_reading`（"有通道、等证据"那一族）；第三条是"另一条同身份形状"的对照，
// 让跨行判据有可比的两行而不是一行自撞。
// 第一格「𠀋 á 乙」同时踩两种偏移陷阱：𠀋 是补充平面字符（U+2A00B），一个码位占两个
// UTF-16 单元——生产者发的是**码位**下标，前端 `locateSpan` 必须换算成 UTF-16 才能切
// textarea/DOM，用普通汉字这一区分不出来；á 是 `a` + U+0301 两个码位一个字形，
// 逐字符切分会把声调符甩在高亮外面。
const csv = '词条,拼音,莆田IPA,仙游IPA,释义,PDF页码\n'
  + '𠀋 a\u0301 乙,ka1,ka32,ka32,两种东西,1\n'
  + '人,lang2,kʰan2,taŋ2,人类,2\n'
  + '丙,pe1,pe32,pe32,单一个,3\n'
const upload = new FormData()
upload.set('file', new Blob([csv], { type: 'text/csv' }), 'chain.csv')
upload.set('inspect_only', 'true')
const job = await api(`/api/fangji/projects/${project.id}/imports/csv`, {
  method: 'POST', token: platform.token, status: 202, body: upload
})
for (let i = 0; i < 400; i += 1) {
  const cur = await api(`/api/collections/import_jobs/records/${job.id}`, { token: superAuth.token })
  if (cur.status === 'validated') break
  assert.notEqual(cur.status, 'failed', JSON.stringify(cur))
  await new Promise((resolve) => setTimeout(resolve, 100))
}
await api(`/api/fangji/imports/${job.id}/commit`, { method: 'POST', token: platform.token, status: 202 })
for (let i = 0; i < 800; i += 1) {
  const cur = await api(`/api/collections/import_jobs/records/${job.id}`, { token: superAuth.token })
  if (cur.status === 'completed') break
  assert.notEqual(cur.status, 'failed', JSON.stringify(cur))
  await new Promise((resolve) => setTimeout(resolve, 100))
}
await api(`/api/fangji/projects/${project.id}/column-roles`, {
  method: 'PUT', token: platform.token,
  body: { roles: { 词条: 'headword', 拼音: 'reading', 莆田IPA: 'reading', 仙游IPA: 'reading', 释义: 'meaning' } }
})
await api(`/api/fangji/projects/${project.id}/identity/recompute`, { method: 'POST', token: platform.token })
await api(`/api/fangji/projects/${project.id}/findings/recompute`, { method: 'POST', token: platform.token })

// ---------- A：真产出的每一条判据都必须被通道表覆盖 ----------
const managerView = await api(`/api/fangji/projects/${project.id}/findings?per=200`, { token: platform.token })
assert.ok(managerView.items.length >= 2, `重算后没有疑点：${JSON.stringify(managerView)}`)
const identities = [...new Map(managerView.items.map((item) => [
  `${item.producer_version}|${item.kind}|${item.message.key}`,
  { producer: item.producer, producer_version: item.producer_version, kind: item.kind, message_key: item.message.key }
])).values()]
const unclassified = identities.filter((entry) => coverage.channelOf(entry) === 'unknown')
assert.deepEqual(unclassified, [], `在产判据没被归进通道表：${JSON.stringify(unclassified)}`)
const channels = new Set(identities.map((entry) => coverage.channelOf(entry)))
// 两类各至少一条：只剩一类时这条套件会退化成"只测了一半"，而它的全部意义在两类的分界。
assert.ok(channels.has('scored') && channels.has('unscored'),
  `夹具没同时产出有通道与无通道两类：${JSON.stringify([...channels])}`)

// ---------- B：规则没放行，校对员读到空，但知道有东西被挡住 ----------
const strongMerged = managerView.items.find((item) => item.kind === 'merged_columns' && item.severity === 'strong')
assert.ok(strongMerged, JSON.stringify(managerView.items.map((i) => [i.kind, i.severity])))
const claimed = await api(`/api/fangji/projects/${project.id}/claim`, {
  method: 'POST', token: readerAuth.token, body: { tier: 'B' }
})
assert.equal(claimed.id, strongMerged.page, `领到的不是带 strong 疑点的那条：${JSON.stringify(claimed)}`)
const blocked = await api(`/api/fangji/pages/${claimed.id}/findings`, { token: readerAuth.token })
assert.deepEqual(blocked.hints, [], `规则没放行却下发了 hints：${JSON.stringify(blocked.hints)}`)
assert.ok(blocked.suppressed_by_gate >= 1, `必须说得出"有东西被挡住"：${JSON.stringify(blocked)}`)
// 红线：档位与通道都不许出现在校对端响应里。
for (const forbidden of ['difficulty_tier', 'gate', 'scoring_channel', 'sample_n', 'precision_hat']) {
  assert.equal(JSON.stringify(blocked).includes(`"${forbidden}"`), false, `校对端响应里出现了 ${forbidden}`)
}

// ---------- C：人工放行真的流到校对员，且命中区间切得回原文 ----------
const entry = {
  producer: strongMerged.producer, producer_version: strongMerged.producer_version,
  kind: strongMerged.kind, message_key: strongMerged.message.key,
  gate: 'strong', sample_n: 120, precision_hat: 0.95,
  approved_by: `chain-suite-${suffix}`, approved_at: new Date().toISOString()
}
const applied = await api('/api/fangji/gates/changeset', {
  method: 'POST', token: platform.token,
  body: { changeset: `cs-chain-${suffix}`, entries: [entry] }
})
assert.equal(applied.refused, 0, JSON.stringify(applied.entries))
assert.equal(applied.applied, 1, JSON.stringify(applied))
const released = await api(`/api/fangji/pages/${claimed.id}/findings`, { token: readerAuth.token })
assert.ok(released.hints.length >= 1, '放行后校对员仍然读不到东西')
const highlight = released.hints.find((hint) => hint.highlight === true)
assert.ok(highlight, `放行到 strong 档却没有高亮级疑点：${JSON.stringify(released.hints)}`)
// 领取响应里没有原文（`summarize()` 只给身份与租约），要读页本身。
const pageRow = await api(`/api/collections/pages/records/${claimed.id}`, { token: superAuth.token })
const source = JSON.parse(pageRow.ocr_row_json)[highlight.field]
assert.equal(typeof source, 'string', `疑点挂在没有原文的字段上：${highlight.field}`)
const spans = highlight.evidence?.char_offsets
assert.ok(Array.isArray(spans) && spans.length >= 2, `strong 疑点必须带命中区间：${JSON.stringify(highlight.evidence)}`)
// 每一段都不许**从组合符开始**：`a` + U+0301 是一个字形单元，生产者若按字符逐个切，
// 声调符会被甩在高亮外面——界面看上去就是"标错了位置"。
for (const [index, [spanStart, spanEnd]] of spans.entries()) {
  const chars = Array.from(source)
  const first = chars[spanStart]
  const code = first?.codePointAt(0) ?? -1
  assert.ok(!(code >= 0x300 && code <= 0x36F),
    `第 ${index + 1} 段从组合符开始，声调符被甩在高亮外：${JSON.stringify({ spans, source })}`)
  assert.ok(spanEnd > spanStart && spanEnd <= chars.length, `第 ${index + 1} 段越界：${JSON.stringify(spans)}`)
}
const [start, end] = spans[0]
const fragment = Array.from(source).slice(start, end).join('')
assert.ok(fragment.length > 0, `区间切出来是空的：${JSON.stringify(spans)} / ${JSON.stringify(source)}`)
// 判据说的是"一格挤进多个词头"，所以切出来的必须是那一格里被分隔符分开的一段——
// 不是整格、也不是空格。这是"高亮标在空白上"那次评审阻断项的反面。
assert.ok(source.split(/[\s、,，;；]+/).includes(fragment),
  `命中文本不是该格里的一个词头段：${JSON.stringify({ source, fragment, spans })}`)
assert.equal(/^\s+$/.test(fragment), false, '命中区间切成了空白')
// 契约的另一半：这些下标是**码位**而不是 UTF-16。第一格的首段是补充平面字符，
// 按 UTF-16 直接切会得到一个孤立代理对——那正是前端如果不换算就会画出的"高亮"。
if (Array.from(fragment).some((ch) => ch.codePointAt(0) > 0xFFFF)) {
  const naive = String(source).slice(start, end)
  assert.notEqual(naive, fragment, `码位下标与 UTF-16 下标没区分开（都是 ${JSON.stringify(fragment)}）`)
  assert.equal(/^[\uD800-\uDBFF]$/.test(naive), true,
    `按 UTF-16 切出来的不是半个代理对，说明这一格没真正测到差异：${JSON.stringify({ naive, fragment })}`)
} else {
  assert.ok(Array.from(source).some((ch) => ch.codePointAt(0) > 0xFFFF),
    '夹具里的补充平面字符不见了：这段断言退化成普通汉字的重复检查')
}

// ---------- F：第二遍校对看到的疑点不受第一遍提交结果影响 ----------
//
// 盲校纪律在辅助层的那一格：`assist_writer.js` 的 `rowFor()` 是
// "有 canonical 就用 canonical，否则用 OCR 原文"。今天 canonical 只在
// **两轮一致（approved）或仲裁之后**才非空（`proofreading_workflow.js:134/157/167`），
// 所以第二位校对员读到的疑点必然还是按 OCR 原文算的。这个性质此前只写在代码注释里，
// 没有测试——而它的失效形态恰好是"上一位改过的地方不再报疑点"，一种间接泄露。
const second = await api('/api/collections/users/records', {
  method: 'POST', token: superAuth.token,
  body: { email: `chain-second-${suffix}@example.com`, name: `chain-second-${suffix}`, role: 'user', password, passwordConfirm: password }
})
await api(`/api/fangji/projects/${project.id}/members/${second.id}`, {
  method: 'PUT', token: platform.token, body: { role: 'proofreader' }
})
const secondAuth = await api('/api/collections/users/auth-with-password', {
  method: 'POST', body: { identity: `chain-second-${suffix}@example.com`, password }
})
// 第一位校对员把挤在一起的两个词头"修好"成一个，再提交。
await api(`/api/fangji/pages/${claimed.id}/submit`, {
  method: 'POST', token: readerAuth.token,
  body: {
    rowJson: JSON.stringify({ 词条: '甲', 拼音: 'ka1', 莆田IPA: 'ka32', 仙游IPA: 'ka32', 释义: '两种东西' }),
    text: '甲', leaseToken: claimed.leaseToken
  }
})
const afterSubmit = await api(`/api/collections/pages/records/${claimed.id}`, { token: superAuth.token })
assert.equal(afterSubmit.proofread_row_json, '', '还没到法定人数就把提交结果写成了 canonical')
await api(`/api/fangji/projects/${project.id}/findings/recompute`, { method: 'POST', token: platform.token })
const stillThere = await api(`/api/fangji/projects/${project.id}/findings?per=200`, { token: platform.token })
assert.ok(stillThere.items.some((item) => item.page === claimed.id && item.kind === 'merged_columns'),
  '第一遍提交把格修好后，疑点跟着消失了：疑点集合被他人结果带跑了')
const secondClaim = await api(`/api/fangji/projects/${project.id}/claim`, { method: 'POST', token: secondAuth.token })
assert.equal(secondClaim.id, claimed.id, `第二位校对员应接到同一条：${JSON.stringify(secondClaim)}`)
const secondHints = await api(`/api/fangji/pages/${claimed.id}/findings`, { token: secondAuth.token })
// 门控此刻是开着的（D 段才关），所以第二遍校对员必须看到同一条按 OCR 原文算出的疑点：
// 第一遍那位把格子修好，不该让这条疑点在他眼里消失。
assert.ok(secondHints.hints.some((hint) => hint.kind === 'merged_columns' && hint.highlight === true),
  `第二遍校对员看不到按 OCR 原文算出的疑点：${JSON.stringify(secondHints.hints)}`)
await api(`/api/fangji/pages/${claimed.id}/release`, {
  method: 'POST', token: secondAuth.token, body: { lease_token: secondClaim.leaseToken }, status: 204
})
await api(`/api/collections/users/records/${second.id}`, { method: 'DELETE', token: superAuth.token, status: 204 })


// ---------- D：kill switch 之后回到看不见（放行不是单向棘轮） ----------
const revoked = await api('/api/fangji/gates/revoke', {
  method: 'POST', token: platform.token,
  body: { ...entry, note: '端到端验收：验证降档真的降得回去' }
})
assert.equal(revoked.gate, 'off', JSON.stringify(revoked))
// 此时第一位校对员已提交过这条，路由按"有自己的 attempt"放行——读的还是他本人的视角。
const afterRevoke = await api(`/api/fangji/pages/${claimed.id}/findings`, { token: readerAuth.token })
assert.deepEqual(afterRevoke.hints, [], `降档后仍在下发：${JSON.stringify(afterRevoke.hints)}`)
assert.ok(afterRevoke.suppressed_by_gate >= 1, JSON.stringify(afterRevoke))

// ---------- E：大厅计数对得上账，且 tier 不外泄 ----------
// 注意：这里**不**释放租约——F 段要用它提交，提前释放会让 submit 报"该条目当前不属于你"。
const hall = await api('/api/fangji/proofreading-queues?page=1&perPage=50', { token: readerAuth.token })
const row = hall.items.find((item) => JSON.stringify(item).includes(project.id))
assert.ok(row, `大厅里没有本项目：${JSON.stringify(hall.items.map((i) => i.project?.id))}`)
const tiers = row.tiers
const tierSum = tiers.A + tiers.B + tiers.C + tiers.other + tiers.unlabeled
assert.equal(tierSum, row.claimable, `分层之和 ${tierSum} 对不上可领取 ${row.claimable}：${JSON.stringify(tiers)}`)
assert.ok(tiers.A + tiers.B + tiers.C >= 1, `一条档位都没算出来：${JSON.stringify(tiers)}`)
const hallText = JSON.stringify(hall)
for (const forbidden of ['difficulty_tier', 'difficulty_basis_json', 'blocked_reason']) {
  assert.equal(hallText.includes(`"${forbidden}"`), false, `大厅响应里出现了 ${forbidden}`)
}


const gateRows = await api('/api/collections/assist_rule_gates/records?filter=' +
  encodeURIComponent(`approved_by = "${entry.approved_by}"`), { token: superAuth.token })
for (const row2 of gateRows.items ?? []) {
  await api(`/api/collections/assist_rule_gates/records/${row2.id}`, { method: 'DELETE', token: superAuth.token, status: 204 })
}
await api(`/api/collections/projects/records/${project.id}`, { method: 'DELETE', token: superAuth.token, status: 204 })
await api(`/api/collections/users/records/${reader.id}`, { method: 'DELETE', token: superAuth.token, status: 204 })

console.log('PASS: 导入→重算→门控挡住→人工放行→命中区间切回原文→降档回到看不见→大厅计数对账且 tier 不外泄')
