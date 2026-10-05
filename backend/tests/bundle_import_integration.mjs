// #183 Review Bundle 导入：幂等、自然键、版本并存、部分失败与恢复。
//
// 包在测试里现造（store 模式的最小 zip + 清单里的 sha256/行数/字节数），而不是提交
// 二进制夹具：夹具一旦提交，改了内容就要连二进制一起换，而「清单与内容对不上」
// 恰恰是这条链路上最该被看见的失败。
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'

const base = process.env.PB_URL

async function api(path, { method = 'GET', token = '', body, status = 200 } = {}) {
  const form = body instanceof FormData
  const response = await fetch(base + path, {
    method,
    headers: { Authorization: token, ...(!form && body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? (form ? body : JSON.stringify(body)) : undefined
  })
  const raw = await response.text()
  const data = raw ? JSON.parse(raw) : null
  assert.equal(response.status, status, `${method} ${path}: ${raw}`)
  return data
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let value = i
    for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    table[i] = value >>> 0
  }
  return table
})()

function crc32(buffer) {
  let value = 0xffffffff
  for (const byte of buffer) value = CRC_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8)
  return (value ^ 0xffffffff) >>> 0
}

// 只写 store（不压缩）的最小 zip：本地文件头 + 中央目录 + EOCD。
function buildZip(files) {
  const locals = []
  const central = []
  let offset = 0
  for (const file of files) {
    const name = Buffer.from(file.name, 'utf8')
    const data = file.data
    const crc = crc32(data)
    const header = Buffer.alloc(30)
    header.writeUInt32LE(0x04034b50, 0)
    header.writeUInt16LE(20, 4)
    header.writeUInt32LE(crc, 14)
    header.writeUInt32LE(data.length, 18)
    header.writeUInt32LE(data.length, 22)
    header.writeUInt16LE(name.length, 26)
    locals.push(header, name, data)

    const entry = Buffer.alloc(46)
    entry.writeUInt32LE(0x02014b50, 0)
    entry.writeUInt16LE(20, 4)
    entry.writeUInt16LE(20, 6)
    entry.writeUInt32LE(crc, 16)
    entry.writeUInt32LE(data.length, 20)
    entry.writeUInt32LE(data.length, 24)
    entry.writeUInt16LE(name.length, 28)
    entry.writeUInt32LE(offset, 42)
    central.push(entry, name)
    offset += header.length + name.length + data.length
  }
  const directory = Buffer.concat(central)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(files.length, 8)
  eocd.writeUInt16LE(files.length, 10)
  eocd.writeUInt32LE(directory.length, 12)
  eocd.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, directory, eocd])
}

const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex')

// 一条 payload 行：entry_id + fields。fieldValues 为 null 时该字段写成非文本值，
// 用来越过契约校验、落到导入侧的逐条错误上。
function payload(entries, requestedFields) {
  const lines = entries.map((entry) => {
    // 键序**照条目对象自己的顺序**写，而不是按 requested_fields 重排：
    // 夹具必须能造出「键序与 requested_fields 不一致」的条目，否则
    // 「列序取 requested_fields 而不是条目键序」这条断言是恒真的（造不出来就等于没测）。
    // 契约只要求 fields **包含** requested_fields，所以多给的键也照写。
    const fields = {}
    for (const [name, value] of Object.entries(entry)) {
      if (name === 'entry_id') continue
      fields[name] = value
    }
    for (const name of requestedFields) {
      if (!Object.hasOwn(fields, name)) fields[name] = ''
    }
    return JSON.stringify({ entry_id: entry.entry_id, fields })
  })
  return Buffer.from(`${lines.join('\n')}\n`, 'utf8')
}

function bundleZip({ bundleId, sourceVersion, requestedFields, entries, rightsRef, sourceSystem = 'xiangsheng-jihe', sourceId = 'synthetic-lexicon' }) {
  const data = payload(entries, requestedFields)
  const manifest = {
    bundle: { bundle_id: bundleId, schema_version: 'ReviewBundle/v0', created_at: new Date().toISOString() },
    source_system: sourceSystem,
    source_id: sourceId,
    source_version: sourceVersion,
    requested_fields: requestedFields,
    rights_ref: rightsRef,
    operator: 'bundle-import-suite',
    files: [{
      path: 'entries.jsonl',
      sha256: sha256(data),
      lines: entries.length,
      bytes: data.length
    }]
  }
  return buildZip([
    { name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest, null, 2), 'utf8') },
    { name: 'entries.jsonl', data }
  ])
}

async function waitJob(jobId, token, statuses) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const job = await api(`/api/collections/import_jobs/records/${jobId}`, { token })
    assert.notEqual(job.status, 'failed', JSON.stringify(job))
    if (statuses.includes(job.status)) return job
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error('bundle import timeout')
}

// waitJobAny 与 waitJob 的差别只有一处：**允许**终态是 failed。
// 「失败的批次能不能重试」这一格必须真的造一次失败，用那个把 failed 当异常的 helper
// 会让它永远测不到自己想测的东西。
async function waitJobAny(jobId, token, statuses) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const job = await api(`/api/collections/import_jobs/records/${jobId}`, { token })
    if (statuses.includes(job.status)) return job
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error('bundle import timeout')
}

async function upload(token, projectId, zip, fileName, status = 202) {
  const form = new FormData()
  form.set('bundle', new Blob([zip]), fileName)
  return api(`/api/fangji/projects/${projectId}/imports/bundle`, { method: 'POST', token, body: form, status })
}

const admin = await api('/api/collections/users/auth-with-password', {
  method: 'POST',
  body: { identity: process.env.APP_ADMIN_EMAIL, password: process.env.APP_ADMIN_PASSWORD }
})
let token = admin.token
const superAuth = await api('/api/collections/_superusers/auth-with-password', {
  method: 'POST',
  body: { identity: process.env.PB_SUPER_EMAIL, password: process.env.PB_SUPER_PASSWORD }
})
if (admin.record.must_change_password) {
  await api(`/api/collections/users/records/${admin.record.id}`, {
    method: 'PATCH', token: superAuth.token, body: { must_change_password: false }
  })
  const refreshed = await api('/api/collections/users/auth-with-password', {
    method: 'POST',
    body: { identity: process.env.APP_ADMIN_EMAIL, password: process.env.APP_ADMIN_PASSWORD }
  })
  token = refreshed.token
}

const suffix = Date.now()
const project = await api('/api/fangji/projects', {
  method: 'POST', token, status: 201, body: { name: `Bundle 导入夹具 ${suffix}` }
})

// rights_ref 必须是来源登记里**存在**的 logical_id：导入侧按 CSV 的既有口径
// （留空 ⇒ unknown；填了但找不到 ⇒ 拒绝这次导入）解析它，不静默标成未知。
// 所以夹具先真的登记一条来源，而不是写一个不存在的编号。
const source = await api('/api/fangji/sources', {
  method: 'POST', token, status: 201,
  body: { title: `Bundle 夹具来源 ${suffix}`, format: 'jsonl', holder: '测试权利主体', scope: '测试地区', status: 'confirmed' }
})
const RIGHTS_REF = source.logical_id

const listPages = async (filter = '', projectId = project.id) => {
  const query = `perPage=200&filter=${encodeURIComponent(`project="${projectId}"${filter}`)}`
  return (await api(`/api/collections/pages/records?${query}`, { token: superAuth.token })).items
}

const FIELDS = ['headword', 'reading']

// ---------- 1. 正常导入：键落库、行序与列序保持 ----------
const entriesA = [
  { entry_id: 'e-1', headword: '甲', reading: 'kah' },
  { entry_id: 'e-2', headword: '乙', reading: 'it' },
  { entry_id: 'e-3', headword: '丙', reading: 'piaN' }
]
const zipA = bundleZip({ bundleId: 'rb-suite-a', sourceVersion: '2026-10-02', requestedFields: FIELDS, entries: entriesA, rightsRef: RIGHTS_REF })
const created = await upload(token, project.id, zipA, 'a.zip')
assert.equal(created.mode, 'bundle')
assert.equal(created.bundle_id, 'rb-suite-a')
assert.equal(created.bundle_schema_version, 'ReviewBundle/v0')
assert.equal(created.total_count, 3)
// rights_ref 被解析进作业的来源登记，而不是一律 unknown。
assert.equal(created.source_link, 'linked')
assert.equal(created.source, source.id)
const freshJob = await waitJob(created.id, token, ['completed'])
// 全新的成功导入不该带任何「已跳过 N 条重复条目」的文案：过去这句是无条件写的。
assert.equal(freshJob.error_message, '', `fresh import must not report skipped rows: ${JSON.stringify(freshJob.error_message)}`)

let pages = await listPages()
assert.equal(pages.length, 3)
const byEntry = Object.fromEntries(pages.map((page) => [page.source_entry_id, page]))
assert.deepEqual(Object.keys(byEntry).sort(), ['e-1', 'e-2', 'e-3'])
for (const page of pages) {
  assert.equal(page.source_system, 'xiangsheng-jihe')
  assert.equal(page.source_id, 'synthetic-lexicon')
  assert.equal(page.source_version, '2026-10-02')
  assert.equal(page.status, 'pending')
  // 列顺序等于 requested_fields，不是 Go map 排序后的字母序。
  assert.equal(page.row_headers_json, JSON.stringify(FIELDS))
  assert.deepEqual(Object.keys(JSON.parse(page.ocr_row_json)), FIELDS)
}

// ---------- 2. 重放：同一 bundle 再来一次，条目数与条目 id 都不变 ----------
const replay = await upload(token, project.id, zipA, 'a.zip', 200)
assert.equal(replay.status, 'already_imported')
assert.equal(replay.job.id, created.id)
pages = await listPages()
assert.equal(pages.length, 3, '重放不得新建条目')

// ---------- 3. 版本变化：同 entry_id、新 source_version 并存，旧条目不覆盖 ----------
// 新版本的**内容故意与旧版本不同**：如果导入是覆盖而不是新增，旧条目的正文会跟着变，
// 这条断言就是冲着那个失败写的。同时比对 updated 时间戳，证明旧行压根没被写过。
const original = byEntry['e-1']
const originalRowJSON = original.ocr_row_json
const originalUpdated = original.updated
const entriesB = [
  { entry_id: 'e-1', headword: '甲改', reading: 'kah2' },
  { entry_id: 'e-2', headword: '乙改', reading: 'it2' },
  { entry_id: 'e-3', headword: '丙改', reading: 'piaN2' }
]

const zipB = bundleZip({ bundleId: 'rb-suite-b', sourceVersion: '2026-10-03', requestedFields: FIELDS, entries: entriesB, rightsRef: RIGHTS_REF })
const createdB = await upload(token, project.id, zipB, 'b.zip')
await waitJob(createdB.id, token, ['completed'])

pages = await listPages()
assert.equal(pages.length, 6, '新版本应产生新条目而不是覆盖旧条目')
const versions = pages.filter((page) => page.source_entry_id === 'e-1').map((page) => page.source_version).sort()
assert.deepEqual(versions, ['2026-10-02', '2026-10-03'])
const kept = (await listPages()).find((page) => page.id === original.id)
assert.ok(kept, '旧版本条目必须仍在库里（可追溯）')
assert.equal(kept.source_version, '2026-10-02')
assert.equal(kept.ocr_row_json, originalRowJSON, '旧版本内容不得被新版本覆盖')
assert.equal(kept.updated, originalUpdated, '旧版本记录不该被写一次')
const fresh = (await listPages()).find((page) => page.id === byEntry['e-1'].id ? false : page.source_entry_id === 'e-1' && page.source_version === '2026-10-03')
assert.match(fresh.ocr_row_json, /甲改/, '新版本条目要带上新内容')

// ---------- 3b. 列投影：多给的键不落库，但必须能被上报 ----------
// 契约只要求 fields **包含** requested_fields（下界），所以多给键不算违约；
// 但它们会经 column_roles 的按页 union 变成整个项目的一列并下发到校对端，因此不落库。
const projected = bundleZip({
  bundleId: 'rb-suite-projected',
  sourceVersion: '2026-10-02',
  requestedFields: FIELDS,
  rightsRef: RIGHTS_REF,
  entries: [{ entry_id: 'p-1', reading: 'kah', headword: '甲', upstream_note: '不该落库' }]
})
const projectedJob = await upload(token, project.id, projected, 'projected.zip')
const projectedDone = await waitJob(projectedJob.id, token, ['completed'])
const projectedPage = (await listPages()).find((page) => page.source_entry_id === 'p-1')
assert.ok(projectedPage, '投影后的条目必须落库')
assert.equal(projectedPage.row_headers_json, JSON.stringify(FIELDS), '列集合与顺序取 requested_fields')
assert.deepEqual(Object.keys(JSON.parse(projectedPage.ocr_row_json)), FIELDS)
assert.ok(!projectedPage.ocr_row_json.includes('upstream_note'), '未请求的键不得落库')
assert.match(projectedDone.error_message, /已忽略 1 个未请求字段：upstream_note/,
  `被丢掉的键必须能被看见：${JSON.stringify(projectedDone.error_message)}`)

// ---------- 3c. 已存在校对记录的条目：版本变化不带走历史 ----------
// #183 验收第 1 条的第三格。用真实的领取/提交接口造 attempts——只有走真链路，
// 这条断言才不是「旧行压根没进写入路径」那个隐含性质的同义反复。
//
// 领取接口自己挑下一条任务、不给指定页码，所以这一格用一个**只含一条条目**的独立项目：
// 这样「领到的那条」就是我们要的那条，不必靠顺序碰运气。
const attemptsProject = await api('/api/fangji/projects', {
  method: 'POST', token, status: 201, body: { name: `Bundle 校对记录夹具 ${suffix}` }
})
const zipAttempts = bundleZip({
  bundleId: 'rb-suite-attempts', sourceVersion: '2026-10-02', requestedFields: FIELDS, rightsRef: RIGHTS_REF,
  entries: [{ entry_id: 'a-1', headword: '戍', reading: 'su' }]
})
const attemptsJob = await upload(token, attemptsProject.id, zipAttempts, 'attempts.zip')
await waitJob(attemptsJob.id, token, ['completed'])

const readerEmail = `bundle-reader-${suffix}@example.com`
const reader = await api('/api/collections/users/records', {
  method: 'POST',
  body: { email: readerEmail, password: 'BundleTest12345!', passwordConfirm: 'BundleTest12345!', name: '校对员', role: 'user' }
})
const readerAuth = await api('/api/collections/users/auth-with-password', {
  method: 'POST', body: { identity: readerEmail, password: 'BundleTest12345!' }
})
await api(`/api/fangji/projects/${attemptsProject.id}/members/${reader.id}`, { method: 'PUT', token, body: { role: 'proofreader' } })

const claimed = await api(`/api/fangji/projects/${attemptsProject.id}/claim`, { method: 'POST', token: readerAuth.token })
await api(`/api/fangji/pages/${claimed.id}/submit`, {
  method: 'POST', token: readerAuth.token,
  // 盲校：领取响应里没有原文，校对员交的是他自己敲进去的内容。
  body: { rowJson: JSON.stringify({ headword: '戍', reading: 'su' }), text: '戍 su', leaseToken: claimed.leaseToken }
})

const attemptsOf = async (pageId) => (await api(
  `/api/collections/proofreading_attempts/records?perPage=50&filter=${encodeURIComponent(`page="${pageId}"`)}`,
  { token: superAuth.token })).items
const beforeAttempts = await attemptsOf(claimed.id)
assert.ok(beforeAttempts.length > 0, '夹具必须真的产生一条校对记录')
const beforePage = (await api(`/api/collections/pages/records/${claimed.id}`, { token: superAuth.token }))
const beforeRowJSON = beforePage.ocr_row_json

// 再导入一次同 entry_id、新 source_version 的包。
const zipVersioned = bundleZip({
  bundleId: 'rb-suite-attempts-v2', sourceVersion: '2026-10-04', requestedFields: FIELDS, rightsRef: RIGHTS_REF,
  entries: [{ entry_id: 'a-1', headword: '戍改', reading: 'su2' }]
})
const versionedJob = await upload(token, attemptsProject.id, zipVersioned, 'attempts-v2.zip')
await waitJob(versionedJob.id, token, ['completed'])

const survivors = await listPages('', attemptsProject.id)
const keptPage = survivors.find((page) => page.id === claimed.id)
assert.ok(keptPage, '带校对记录的旧条目必须仍在库里')
assert.equal(keptPage.ocr_row_json, beforeRowJSON, '旧条目的正文不得被新版本改写')
const afterAttempts = await attemptsOf(claimed.id)
assert.deepEqual(afterAttempts.map((item) => item.id).sort(), beforeAttempts.map((item) => item.id).sort(),
  '旧条目的校对记录不得被导入带走')
const freshPage = survivors.find((page) => page.source_version === '2026-10-04')
assert.ok(freshPage, '新版本必须独立成一条')
assert.notEqual(freshPage.id, claimed.id)

// ---------- 4. 部分失败：全空行逐条报错，合法行继续 ----------
const mixed = []
for (let index = 0; index < 10; index++) mixed.push({ entry_id: `bad-${index}`, headword: '', reading: '' })
for (let index = 0; index < 3; index++) mixed.push({ entry_id: `good-${index}`, headword: `好${index}`, reading: 'ho' })
const zipC = bundleZip({ bundleId: 'rb-suite-c', sourceVersion: '2026-10-02', requestedFields: FIELDS, entries: mixed, rightsRef: RIGHTS_REF })
const createdC = await upload(token, project.id, zipC, 'c.zip')
const finishedC = await waitJob(createdC.id, token, ['completed', 'completed_with_errors', 'failed'])
assert.equal(finishedC.status, 'completed_with_errors', JSON.stringify(finishedC))
assert.equal(finishedC.success_count, 3)
assert.equal(finishedC.failed_count, 10)
const errors = await api(
  `/api/collections/import_job_errors/records?perPage=50&filter=${encodeURIComponent(`job="${createdC.id}"`)}`,
  { token: superAuth.token }
)
assert.equal(errors.totalItems, 10)
for (const item of errors.items) {
  assert.equal(item.error_code, 'EMPTY_CONTENT')
  assert.ok(item.row_number > 0, '错误清单必须带行号')
  assert.match(item.message, /内容不能为空/)
}
// 3（A）+ 3（B 新版本）+ 1（投影那条）+ 3（C 的合法行）= 10。
assert.equal((await listPages()).length, 10, '合法的 3 条必须全部落库')

// ---------- 5. 存量无来源键的条目不受唯一索引影响 ----------
// CSV 导入建的条目三列为空串：pages 那条部分唯一索引的 WHERE 把空串排除在外，
// 所以它们不会互相冲突。
async function importCsv(projectId, name, content) {
  const form = new FormData()
  form.set('file', new Blob([content]), name)
  form.set('inspect_only', 'true')
  const job = await api(`/api/fangji/projects/${projectId}/imports/csv`, { method: 'POST', token, body: form, status: 202 })
  for (let attempt = 0; attempt < 100; attempt++) {
    const current = await api(`/api/collections/import_jobs/records/${job.id}`, { token })
    assert.notEqual(current.status, 'failed', JSON.stringify(current))
    if (current.status === 'validated') break
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  await api(`/api/fangji/imports/${job.id}/commit`, { method: 'POST', token, status: 202 })
  return waitJob(job.id, token, ['completed', 'completed_with_errors'])
}

await importCsv(project.id, 'plain.csv', '词头,释义,PDF页码\n壬,九,1\n癸,十,2\n')
// 再导一次 CSV：这是作业级索引那条 `bundle_id != ''` 谓词的回归位。
// CSV / OCR 作业的 bundle_id 是空串，若唯一的谓词只写 status != 'failed'，
// 同一项目里的第二个 CSV 作业就会在 (project, '') 上撞唯一约束、整条导入返回 400
// ——这个缺口在 CI 上出现过一次。本套件自己钉一格，不指望别处兜着。
await importCsv(project.id, 'plain-2.csv', '词头,释义,PDF页码\n甲一,十一,3\n')
const withCSV = await listPages()
assert.equal(withCSV.length, 13)
assert.equal(withCSV.filter((page) => page.source_entry_id === '').length, 3)

// ---------- 5b. failed 可重试：同一个 bundle_id 修好后应当能再导 ----------
// bundle_id 是来源侧身份、上游不能随意改，所以把 failed 也算进幂等短路，
// 等于让一个瞬时失败的批次永久无法经由 API 重试。这里先造一次真失败（全部行空内容），
// 再用同一个 bundle_id 上传改正后的包，断言它建了新作业并且导成功。
const broken = bundleZip({
  bundleId: 'rb-suite-retry', sourceVersion: '2026-10-02', requestedFields: FIELDS, rightsRef: RIGHTS_REF,
  entries: [{ entry_id: 'r-1', headword: '', reading: '' }]
})
const brokenJob = await upload(token, project.id, broken, 'broken.zip')
const brokenDone = await waitJobAny(brokenJob.id, token, ['failed', 'completed_with_errors'])
assert.equal(brokenDone.status, 'failed', JSON.stringify(brokenDone))

const fixed = bundleZip({
  bundleId: 'rb-suite-retry', sourceVersion: '2026-10-02', requestedFields: FIELDS, rightsRef: RIGHTS_REF,
  entries: [{ entry_id: 'r-1', headword: '修好了', reading: 'sua' }]
})
const retried = await upload(token, project.id, fixed, 'fixed.zip')
assert.notEqual(retried.id, brokenJob.id, 'failed 作业不得短路重试，必须建新作业')
await waitJob(retried.id, token, ['completed'])
assert.ok((await listPages()).some((page) => page.source_entry_id === 'r-1'), '重试应当真的导进来')

// ---------- 6. 恢复：作业被中断后重启，重放不产生重复 ----------
// 这一段留给 --prepare-recovery / --verify-recovery 两个阶段（见
// run_bundle_import_integration.py）：只有在真实重启后重新入队，才谈得上「中断恢复」。
if (process.argv.includes('--prepare-recovery')) {
  const handoff = process.env.BUNDLE_RECOVERY_JOB_FILE
  assert.ok(handoff, '--prepare-recovery needs BUNDLE_RECOVERY_JOB_FILE')
  await api(`/api/collections/import_jobs/records/${created.id}`, {
    method: 'PATCH', token: superAuth.token, body: { status: 'processing' }
  })
  // 回读确认这次改写真的落库了：写没落库的话，重启后的恢复扫描什么也不会做，
  // 而「恢复通过」会变成一个恒真的绿灯——这正是这条验收最容易骗过人的地方。
  const parked = await api(`/api/collections/import_jobs/records/${created.id}`, { token: superAuth.token })
  assert.equal(parked.status, 'processing', 'prepare phase must leave the job parked in processing')
  // 被恢复的是**这一支**作业、**这个**项目——两个 id 必须显式交给下一阶段。
  // 靠"同名的 bundle_id"去找会找错：下一步会用同样的 bundle_id 建一个新项目。
  // pagesBefore 要在**这一刻**数：withCSV.length 是第 5 步的快照，
  // 其后还有会新增条目的格子（失败重试那一格就加了一条），拿旧快照当基线
  // 会让下一阶段把「本来就该多出来的一条」误判成重放新建。
  writeFileSync(handoff, JSON.stringify({
    jobId: created.id,
    projectId: project.id,
    pagesBefore: (await listPages()).length
  }))
  console.log(`PREPARED: job ${created.id} left in processing state for the restart phase`)
} else if (process.argv.includes('--verify-recovery')) {
  const handoff = JSON.parse(readFileSync(process.env.BUNDLE_RECOVERY_JOB_FILE, 'utf8'))
  const recovered = await waitJob(handoff.jobId, token, ['completed', 'completed_with_errors'])
  assert.equal(recovered.status, 'completed', '恢复后必须落到确定态，不能留在 processing')
  assert.equal(recovered.success_count, 3)
  // 这一次是**全量重放**（零写入），而上一阶段的同一条断言在一次全新导入上也为真——
  // 所以必须有一条能区分两者的 oracle，否则「重放」在作业记录上是隐形的。
  assert.match(recovered.error_message, /已跳过 3 条重复条目/, `重放必须在作业上可见：${JSON.stringify(recovered.error_message)}`)
  const afterRecovery = await listPages('', handoff.projectId)
  for (const page of afterRecovery) {
    assert.notEqual(page.status, 'importing', '不得留下 importing 僵尸')
  }
  assert.equal(afterRecovery.length, handoff.pagesBefore, '恢复重放不得新建条目')
} else {
  console.log('PASS: bundle import is idempotent, version-safe and reports partial failures')
}
