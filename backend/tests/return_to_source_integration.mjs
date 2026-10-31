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

console.log('PASS: downstream return-to-source sets rework, leaves trace, is counted in ledger, excludes from claim, and resolve returns to pending with an acknowledgement')
