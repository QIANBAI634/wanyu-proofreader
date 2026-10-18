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

async function poll(job, want) {
  for (let i = 0; i < 100; i++) {
    const current = await api(`/api/collections/import_jobs/records/${job.id}`, { token })
    if (want.includes(current.status)) return current
    assert.notEqual(current.status, 'failed', JSON.stringify(current))
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error('import timeout')
}

async function inspect({ rows, sourceId }) {
  const form = new FormData()
  form.set('file', new Blob([`词头,释义,PDF页码\n${rows}`], { type: 'text/csv' }), 'batch.csv')
  form.set('inspect_only', 'true')
  if (sourceId) form.set('source_id', sourceId)
  const job = await api(`/api/fangji/projects/${project.id}/imports/csv`, {
    method: 'POST', token, body: form, status: 202
  })
  return poll(job, ['validated'])
}

async function importCsv({ rows, sourceId }) {
  const job = await inspect({ rows, sourceId })
  await api(`/api/fangji/imports/${job.id}/commit`, { method: 'POST', token, status: 202 })
  return poll(job, ['completed', 'completed_with_errors'])
}

// 1. 只预检、不 commit 的作业：success_count 已写 ValidRows，但没有创建条目，不能算入册。
const precheckOnly = await inspect({ rows: '样例甲,释义甲,1\n' })
assert.equal(precheckOnly.status, 'validated')
assert.equal(precheckOnly.success_count, 1)

// 2. 不带来源的已提交批次，2 行全有效。
const unknownBatch = await importCsv({ rows: '样例乙,释义乙,1\n样例丙,释义丙,2\n' })
assert.equal(unknownBatch.status, 'completed')
assert.equal(unknownBatch.success_count, 2)
assert.equal(unknownBatch.total_count, 2)

// 3. 登记来源后，带来源的批次：1 行有效 + 1 行空内容跳过。
const source = await api('/api/fangji/sources', {
  method: 'POST', token, status: 201, body: { title: '台账测试来源', format: 'csv' }
})
const linkedBatch = await importCsv({ rows: '样例丁,释义丁,1\n,,2\n', sourceId: source.logical_id })
assert.equal(linkedBatch.status, 'completed_with_errors')
assert.equal(linkedBatch.success_count, 1)
assert.equal(linkedBatch.total_count, 2)

const ledger = await api(`/api/fangji/projects/${project.id}/import-ledger`, { token })

// 批次列表包含预检未提交的作业，但它不贡献入册量。
assert.equal(ledger.summary.total_batches, 3)
// 输入行数 = 1（预检）+ 2 + 2。
assert.equal(ledger.summary.total_rows, 5)
// 入册行数只算已提交终态的成功行：2 + 1，不含预检的 1。
assert.equal(ledger.summary.imported_rows, 3)
// 未知来源也只算已提交终态的成功行：仅第 2 批的 2 行。
assert.equal(ledger.summary.unknown_source_rows, 2)

const byLogicalId = Object.fromEntries(ledger.summary.sources.map((s) => [s.logical_id, s.rows]))
assert.equal(byLogicalId[''], 2)
assert.equal(byLogicalId[source.logical_id], 1)

const batchByStatus = Object.fromEntries(ledger.batches.map((b) => [b.status, b]))
assert.equal(batchByStatus.validated.total_count, 1)
assert.equal(batchByStatus.completed.source_link, 'unknown')
assert.equal(batchByStatus.completed_with_errors.source_logical_id, source.logical_id)

console.log('PASS: import ledger counts only committed success rows, separating input from imported')
