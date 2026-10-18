import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'

const baseUrl = process.env.PB_URL || 'http://127.0.0.1:18091'
const email = process.env.APP_ADMIN_EMAIL || 'upload-test@example.com'
const password = process.env.APP_ADMIN_PASSWORD || 'UploadTest123!'

async function request(path, { method = 'GET', token = '', body, expected = 200 } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(token ? { Authorization: token } : {}),
      ...(typeof body === 'string' ? { 'Content-Type': 'application/json' } : {})
    },
    body
  })
  const raw = await response.text()
  let payload = null
  if (raw) {
    try {
      payload = JSON.parse(raw)
    } catch {
      payload = raw
    }
  }
  assert.equal(response.status, expected, `${method} ${path}: ${response.status} ${raw}`)
  return payload
}

async function waitFor(path, token, terminalStatuses, timeoutMs = Number(process.env.IMPORT_WAIT_TIMEOUT_MS) || 20_000) {
  // 默认 20s 是本机/常规 CI 下「一次导入应能到终态」的合理预算；race 检测下服务端约慢一个
  // 量级，1200 行的导入在共享 runner 上会贴边超时。CI 的 race-integration 作业通过
  // `--env IMPORT_WAIT_TIMEOUT_MS` 给它更高预算。这不是掩盖回归：这里只在等一个**终态**
  // （completed / completed_with_errors / failed），真正的回归要么让作业落到 failed、要么
  // 让后面的 success_count / failed_count 断言失败——那两种情况都不是「等得更久」能救的。
  //
  // 于是「等超时」这一条路必须把两件事说清楚，否则预算被调大之后它就成了一句无法行动的话：
  //   ① 最后一次读到的状态是什么（「没到终态、停在 processing」与「到了别的终态」处置不同）；
  //   ② 用的是多少预算（是默认 20s 还是 CI 传进来的那个数）。
  // 预算越大，超时越可能只是慢；在这里把两个事实打出来，读日志的人不必再去翻 env。
  const deadline = Date.now() + timeoutMs
  let last = null
  while (Date.now() < deadline) {
    last = await request(path, { token })
    if (terminalStatuses.includes(last.status)) return last
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  const waited = `${timeoutMs}ms${process.env.IMPORT_WAIT_TIMEOUT_MS ? '（来自 IMPORT_WAIT_TIMEOUT_MS）' : '（默认预算）'}`
  if (!last) throw new Error(`等 ${path} 的终态超时：${waited} 内一次都没读成功`)
  throw new Error(
    `等 ${path} 的终态超时：预算 ${waited}，最后读到的状态是 ${last.status}，` +
    `等的是 ${terminalStatuses.join(' / ')}。` +
    '停在非终态说明作业还在跑或已经卡住（看服务端日志的 work_started/work_finished）；' +
    '若它已经落到别的终态，那是作业本身的问题，加预算不会让它变成期望的那个状态。'
  )
}

function minimalPdf(pageCount = 1, paddingBytes = 0) {
  const objects = []
  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>'
  const pageIds = Array.from({ length: pageCount }, (_, index) => 3 + index)
  objects[2] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageCount} >>`
  for (let index = 0; index < pageCount; index += 1) {
    const pageId = 3 + index
    const contentId = 3 + pageCount + index
    objects[pageId] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << >> /Contents ${contentId} 0 R >>`
    const content = index === 0 ? ' '.repeat(paddingBytes) : ''
    objects[contentId] = `<< /Length ${content.length} >>\nstream\n${content}\nendstream`
  }

  let output = '%PDF-1.4\n'
  const offsets = [0]
  for (let id = 1; id < objects.length; id += 1) {
    offsets[id] = Buffer.byteLength(output)
    output += `${id} 0 obj\n${objects[id]}\nendobj\n`
  }
  const xrefOffset = Buffer.byteLength(output)
  output += `xref\n0 ${objects.length}\n`
  output += '0000000000 65535 f \n'
  for (let id = 1; id < objects.length; id += 1) {
    output += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`
  }
  output += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`
  return output
}

const authBody = new FormData()
authBody.set('identity', email)
authBody.set('password', password)
const auth = await request('/api/collections/users/auth-with-password', {
  method: 'POST',
  body: authBody
})
const token = auth.token

const projectBody = JSON.stringify({
  name: `Upload integration ${Date.now()}`,
  description: 'temporary upload integration project'
})
const project = await request('/api/fangji/projects', {
  method: 'POST',
  token,
  body: projectBody,
  expected: 201
})

try {
  const csv = [
    'PDF页码,词条,释义',
    '1,天光,早晨',
    'abc,坏页码,应跳过',
    '2,"跨行词条","第一行',
    '第二行"',
    '3,,'
  ].join('\r\n')
  const csvBody = new FormData()
  csvBody.set('file', new Blob([csv], { type: 'text/csv' }), 'sample.csv')
  const queuedJob = await request(`/api/fangji/projects/${project.id}/imports/csv`, {
    method: 'POST',
    token,
    body: csvBody,
    expected: 202
  })
  const job = await waitFor(
    `/api/collections/import_jobs/records/${queuedJob.id}`,
    token,
    ['completed', 'completed_with_errors', 'failed']
  )
  assert.equal(job.status, 'completed_with_errors')
  assert.equal(job.success_count, 2)
  assert.equal(job.failed_count, 2)
  assert.equal(job.total_count, 4)

  const errors = await request(
    `/api/collections/import_job_errors/records?filter=${encodeURIComponent(`job="${job.id}"`)}&sort=row_number`,
    { token }
  )
  assert.deepEqual(
    errors.items.map((item) => item.error_code),
    ['INVALID_PDF_PAGE', 'EMPTY_CONTENT']
  )

  const pages = await request(
    `/api/collections/pages/records?filter=${encodeURIComponent(`project="${project.id}"`)}&sort=page_number`,
    { token }
  )
  assert.equal(pages.totalItems, 2)
  assert.ok(pages.items.every((item) => item.import_job === job.id))
  assert.ok(pages.items.every((item) => item.status === 'pending'))
  assert.match(pages.items[1].ocr_text, /第一行\s+第二行/)

  const invalidHeaderBody = new FormData()
  invalidHeaderBody.set(
    'file',
    new Blob(['词条,释义\r\n天光,早晨'], { type: 'text/csv' }),
    'missing-page-column.csv'
  )
  invalidHeaderBody.set('inspect_only', 'true')
  const invalidHeaderRecord = await request(`/api/fangji/projects/${project.id}/imports/csv`, {
    method: 'POST',
    token,
    body: invalidHeaderBody,
    expected: 202
  })
  const invalidHeaderJob = await waitFor(
    `/api/collections/import_jobs/records/${invalidHeaderRecord.id}`,
    token,
    ['failed']
  )
  assert.equal(invalidHeaderJob.error_code, 'CSV_HEADER_INVALID')
  assert.ok(invalidHeaderJob.finished_at, 'failed CSV inspection must record its terminal time')

  const largeRows = ['\ufeffentry_id,page,词条,释义']
  for (let index = 1; index <= 1200; index += 1) {
    largeRows.push(`${index},${Math.ceil(index / 10)},词条${index},释义${index}`)
  }
  largeRows.push('1201,not-a-page,错误词条,错误释义')
  const inspectionBody = new FormData()
  inspectionBody.set(
    'file',
    new Blob([largeRows.join('\r\n')], { type: 'text/csv' }),
    'large-alias.csv'
  )
  inspectionBody.set('inspect_only', 'true')
  const inspectingJob = await request(`/api/fangji/projects/${project.id}/imports/csv`, {
    method: 'POST',
    token,
    body: inspectionBody,
    expected: 202
  })
  const inspectedJob = await waitFor(
    `/api/collections/import_jobs/records/${inspectingJob.id}`,
    token,
    ['validated', 'failed']
  )
  assert.equal(inspectedJob.status, 'validated')
  assert.equal(inspectedJob.total_count, 1201)
  assert.equal(inspectedJob.success_count, 1200)
  assert.equal(inspectedJob.failed_count, 1)
  const inspection = JSON.parse(inspectedJob.inspection_json)
  assert.equal(inspection.encoding, 'UTF-8')
  assert.equal(inspection.pdf_page_field, 'page')
  assert.equal(inspection.min_pdf_page, 1)
  assert.equal(inspection.max_pdf_page, 120)
  assert.deepEqual(inspection.headers, ['entry_id', 'page', '词条', '释义'])
  assert.equal(inspection.preview.length, 5)

  const preflightErrors = await request(
    `/api/collections/import_job_errors/records?filter=${encodeURIComponent(`job="${inspectedJob.id}"`)}`,
    { token }
  )
  assert.deepEqual(preflightErrors.items.map((item) => item.error_code), ['INVALID_PDF_PAGE'])

  const queuedInspectedJob = await request(`/api/fangji/imports/${inspectedJob.id}/commit`, {
    method: 'POST',
    token,
    expected: 202
  })
  assert.equal(queuedInspectedJob.status, 'queued')
  const importedInspectedJob = await waitFor(
    `/api/collections/import_jobs/records/${inspectedJob.id}`,
    token,
    ['completed', 'completed_with_errors', 'failed']
  )
  assert.equal(importedInspectedJob.status, 'completed_with_errors')
  assert.equal(importedInspectedJob.success_count, 1200)
  assert.equal(importedInspectedJob.failed_count, 1)
  const importedAliasPages = await request(
    `/api/collections/pages/records?filter=${encodeURIComponent(`import_job="${inspectedJob.id}"`)}&sort=page_number&perPage=20`,
    { token }
  )
  assert.equal(importedAliasPages.totalItems, 1200)
  assert.ok(importedAliasPages.items.every((item) => item.status === 'pending'))
  assert.equal(importedAliasPages.items.filter((item) => item.pdf_page === 1).length, 10)
  assert.deepEqual(JSON.parse(importedAliasPages.items[0].ocr_row_json), {
    entry_id: '1',
    词条: '词条1',
    释义: '释义1'
  })

  const duplicateBody = new FormData()
  duplicateBody.set(
    'file',
    new Blob([largeRows.join('\r\n')], { type: 'text/csv' }),
    'large-alias.csv'
  )
  duplicateBody.set('inspect_only', 'true')
  const duplicateJob = await request(`/api/fangji/projects/${project.id}/imports/csv`, {
    method: 'POST',
    token,
    body: duplicateBody,
    expected: 200
  })
  assert.equal(duplicateJob.id, inspectedJob.id)
  assert.equal(duplicateJob.status, 'completed_with_errors')

  const validPdfBody = new FormData()
  validPdfBody.set('file', new Blob([minimalPdf(1)], { type: 'application/pdf' }), 'valid.pdf')
  const validPdfRecord = await request(`/api/fangji/projects/${project.id}/files/pdf`, {
    method: 'POST',
    token,
    body: validPdfBody,
    expected: 202
  })
  const validPdf = await waitFor(
    `/api/collections/project_files/records/${validPdfRecord.id}`,
    token,
    ['ready', 'error']
  )
  assert.equal(validPdf.status, 'ready')
  assert.equal(validPdf.page_count, 1)
  assert.equal(validPdf.validation_tool, 'pdfcpu v0.16.2')
  assert.equal(validPdf.is_primary, true)

  const snapshotCsvBody = new FormData()
  snapshotCsvBody.set(
    'file',
    new Blob(['page,词条\r\n1,固定到 PDF A'], { type: 'text/csv' }),
    'pdf-snapshot.csv'
  )
  snapshotCsvBody.set('inspect_only', 'true')
  const snapshotJobRecord = await request(`/api/fangji/projects/${project.id}/imports/csv`, {
    method: 'POST',
    token,
    body: snapshotCsvBody,
    expected: 202
  })
  const snapshotJob = await waitFor(
    `/api/collections/import_jobs/records/${snapshotJobRecord.id}`,
    token,
    ['validated', 'failed']
  )
  assert.equal(snapshotJob.status, 'validated')
  assert.equal(snapshotJob.project_file, validPdf.id)
  assert.equal(snapshotJob.pdf_page_limit, 1)
  assert.equal(snapshotJob.pdf_snapshot_captured, true)

  const replacementPdfBody = new FormData()
  replacementPdfBody.set('file', new Blob([minimalPdf(2)], { type: 'application/pdf' }), 'replacement.pdf')
  const replacementPdfRecord = await request(`/api/fangji/projects/${project.id}/files/pdf`, {
    method: 'POST',
    token,
    body: replacementPdfBody,
    expected: 202
  })
  const replacementPdf = await waitFor(
    `/api/collections/project_files/records/${replacementPdfRecord.id}`,
    token,
    ['ready', 'error']
  )
  assert.equal(replacementPdf.status, 'ready')
  assert.equal(replacementPdf.page_count, 2)
  assert.equal(replacementPdf.is_primary, true)
  const supersededPdf = await request(
    `/api/collections/project_files/records/${validPdf.id}`,
    { token }
  )
  assert.equal(supersededPdf.is_primary, false)
  assert.ok(supersededPdf.superseded_at)

  const replacementSnapshotCsvBody = new FormData()
  replacementSnapshotCsvBody.set(
    'file',
    new Blob(['page,词条\r\n1,固定到 PDF A'], { type: 'text/csv' }),
    'pdf-snapshot.csv'
  )
  replacementSnapshotCsvBody.set('inspect_only', 'true')
  const replacementSnapshotJobRecord = await request(
    `/api/fangji/projects/${project.id}/imports/csv`,
    {
      method: 'POST',
      token,
      body: replacementSnapshotCsvBody,
      expected: 202
    }
  )
  assert.notEqual(replacementSnapshotJobRecord.id, snapshotJob.id)
  const replacementSnapshotJob = await waitFor(
    `/api/collections/import_jobs/records/${replacementSnapshotJobRecord.id}`,
    token,
    ['validated', 'failed']
  )
  assert.equal(replacementSnapshotJob.project_file, replacementPdf.id)
  assert.equal(replacementSnapshotJob.pdf_page_limit, 2)

  await request(`/api/fangji/imports/${snapshotJob.id}/commit`, {
    method: 'POST',
    token,
    expected: 202
  })
  const importedSnapshotJob = await waitFor(
    `/api/collections/import_jobs/records/${snapshotJob.id}`,
    token,
    ['completed', 'completed_with_errors', 'failed']
  )
  assert.equal(importedSnapshotJob.status, 'completed')
  const snapshotPages = await request(
    `/api/collections/pages/records?filter=${encodeURIComponent(`import_job="${snapshotJob.id}"`)}`,
    { token }
  )
  assert.equal(snapshotPages.totalItems, 1)
  assert.equal(snapshotPages.items[0].project_file, validPdf.id)

  const outOfRangeCsvBody = new FormData()
  outOfRangeCsvBody.set(
    'file',
    new Blob(['page,词条\r\n3,超范围'], { type: 'text/csv' }),
    'out-of-range.csv'
  )
  outOfRangeCsvBody.set('inspect_only', 'true')
  const outOfRangeJobRecord = await request(`/api/fangji/projects/${project.id}/imports/csv`, {
    method: 'POST',
    token,
    body: outOfRangeCsvBody,
    expected: 202
  })
  const outOfRangeJob = await waitFor(
    `/api/collections/import_jobs/records/${outOfRangeJobRecord.id}`,
    token,
    ['validated', 'failed']
  )
  assert.equal(outOfRangeJob.status, 'validated')
  assert.equal(outOfRangeJob.success_count, 0)
  assert.equal(outOfRangeJob.failed_count, 1)
  const outOfRangeErrors = await request(
    `/api/collections/import_job_errors/records?filter=${encodeURIComponent(`job="${outOfRangeJob.id}"`)}`,
    { token }
  )
  assert.deepEqual(outOfRangeErrors.items.map((item) => item.error_code), ['PDF_PAGE_OUT_OF_RANGE'])

  const invalidPdfBody = new FormData()
  invalidPdfBody.set('file', new Blob(['not a pdf'], { type: 'application/pdf' }), 'invalid.pdf')
  const invalidPdf = await request(`/api/fangji/projects/${project.id}/files/pdf`, {
    method: 'POST',
    token,
    body: invalidPdfBody,
    expected: 400
  })
  assert.match(invalidPdf.message, /不是有效的 PDF/)

  const corruptPdfBody = new FormData()
  corruptPdfBody.set(
    'file',
    new Blob(['%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF'], { type: 'application/pdf' }),
    'corrupt.pdf'
  )
  const corruptPdfRecord = await request(`/api/fangji/projects/${project.id}/files/pdf`, {
    method: 'POST',
    token,
    body: corruptPdfBody,
    expected: 202
  })
  const corruptPdf = await waitFor(
    `/api/collections/project_files/records/${corruptPdfRecord.id}`,
    token,
    ['ready', 'error']
  )
  assert.equal(corruptPdf.status, 'error')
  assert.equal(corruptPdf.error_code, 'PDF_DEEP_VALIDATION_FAILED')

  if (process.env.TEST_LARGE_PDF === '1') {
    // Pad a valid page content stream and recalculate xref offsets. Adjust
    // for the variable-width PDF length/offset numbers to hit exact sizes.
    for (const size of [80 * 1024 * 1024, 100 * 1024 * 1024, 100 * 1024 * 1024 + 1]) {
      let padding = size - 1024
      let source = minimalPdf(1, padding)
      while (Buffer.byteLength(source) !== size) {
        padding += size - Buffer.byteLength(source)
        source = minimalPdf(1, padding)
      }
      const body = new FormData()
      body.set('file', new Blob([source], { type: 'application/pdf' }), `large-${size}.pdf`)
      const accepted = size <= 100 * 1024 * 1024
      const record = await request(`/api/fangji/projects/${project.id}/files/pdf`, {
        method: 'POST', token, body, expected: accepted ? 202 : 400
      })
      if (accepted) {
        const pdf = await waitFor(`/api/collections/project_files/records/${record.id}`, token, ['ready', 'error'], 300_000)
        assert.equal(pdf.status, 'ready', pdf.error_message)
        assert.equal(pdf.file_size, size)
        assert.equal(pdf.page_count, 1)
        assert.equal(pdf.is_primary, true)
      } else {
        assert.match(record.message, /100 MB/)
      }
      console.log(`PDF size ${size} bytes: ${accepted ? 'ready' : 'rejected'} as expected`)
    }
  }

  const realPdfPath = process.env.REAL_PDF_PATH
  const realCsvPath = process.env.REAL_CSV_PATH
  if (realPdfPath && realCsvPath) {
    const realPdfBody = new FormData()
    realPdfBody.set(
      'file',
      new Blob([await readFile(realPdfPath)], { type: 'application/pdf' }),
      basename(realPdfPath)
    )
    const realPdfRecord = await request(`/api/fangji/projects/${project.id}/files/pdf`, {
      method: 'POST',
      token,
      body: realPdfBody,
      expected: 202
    })
    const realPdf = await waitFor(
      `/api/collections/project_files/records/${realPdfRecord.id}`,
      token,
      ['ready', 'error'],
      300_000
    )
    assert.equal(
      realPdf.status,
      'ready',
      `${realPdf.error_code || 'PDF_ERROR'}: ${realPdf.error_message || 'unknown PDF validation error'}`
    )
    assert.ok(realPdf.page_count > 0)
    assert.equal(realPdf.is_primary, true)

    const realCsvBody = new FormData()
    realCsvBody.set(
      'file',
      new Blob([await readFile(realCsvPath)], { type: 'text/csv' }),
      basename(realCsvPath)
    )
    realCsvBody.set('inspect_only', 'true')
    const realCsvRecord = await request(`/api/fangji/projects/${project.id}/imports/csv`, {
      method: 'POST',
      token,
      body: realCsvBody,
      expected: 202
    })
    const realCsv = await waitFor(
      `/api/collections/import_jobs/records/${realCsvRecord.id}`,
      token,
      ['validated', 'failed'],
      300_000
    )
    assert.equal(realCsv.status, 'validated')
    assert.ok(realCsv.total_count > 0)
    assert.equal(realCsv.failed_count, 0)
  }

  console.log('Upload job integration test passed.')
} finally {
  await request(`/api/fangji/projects/${project.id}`, {
    method: 'DELETE',
    token,
    expected: 204
  })
}
