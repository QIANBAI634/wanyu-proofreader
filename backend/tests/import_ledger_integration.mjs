import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'

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

async function poll(job, want) {
  for (let i = 0; i < 200; i++) {
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

// ===================== 场景一：CSV 入册口径 =====================

const project = await api('/api/fangji/projects', { method: 'POST', token, body: { name: '台账 CSV 夹具' }, status: 201 })

// 1. 只预检、不 commit：success_count 已写 ValidRows，但没有创建条目，不能算入册。
const precheckOnly = await inspect({ rows: '样例甲,释义甲,1\n' })
assert.equal(precheckOnly.status, 'validated')
assert.equal(precheckOnly.success_count, 1)

// 2. 不带来源的已提交批次，2 行全有效。
const unknownBatch = await importCsv({ rows: '样例乙,释义乙,1\n样例丙,释义丙,2\n' })
assert.equal(unknownBatch.status, 'completed')
assert.equal(unknownBatch.success_count, 2)

// 3. 登记来源后，带来源的批次：1 行有效 + 1 行空内容跳过。
const source = await api('/api/fangji/sources', {
  method: 'POST', token, status: 201, body: { title: '台账测试来源', format: 'csv' }
})
const linkedBatch = await importCsv({ rows: '样例丁,释义丁,1\n,,2\n', sourceId: source.logical_id })
assert.equal(linkedBatch.status, 'completed_with_errors')
assert.equal(linkedBatch.success_count, 1)
assert.equal(linkedBatch.total_count, 2)

let ledger = await api(`/api/fangji/projects/${project.id}/import-ledger`, { token })
assert.equal(ledger.summary.total_batches, 3)
assert.equal(ledger.summary.total_rows, 5)        // 输入 1 + 2 + 2
assert.equal(ledger.summary.imported_rows, 3)     // 实际条目 0 + 2 + 1，不含预检
assert.equal(ledger.summary.unknown_source_rows, 2) // 仅第 2 批的 2 条
const byLogicalId = Object.fromEntries(ledger.summary.sources.map((s) => [s.logical_id, s.rows]))
assert.equal(byLogicalId[''], 2)
assert.equal(byLogicalId[source.logical_id], 1)
const batchByStatus = Object.fromEntries(ledger.batches.map((b) => [b.status, b]))
assert.equal(batchByStatus.validated.inserted_count, 0)      // 预检未建条目
assert.equal(batchByStatus.completed.inserted_count, 2)
assert.equal(batchByStatus.completed_with_errors.inserted_count, 1)

// ===================== 场景二：bundle 复用自然键不重复计入册 =====================

// store 模式最小 zip + 清单 sha256/行数/字节数（不提交二进制夹具）。
const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let v = i
    for (let bit = 0; bit < 8; bit++) v = v & 1 ? 0xedb88320 ^ (v >>> 1) : v >>> 1
    t[i] = v >>> 0
  }
  return t
})()
const crc32 = (buf) => {
  let v = 0xffffffff
  for (const b of buf) v = CRC_TABLE[(v ^ b) & 0xff] ^ (v >>> 8)
  return (v ^ 0xffffffff) >>> 0
}
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')
function buildZip(files) {
  const locals = []; const central = []; let offset = 0
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8'); const data = f.data
    const h = Buffer.alloc(30); h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4)
    h.writeUInt32LE(crc32(data), 14); h.writeUInt32LE(data.length, 18); h.writeUInt32LE(data.length, 22)
    h.writeUInt16LE(name.length, 26)
    locals.push(h, name, data)
    const e = Buffer.alloc(46); e.writeUInt32LE(0x02014b50, 0); e.writeUInt16LE(20, 4); e.writeUInt16LE(20, 6)
    e.writeUInt32LE(crc32(data), 16); e.writeUInt32LE(data.length, 20); e.writeUInt32LE(data.length, 24)
    e.writeUInt16LE(name.length, 28); e.writeUInt32LE(offset, 42)
    central.push(e, name)
    offset += h.length + name.length + data.length
  }
  const directory = Buffer.concat(central)
  const eocd = Buffer.alloc(22); eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(files.length, 8); eocd.writeUInt16LE(files.length, 10)
  eocd.writeUInt32LE(directory.length, 12); eocd.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, directory, eocd])
}
function payload(entries, fields) {
  const lines = entries.map((entry) => JSON.stringify({ entry_id: entry.entry_id, fields: Object.fromEntries(fields.map((n) => [n, entry[n]])) }))
  return Buffer.from(`${lines.join('\n')}\n`, 'utf8')
}
function bundleZip({ bundleId, entries, rightsRef, fields = ['headword', 'reading'] }) {
  const data = payload(entries, fields)
  const manifest = {
    bundle: { bundle_id: bundleId, schema_version: 'ReviewBundle/v0', created_at: new Date().toISOString() },
    source_system: 'xiangsheng-jihe', source_id: 'synthetic-lexicon', source_version: '2026-10-02',
    requested_fields: fields, rights_ref: rightsRef, operator: 'ledger-suite',
    files: [{ path: 'entries.jsonl', sha256: sha256(data), lines: entries.length, bytes: data.length }]
  }
  return buildZip([
    { name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest), 'utf8') },
    { name: 'entries.jsonl', data }
  ])
}

const bundleSource = await api('/api/fangji/sources', {
  method: 'POST', token, status: 201, body: { title: '台账 bundle 来源', format: 'jsonl', status: 'confirmed' }
})
const bundleProject = await api('/api/fangji/projects', { method: 'POST', token, body: { name: '台账 bundle 夹具' }, status: 201 })
async function uploadBundle(zip, name) {
  const form = new FormData()
  form.set('bundle', new Blob([zip]), name)
  const job = await api(`/api/fangji/projects/${bundleProject.id}/imports/bundle`, { method: 'POST', token, body: form, status: 202 })
  return poll(job, ['completed', 'completed_with_errors'])
}

const entries = [
  { entry_id: 'e-1', headword: '甲', reading: 'kah' },
  { entry_id: 'e-2', headword: '乙', reading: 'it' }
]
const bundleA = await uploadBundle(bundleZip({ bundleId: 'rb-a', entries, rightsRef: bundleSource.logical_id }), 'a.zip')
assert.equal(bundleA.success_count, 2)
const bundleB = await uploadBundle(bundleZip({ bundleId: 'rb-b', entries, rightsRef: bundleSource.logical_id }), 'b.zip')
assert.equal(bundleB.success_count, 2) // 复用自然键仍计为「成功处理」，但不建新条目

const bundleLedger = await api(`/api/fangji/projects/${bundleProject.id}/import-ledger`, { token })
assert.equal(bundleLedger.summary.total_batches, 2)
assert.equal(bundleLedger.summary.total_rows, 4)      // 输入 2 + 2
assert.equal(bundleLedger.summary.imported_rows, 2)   // 实际条目只有 2，第二批建 0 条
assert.equal(bundleLedger.summary.unknown_source_rows, 0)
const bundleBySource = Object.fromEntries(bundleLedger.summary.sources.map((s) => [s.logical_id, s.rows]))
assert.equal(bundleBySource[bundleSource.logical_id], 2)
const bundleInserted = bundleLedger.batches.map((b) => b.inserted_count).sort()
assert.deepEqual(bundleInserted, [0, 2])              // 第二批 inserted_count = 0

console.log('PASS: import ledger counts actual pages (not success_count) for CSV and bundle reuse')
