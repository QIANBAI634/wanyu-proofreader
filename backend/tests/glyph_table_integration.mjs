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

async function makeReader(email) {
  const user = await api('/api/collections/users/records', {
    method: 'POST', token, body: { email, name: email, role: 'user', password: 'GlyphReader123!', passwordConfirm: 'GlyphReader123!' }
  })
  await api(`/api/fangji/projects/${project.id}/members/${user.id}`, { method: 'PUT', token, body: { role: 'proofreader' } })
  return api('/api/collections/users/auth-with-password', { method: 'POST', body: { identity: email, password: 'GlyphReader123!' } })
}
const readerA = await makeReader('glyph-a@example.com')
const readerB = await makeReader('glyph-b@example.com')

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

const pages = await api(`/api/collections/pages/records?filter=${encodeURIComponent(`project="${project.id}"`)}`, { token })
assert.equal(pages.items.length, 2)
const glyphPage = pages.items.find((p) => (p.ocr_text || '').includes('@98969'))
const normalPage = pages.items.find((p) => !(p.ocr_text || '').includes('@98969'))
assert.equal(glyphPage.missing_glyph, true)
assert.equal(normalPage.missing_glyph, false)

const queues = await api('/api/fangji/proofreading-queues', { token: readerA.token })
assert.equal(queues.items.find((q) => q.project.id === project.id).missingGlyph, 1)

// 人工结论保留：管理员登记 blocked_reason，缺字状态清除时不得覆盖它。
await api(`/api/fangji/pages/${glyphPage.id}/blocked-reason`, {
  method: 'PUT', token, body: { reason: 'scanned_read', basis: '扫描页需要人工识读' }
})

// 第一份盲校提交：missing_glyph 不得清（第二校对员还要从缺字专队继续领）。
const claimA = await api(`/api/fangji/projects/${project.id}/claim`, { method: 'POST', token: readerA.token, body: { glyph: true } })
assert.equal(claimA.id, glyphPage.id)
await api(`/api/fangji/pages/${glyphPage.id}/submit`, {
  method: 'POST', token: readerA.token,
  body: { rowJson: JSON.stringify({ 词头: '甲', 释义: '有缺字(已补)' }), text: '甲 有缺字(已补)', leaseToken: claimA.leaseToken }
})
const afterFirst = await api(`/api/collections/pages/records/${glyphPage.id}`, { token })
assert.equal(afterFirst.missing_glyph, true)
assert.equal(afterFirst.blocked_reason, 'scanned_read')

// 第二校对员仍能从缺字专队领到，提交一致 → 正式采纳 → missing_glyph 才清、人工结论保留。
const claimB = await api(`/api/fangji/projects/${project.id}/claim`, { method: 'POST', token: readerB.token, body: { glyph: true } })
assert.equal(claimB.id, glyphPage.id)
await api(`/api/fangji/pages/${glyphPage.id}/submit`, {
  method: 'POST', token: readerB.token,
  body: { rowJson: JSON.stringify({ 词头: '甲', 释义: '有缺字(已补)' }), text: '甲 有缺字(已补)', leaseToken: claimB.leaseToken }
})
const afterApproved = await api(`/api/collections/pages/records/${glyphPage.id}`, { token })
assert.equal(afterApproved.status, 'approved')
assert.equal(afterApproved.missing_glyph, false)
assert.equal(afterApproved.blocked_reason, 'scanned_read')

const queuesAfter = await api('/api/fangji/proofreading-queues', { token: readerA.token })
assert.equal(queuesAfter.items.find((q) => q.project.id === project.id).missingGlyph, 0)

console.log('PASS: glyph rows are detected, claimable as a dedicated queue, survive the first blind proofread, and clear only on formal adoption without touching the manual blocked reason')
