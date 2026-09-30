import assert from 'node:assert/strict'
import { toSafeCsvCell } from '../../frontend/src/lib/csvExport.js'
import { orderedRowHeaders, safeParseRowJson } from '../../frontend/src/composables/useStructuredRow.js'

const baseUrl = process.env.PB_URL || 'http://127.0.0.1:18095'
const sample = '𢶀𠮷㙟𰻞䲠a̤̍o̤̍〔Ǿɑɡɔ∣‖①⑭■▲◆●﹑－―—～５〕ãăǎạa̩'
const suffix = Date.now()
let project

async function request(path, { method = 'GET', token = '', body, expected = 200 } = {}) {
  const multipart = body instanceof FormData
  const response = await fetch(baseUrl + path, {
    method,
    headers: {
      ...(token ? { Authorization: token } : {}),
      ...(body && !multipart ? { 'Content-Type': 'application/json' } : {})
    },
    body: body === undefined ? undefined : multipart ? body : JSON.stringify(body)
  })
  const raw = await response.text()
  assert.equal(response.status, expected, `${method} ${path}: ${raw}`)
  return raw ? JSON.parse(raw) : null
}

async function waitJob(id, token, statuses) {
  for (let n = 0; n < 150; n++) {
    const job = await request(`/api/collections/import_jobs/records/${id}`, { token })
    assert.notEqual(job.status, 'failed', JSON.stringify(job))
    if (statuses.includes(job.status)) return job
    await new Promise((r) => setTimeout(r, 200))
  }
  throw new Error('import timeout')
}

// buildExpectedCsv 复刻前端 ProjectDetailView.vue:922-945 的纯计算部分，
// 直接用前端 toSafeCsvCell / orderedRowHeaders / safeParseRowJson，作为逐字节比对基准。
function buildExpectedCsv(pages) {
  const headers = []
  const rows = pages.map((item) => {
    const proofObj = item.status === 'approved' ? safeParseRowJson(item.proofread_row_json) : null
    const ocrObj = safeParseRowJson(item.ocr_row_json)
    const rowObj = proofObj || ocrObj || { 内容: item.proofread_text || item.ocr_text || '' }
    for (const key of orderedRowHeaders(item, rowObj)) {
      if (!headers.includes(key)) headers.push(key)
    }
    return { pageNumber: Number(item.pdf_page) || Number(item.page_number) || '', rowObj }
  })
  const finalHeaders = ['PDF页码', ...headers]
  const lines = [finalHeaders.map(toSafeCsvCell).join(',')]
  for (const row of rows) {
    const values = [row.pageNumber, ...headers.map((h) => row.rowObj[h] ?? '')]
    lines.push(values.map(toSafeCsvCell).join(','))
  }
  return '﻿' + lines.join('\r\n')
}

const admin = await request('/api/collections/users/auth-with-password', {
  method: 'POST',
  body: { identity: process.env.APP_ADMIN_EMAIL, password: process.env.APP_ADMIN_PASSWORD }
})
const superAuth = await request('/api/collections/_superusers/auth-with-password', {
  method: 'POST',
  body: { identity: process.env.PB_SUPER_EMAIL, password: process.env.PB_SUPER_PASSWORD }
})
const token = admin.token
try {
  project = await request('/api/fangji/projects', {
    method: 'POST', token, expected: 201,
    body: { name: `导出产物 ${suffix}`, description: sample }
  })

  // 导入含生僻字/IPA/PUA 的 CSV（3 行），走 inspect → commit 真实链路。
  const csv = '﻿' + ['PDF页码,词条,音读,释义', ...[1, 2, 3].map((n) => `${n},${sample},kiā,站、立`)].join('\r\n')
  const data = new FormData()
  data.set('file', new Blob([csv], { type: 'text/csv;charset=utf-8' }), `导出${suffix}.csv`)
  data.set('inspect_only', 'true')
  const queued = await request(`/api/fangji/projects/${project.id}/imports/csv`, { method: 'POST', token, body: data, expected: 202 })
  await waitJob(queued.id, token, ['validated'])
  await request(`/api/fangji/imports/${queued.id}/commit`, { method: 'POST', token, expected: 202 })
  await waitJob(queued.id, token, ['completed'])

  const pages = (await request(`/api/collections/pages/records?filter=${encodeURIComponent(`project="${project.id}"`)}&sort=page_number&perPage=50`, { token })).items
  assert.equal(pages.length, 3)

  // 导出 → 下载 → 与前端函数重建的期望串逐字节比对。
  const artifact = await request(`/api/fangji/projects/${project.id}/exports/csv`, { method: 'POST', token, expected: 201 })
  assert.equal(artifact.kind, 'csv')
  assert.ok(artifact.file_name.endsWith('_校对结果.csv'))

  const downloaded = await fetch(`${baseUrl}/api/fangji/artifacts/${artifact.id}/download`, { headers: { Authorization: token } })
  assert.equal(downloaded.status, 200)
  const bytes = Buffer.from(await downloaded.arrayBuffer())
  const expected = buildExpectedCsv(pages)
  assert.equal(bytes.toString('utf8'), expected)
  assert.ok(expected.includes(sample))
  console.log('PASS: server export byte-identical to frontend export logic, rare/IPA/PUA chars intact')

  // 版本历史：再导一次 → 两条 artifact 记录，created 递增。
  const artifact2 = await request(`/api/fangji/projects/${project.id}/exports/csv`, { method: 'POST', token, expected: 201 })
  assert.notEqual(artifact2.id, artifact.id)
  const list = (await request(`/api/collections/project_artifacts/records?filter=${encodeURIComponent(`project="${project.id}"`)}&sort=-created`, { token })).items
  assert.equal(list.length, 2)
  assert.ok(list[0].created >= list[1].created)
  console.log('PASS: repeated export produces versioned artifacts ordered by created desc')

  // 非管理员下载应 403。
  const readerEmail = `artifact-${suffix}@example.com`
  const reader = await request('/api/collections/users/records', {
    method: 'POST',
    body: { email: readerEmail, password: 'Reader12345', passwordConfirm: 'Reader12345', name: '读者', role: 'user' }
  })
  const readerAuth = await request('/api/collections/users/auth-with-password', { method: 'POST', body: { identity: readerEmail, password: 'Reader12345' } })
  await request(`/api/fangji/projects/${project.id}/members/${reader.id}`, { method: 'PUT', token, body: { role: 'proofreader' } })
  await fetch(`${baseUrl}/api/fangji/artifacts/${artifact.id}/download`, { headers: { Authorization: readerAuth.token } })
    .then((r) => assert.equal(r.status, 403, 'proofreader must not download artifacts'))
  console.log('PASS: artifact download restricted to project managers')
} finally {
  if (project) await request(`/api/collections/projects/records/${project.id}`, { method: 'DELETE', token: superAuth.token, expected: 204 })
}
