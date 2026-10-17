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

const project = await api('/api/fangji/projects', { method: 'POST', token, body: { name: '台账夹具' }, status: 201 })

async function importCsv({ rows, sourceId }) {
  const form = new FormData()
  form.set('file', new Blob([`词头,释义,PDF页码\n${rows}`], { type: 'text/csv' }), 'batch.csv')
  form.set('inspect_only', 'true')
  if (sourceId) form.set('source_id', sourceId)
  const job = await api(`/api/fangji/projects/${project.id}/imports/csv`, {
    method: 'POST', token, body: form, status: 202
  })
  for (let i = 0; i < 100; i++) {
    const current = await api(`/api/collections/import_jobs/records/${job.id}`, { token })
    if (current.status === 'validated') break
    assert.notEqual(current.status, 'failed', JSON.stringify(current))
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  await api(`/api/fangji/imports/${job.id}/commit`, { method: 'POST', token, status: 202 })
  for (let i = 0; i < 100; i++) {
    const current = await api(`/api/collections/import_jobs/records/${job.id}`, { token })
    if (current.status === 'completed') return current
    assert.notEqual(current.status, 'failed', JSON.stringify(current))
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error('import timeout')
}

// 第一批：不带来源 → 应记 source_link=unknown。
const unknownBatch = await importCsv({ rows: '样例甲,释义甲,1\n样例乙,释义乙,2\n' })
assert.equal(unknownBatch.source_link, 'unknown')
assert.equal(unknownBatch.success_count, 2)

// 登记一个来源，第二批带 source_id → 应记 source_link=linked。
const source = await api('/api/fangji/sources', {
  method: 'POST', token, status: 201, body: { title: '台账测试来源', format: 'csv' }
})
const linkedBatch = await importCsv({ rows: '样例丙,释义丙,1\n', sourceId: source.logical_id })
assert.equal(linkedBatch.source_link, 'linked')
assert.equal(linkedBatch.success_count, 1)

const ledger = await api(`/api/fangji/projects/${project.id}/import-ledger`, { token })
assert.equal(ledger.summary.total_batches, 2)
assert.equal(ledger.summary.total_rows, 3)
assert.equal(ledger.summary.imported_rows, 3)
assert.equal(ledger.summary.unknown_source_rows, 2)

// 来源覆盖：空来源 2 行 + 登记来源 1 行。
const byLogicalId = Object.fromEntries(ledger.summary.sources.map((s) => [s.logical_id, s.rows]))
assert.equal(byLogicalId[''], 2)
assert.equal(byLogicalId[source.logical_id], 1)

// 批次列表：两条，各自的来源字段正确。
assert.equal(ledger.batches.length, 2)
const batchBySourceLink = Object.fromEntries(ledger.batches.map((b) => [b.source_link, b]))
assert.equal(batchBySourceLink.unknown.source_logical_id, '')
assert.equal(batchBySourceLink.unknown.total_count, 2)
assert.equal(batchBySourceLink.linked.source_logical_id, source.logical_id)
assert.equal(batchBySourceLink.linked.source_title, '台账测试来源')
assert.equal(batchBySourceLink.linked.total_count, 1)

console.log('PASS: import ledger reports row count, source coverage, and unknown-source count across batches')
