import assert from 'node:assert/strict'

const base = process.env.PB_URL

async function api(path, { method = 'GET', token = '', body, status = 200 } = {}) {
  const form = body instanceof FormData
  const r = await fetch(base + path, {
    method,
    headers: { Authorization: token, ...(!form && body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? (form ? body : JSON.stringify(body)) : undefined
  })
  const text = await r.text()
  const data = text ? JSON.parse(text) : null
  assert.equal(r.status, status, `${method} ${path} -> ${r.status}: ${text}`)
  return data
}

const admin = await api('/api/collections/users/auth-with-password', {
  method: 'POST',
  body: { identity: process.env.APP_ADMIN_EMAIL, password: process.env.APP_ADMIN_PASSWORD }
})
const superAuth = await api('/api/collections/_superusers/auth-with-password', {
  method: 'POST',
  body: { identity: process.env.PB_SUPER_EMAIL, password: process.env.PB_SUPER_PASSWORD }
})
const token = admin.token
const suffix = Date.now()

let project
try {
  project = await api('/api/fangji/projects', {
    method: 'POST', token, status: 201,
    body: { name: `Page content ${suffix}` }
  })

  // 导入含生僻字 + PUA 的 CSV，走真实链路。
  const pua = String.fromCodePoint(0xE123)
  const csv = '﻿' + ['PDF页码,词头,释义', `1,${pua},站`].join('\r\n')
  const form = new FormData()
  form.set('file', new Blob([csv], { type: 'text/csv' }), 'content.csv')
  form.set('inspect_only', 'true')
  const job = await api(`/api/fangji/projects/${project.id}/imports/csv`, { method: 'POST', token, body: form, status: 202 })
  async function wait(status) {
    for (let i = 0; i < 100; i++) {
      const j = await api(`/api/collections/import_jobs/records/${job.id}`, { token })
      if (j.status === status) return j
      assert.notEqual(j.status, 'failed', JSON.stringify(j))
      await new Promise((r) => setTimeout(r, 100))
    }
    throw Error('import timeout')
  }
  await wait('validated')
  await api(`/api/fangji/imports/${job.id}/commit`, { method: 'POST', token, status: 202 })
  await wait('completed')

  const pages = await api(`/api/collections/pages/records?filter=${encodeURIComponent(`project="${project.id}"`)}`, { token })
  const page = pages.items[0]
  assert.equal(page.ocr_text, `${pua} 站`)
  assert.deepEqual(JSON.parse(page.row_headers_json), ['词头', '释义'])

  // 1. 三类身份拒绝
  const url = `/api/fangji/projects/${project.id}/pages/${page.id}/content`
  const body = {
    rowJson: JSON.stringify({ 词头: pua, 释义: '站立' }),
    text: `${pua} 站立`,
    headersJson: JSON.stringify(['词头', '释义']),
    expectedUpdated: ''
  }
  await fetch(base + url, { method: 'POST', headers: { 'Content-Type': 'application/json' } }).then((r) => assert.equal(r.status, 401))

  const outsiderEmail = `content-out-${suffix}@example.com`
  const outsider = await api('/api/collections/users/records', {
    method: 'POST',
    body: { email: outsiderEmail, name: 'outsider', role: 'user', password: 'ContentTest123!', passwordConfirm: 'ContentTest123!' }
  })
  const outsiderAuth = await api('/api/collections/users/auth-with-password', { method: 'POST', body: { identity: outsiderEmail, password: 'ContentTest123!' } })
  await api(url, { method: 'POST', token: outsiderAuth.token, body, status: 403 })

  const memberEmail = `content-member-${suffix}@example.com`
  const member = await api('/api/collections/users/records', {
    method: 'POST',
    body: { email: memberEmail, name: 'member', role: 'user', password: 'ContentTest123!', passwordConfirm: 'ContentTest123!' }
  })
  const memberAuth = await api('/api/collections/users/auth-with-password', { method: 'POST', body: { identity: memberEmail, password: 'ContentTest123!' } })
  await api(`/api/fangji/projects/${project.id}/members/${member.id}`, { method: 'PUT', token, body: { role: 'proofreader' } })
  await api(url, { method: 'POST', token: memberAuth.token, body, status: 403 })

  // 2. 乐观锁：错误 expectedUpdated → 409
  await api(url, { method: 'POST', token, body: { ...body, expectedUpdated: 'stale' }, status: 409 })

  // 3. 管理员正确写回 → 200，列序保真 + 集外字不破坏
  const updated = await api(url, { method: 'POST', token, body, status: 200 })
  assert.deepEqual(JSON.parse(updated.rowHeadersJson), ['词头', '释义'])
  assert.equal(updated.ocrText, `${pua} 站立`)
  assert.equal(JSON.parse(updated.ocrRowJson).词头, pua)

  const refreshed = await api(`/api/collections/pages/records/${page.id}`, { token })
  assert.deepEqual(JSON.parse(refreshed.row_headers_json), ['词头', '释义'])
  assert.equal(refreshed.ocr_text, `${pua} 站立`)
  assert.equal(JSON.parse(refreshed.ocr_row_json).词头, pua)

  console.log('PASS: page content edit auth (401/403), optimistic lock 409, column order preserved, PUA headword intact')
} finally {
  if (project) await api(`/api/collections/projects/records/${project.id}`, { method: 'DELETE', token: superAuth.token, status: 204 })
}
