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

const project = await api('/api/fangji/projects', { method: 'POST', token, body: { name: '缺字待登记夹具' }, status: 201 })

// 建一个 proofreader，加进项目。
const reader = await api('/api/collections/users/records', {
  method: 'POST', token, body: {
    email: 'glyph-reader@example.com', name: '缺字校对员', role: 'user',
    password: 'GlyphReader12345!', passwordConfirm: 'GlyphReader12345!'
  }
})
await api(`/api/fangji/projects/${project.id}/members/${reader.id}`, {
  method: 'PUT', token, body: { role: 'proofreader' }
})

// 导入：第一行含缺字占位符 @98969，第二行正常。
const form = new FormData()
form.set('file', new Blob(['词头,释义,PDF页码\n甲,有缺字@98969,1\n乙,无缺字,2\n'], { type: 'text/csv' }), 'glyph.csv')
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

// 检测：含 @N 的那条自动标 glyph_table，正常的那条不标。
const pages = await api(`/api/collections/pages/records?filter=${encodeURIComponent(`project="${project.id}"`)}`, { token })
assert.equal(pages.items.length, 2)
const glyphPage = pages.items.find((p) => (p.ocr_text || '').includes('@98969'))
const normalPage = pages.items.find((p) => !(p.ocr_text || '').includes('@98969'))
assert.equal(glyphPage.blocked_reason, 'glyph_table')
assert.equal(normalPage.blocked_reason || '', '')

// 队列摘要：blocked.glyph_table 计数 = 1（只有一条缺字）。
const readerAuth = await api('/api/collections/users/auth-with-password', {
  method: 'POST', body: { identity: 'glyph-reader@example.com', password: 'GlyphReader12345!' }
})
const queues = await api('/api/fangji/proofreading-queues', { token: readerAuth.token })
const queue = queues.items.find((q) => q.project.id === project.id)
assert.equal(queue.blocked.glyph_table, 1)

// 派发：proofreader 用 blocked='glyph_table' 只领到缺字那条。
const claimed = await api(`/api/fangji/projects/${project.id}/claim`, {
  method: 'POST', token: readerAuth.token, body: { blocked: 'glyph_table' }
})
assert.equal(claimed.id, glyphPage.id)

console.log('PASS: glyph placeholder rows are stamped glyph_table, counted, and claimable as a dedicated queue')
