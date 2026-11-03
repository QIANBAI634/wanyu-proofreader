import assert from 'node:assert/strict'

const base = process.env.PB_URL

async function api(path, { method = 'GET', token = '', body, status = 200 } = {}) {
  const form = body instanceof FormData
  const response = await fetch(base + path, {
    method,
    headers: { Authorization: token, ...(!form && body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? (form ? body : JSON.stringify(body)) : undefined
  })
  const data = await response.json()
  assert.equal(response.status, status, JSON.stringify(data))
  return data
}

const admin = await api('/api/collections/users/auth-with-password', {
  method: 'POST',
  body: { identity: process.env.APP_ADMIN_EMAIL, password: process.env.APP_ADMIN_PASSWORD }
})
const token = admin.token
const superAuth = await api('/api/collections/_superusers/auth-with-password', {
  method: 'POST', body: { identity: process.env.PB_SUPER_EMAIL, password: process.env.PB_SUPER_PASSWORD }
})

const project = await api('/api/fangji/projects', { method: 'POST', token, body: { name: '回流夹具' }, status: 201 })

const reader = await api('/api/collections/users/records', {
  method: 'POST', token, body: {
    email: 'return-reader@example.com', name: '退回校对员', role: 'user',
    password: 'ReturnReader123!', passwordConfirm: 'ReturnReader123!'
  }
})
await api(`/api/fangji/projects/${project.id}/members/${reader.id}`, {
  method: 'PUT', token, body: { role: 'proofreader' }
})

const outsider = await api('/api/collections/users/records', {
  method: 'POST', token, body: {
    email: 'return-outsider@example.com', name: '外人', role: 'user',
    password: 'ReturnOutsider123!', passwordConfirm: 'ReturnOutsider123!'
  }
})

// 导入一条。
const form = new FormData()
form.set('file', new Blob(['词头,释义,PDF页码\n甲,有缺字@98969,1\n'], { type: 'text/csv' }), 'return.csv')
form.set('inspect_only', 'true')
const job = await api(`/api/fangji/projects/${project.id}/imports/csv`, { method: 'POST', token, body: form, status: 202 })
for (let i = 0; i < 100; i++) {
  const current = await api(`/api/collections/import_jobs/records/${job.id}`, { token })
  if (current.status === 'validated') break
  assert.notEqual(current.status, 'failed', JSON.stringify(current))
  await new Promise((resolve) => setTimeout(resolve, 100))
}
await api(`/api/fangji/imports/${job.id}/commit`, { method: 'POST', token, status: 202 })
for (let i = 0; i < 100; i++) {
  const current = await api(`/api/collections/import_jobs/records/${job.id}`, { token })
  if (current.status === 'completed') break
  assert.notEqual(current.status, 'failed', JSON.stringify(current))
  await new Promise((resolve) => setTimeout(resolve, 100))
}

const pages = await api(`/api/collections/pages/records?filter=${encodeURIComponent(`project="${project.id}"`)}`, { token })
const page = pages.items[0]

const readerAuth = await api('/api/collections/users/auth-with-password', {
  method: 'POST', body: { identity: 'return-reader@example.com', password: 'ReturnReader123!' }
})

// 非成员退回 403。
await api(`/api/fangji/pages/${page.id}/return-to-source`, {
  method: 'POST', token: (await api('/api/collections/users/auth-with-password', { method: 'POST', body: { identity: 'return-outsider@example.com', password: 'ReturnOutsider123!' } })).token,
  body: { reason: 'text_mismatch', basis: '对不上' }, status: 403
})

// 校对员领任务后能退回。
const claimed = await api(`/api/fangji/projects/${project.id}/claim`, { method: 'POST', token: readerAuth.token })
assert.equal(claimed.id, page.id)
await api(`/api/fangji/pages/${page.id}/return-to-source`, {
  method: 'POST', token: readerAuth.token, body: { reason: 'text_mismatch', basis: '释义和原书第 1 页对不上' }
})

// 退回后 status='rework'，留痕可查，台账待返工计数 = 1。
const afterReturn = await api(`/api/collections/pages/records/${page.id}`, { token })
assert.equal(afterReturn.status, 'rework')
assert.equal(afterReturn.proofreader, '')
const events = await api(`/api/collections/verification_events/records?filter=${encodeURIComponent(`page="${page.id}" && kind="returned_to_source"`)}`, { token: superAuth.token })
assert.equal(events.items.length, 1)
assert.equal(events.items[0].payload_json.includes('text_mismatch'), true)
const ledger = await api(`/api/fangji/projects/${project.id}/import-ledger`, { token })
assert.equal(ledger.summary.rework_count, 1)

// 退回的条目不再可领取（校对员再领领不到）。
await api(`/api/fangji/projects/${project.id}/claim`, { method: 'POST', token: readerAuth.token, body: { glyph: true }, status: 404 })

// manager 处理退回：processed 后回 pending，留痕 return_acknowledged。
await api(`/api/fangji/pages/${page.id}/resolve-return`, {
  method: 'POST', token, body: { disposition: 'processed', note: '已重新核对' }
})
const afterResolve = await api(`/api/collections/pages/records/${page.id}`, { token })
assert.equal(afterResolve.status, 'pending')
const ack = await api(`/api/collections/verification_events/records?filter=${encodeURIComponent(`page="${page.id}" && kind="return_acknowledged"`)}`, { token: superAuth.token })
assert.equal(ack.items.length, 1)
const ledgerAfter = await api(`/api/fangji/projects/${project.id}/import-ledger`, { token })
assert.equal(ledgerAfter.summary.rework_count, 0)

// 回归：返工轮次不得污染双人盲校 quorum。
// 校对员甲在 round=2 提交一份 → 退回（round 递增到 3）→ resolve 回 pending →
// 校对员乙在 round=3 提交一份。此时 round=3 只有乙这一份，不应触发 approved。
const reader2 = await api('/api/collections/users/records', {
  method: 'POST', token, body: {
    email: 'return-reader2@example.com', name: '退回校对员乙', role: 'user',
    password: 'ReturnReader2!', passwordConfirm: 'ReturnReader2!'
  }
})
await api(`/api/fangji/projects/${project.id}/members/${reader2.id}`, { method: 'PUT', token, body: { role: 'proofreader' } })
const reader2Auth = await api('/api/collections/users/auth-with-password', {
  method: 'POST', body: { identity: 'return-reader2@example.com', password: 'ReturnReader2!' }
})

// 甲提交一份（round=2）。
const claimA = await api(`/api/fangji/projects/${project.id}/claim`, { method: 'POST', token: readerAuth.token })
await api(`/api/fangji/pages/${page.id}/submit`, {
  method: 'POST', token: readerAuth.token,
  body: { rowJson: JSON.stringify({ 词头: '甲', 释义: '已补' }), text: '甲 已补', leaseToken: claimA.leaseToken }
})
assert.equal((await api(`/api/collections/pages/records/${page.id}`, { token })).status, 'proofread')

// 只有甲这一份、还没有第二份可比较：一致率分母必须为 0。
const statsBeforeReturn = await api('/api/fangji/proofreader-stats', { token: readerAuth.token })
assert.equal(statsBeforeReturn.workflowEvaluatedCount, 0)
assert.equal(statsBeforeReturn.matchRate, null)

// 退回（round → 3）再 resolve 回 pending。
await api(`/api/fangji/pages/${page.id}/return-to-source`, { method: 'POST', token, body: { reason: 'text_mismatch', basis: '再核对' } })

// 返工让旧轮 waiting 失效，但这不是一次「不一致」：stats 分母仍为 0，不能惩罚发现问题的校对员。
const statsAfterReturn = await api('/api/fangji/proofreader-stats', { token: readerAuth.token })
assert.equal(statsAfterReturn.workflowEvaluatedCount, 0)
assert.equal(statsAfterReturn.matchRate, null)
assert.equal(statsAfterReturn.matchRank, null)
const oldAttempts = await api(`/api/collections/proofreading_attempts/records?filter=${encodeURIComponent(`page="${page.id}" && round=2`)}`, { token: superAuth.token })
assert.equal(oldAttempts.items.length, 1)
assert.equal(oldAttempts.items[0].outcome, 'superseded')

// 处理方式只接受 processed / ignored，其它值不静默降级。
await api(`/api/fangji/pages/${page.id}/resolve-return`, { method: 'POST', token, body: { disposition: 'delete' }, status: 400 })
await api(`/api/fangji/pages/${page.id}/resolve-return`, { method: 'POST', token, body: { disposition: 'processed' } })

// 乙提交一份（round=3）：旧 round=2 的甲那份不得参与，不能 approved。
const claimB = await api(`/api/fangji/projects/${project.id}/claim`, { method: 'POST', token: reader2Auth.token })
await api(`/api/fangji/pages/${page.id}/submit`, {
  method: 'POST', token: reader2Auth.token,
  body: { rowJson: JSON.stringify({ 词头: '甲', 释义: '已补' }), text: '甲 已补', leaseToken: claimB.leaseToken }
})
const afterSecond = await api(`/api/collections/pages/records/${page.id}`, { token })
assert.equal(afterSecond.status, 'proofread')
assert.equal(afterSecond.proofread_round, 3)

console.log('PASS: downstream return-to-source sets rework, leaves trace, is counted in ledger, excludes from claim, resolve returns to pending with an acknowledgement, and the return round does not pollute the next blind proofread quorum')
