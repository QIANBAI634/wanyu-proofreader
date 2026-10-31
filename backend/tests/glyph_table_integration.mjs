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

// 检测：含 @N 的那条 missing_glyph=true，正常那条 false。
const pages = await api(`/api/collections/pages/records?filter=${encodeURIComponent(`project="${project.id}"`)}`, { token })
assert.equal(pages.items.length, 2)
const glyphPage = pages.items.find((p) => (p.ocr_text || '').includes('@98969'))
const normalPage = pages.items.find((p) => !(p.ocr_text || '').includes('@98969'))
assert.equal(glyphPage.missing_glyph, true)
assert.equal(normalPage.missing_glyph, false)

const readerAuth = await api('/api/collections/users/auth-with-password', {
  method: 'POST', body: { identity: 'glyph-reader@example.com', password: 'GlyphReader12345!' }
})

// 队列摘要：missingGlyph 计数 = 1。
const queues = await api('/api/fangji/proofreading-queues', { token: readerAuth.token })
const queue = queues.items.find((q) => q.project.id === project.id)
assert.equal(queue.missingGlyph, 1)

// 派发：proofreader 用 glyph=true 只领到缺字那条。
const claimed = await api(`/api/fangji/projects/${project.id}/claim`, {
  method: 'POST', token: readerAuth.token, body: { glyph: true }
})
assert.equal(claimed.id, glyphPage.id)

// 人工结论保留：平台管理员手动登记一个 blocked_reason，自动缺字状态清除时不得覆盖它。
await api(`/api/fangji/pages/${glyphPage.id}/blocked-reason`, {
  method: 'PUT', token, body: { reason: 'scanned_read', basis: '扫描页需要人工识读' }
})

// 修正后退队：proofreader 提交不含 @N 的修正，missing_glyph 应被清除、人工 blocked_reason 保留。
await api(`/api/fangji/pages/${glyphPage.id}/submit`, {
  method: 'POST', token: readerAuth.token,
  body: { rowJson: JSON.stringify({ 词头: '甲', 释义: '有缺字(已补)' }), text: '甲 有缺字(已补)', leaseToken: claimed.leaseToken }
})
const afterFix = await api(`/api/collections/pages/records/${glyphPage.id}`, { token })
assert.equal(afterFix.missing_glyph, false)
assert.equal(afterFix.blocked_reason, 'scanned_read')

// 缺字队列计数归 0。
const queuesAfter = await api('/api/fangji/proofreading-queues', { token: readerAuth.token })
const queueAfter = queuesAfter.items.find((q) => q.project.id === project.id)
assert.equal(queueAfter.missingGlyph, 0)

console.log('PASS: glyph rows are detected as missing_glyph, claimable as a dedicated queue, and cleared on fix without touching the manual blocked reason')
