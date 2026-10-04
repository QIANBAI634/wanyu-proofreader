// #172 条目质量状态 v0：路由、权限、汇总对账与迁移缺省。
//
// 这条套件的重点是「不能只改一个裸枚举而没有理由」这句验收——它同时约束三件事：
// 状态取值必须封闭、validated/withheld 必须带依据、以及同值写入要被拒绝（否则审计
// 三列会被一次空变更刷新，看起来像有人最近确认过）。
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
  assert.equal(response.status, status, `${method} ${path}: ${JSON.stringify(data)}`)
  return data
}

const admin = await api('/api/collections/users/auth-with-password', {
  method: 'POST',
  body: { identity: process.env.APP_ADMIN_EMAIL, password: process.env.APP_ADMIN_PASSWORD }
})
const token = admin.token

const project = await api('/api/fangji/projects', { method: 'POST', token, body: { name: '质量状态夹具' }, status: 201 })

const upload = new FormData()
upload.set('file', new Blob(['词头,释义,PDF页码\n甲,一,1\n乙,二,2\n丙,三,3\n丁,四,4\n']), 'quality.csv')
upload.set('inspect_only', 'true')
const job = await api(`/api/fangji/projects/${project.id}/imports/csv`, { method: 'POST', token, body: upload, status: 202 })

async function waitJob(jobId, status) {
  for (let i = 0; i < 100; i++) {
    const current = await api(`/api/collections/import_jobs/records/${jobId}`, { token })
    if (current.status === status) return current
    assert.notEqual(current.status, 'failed', JSON.stringify(current))
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error('import timeout')
}

await waitJob(job.id, 'validated')
await api(`/api/fangji/imports/${job.id}/commit`, { method: 'POST', token, status: 202 })
await waitJob(job.id, 'completed')

const listPages = async (extra = '') => {
  const data = await api(`/api/fangji/projects/${project.id}/pages?perPage=50${extra}`, { token })
  return data.items.sort((left, right) => left.page_number - right.page_number)
}

const pages = await listPages()
assert.equal(pages.length, 4)

// 1）迁移与创建缺省：没有任何人标注过，四条都应是 candidate，而不是空串。
// 空串会让「筛 candidate」漏掉它们，也会让汇总出现第四种状态。
for (const page of pages) {
  assert.equal(page.quality_state, 'candidate', `page ${page.page_number} default state: ${JSON.stringify(page.quality_state)}`)
  assert.equal(page.quality_state_basis, '')
}

// 2）筛 candidate 必须连「从没写过值」的行一起带出来（v0 里空值与 candidate 同义）。
assert.equal((await listPages('&qualityState=candidate')).length, 4)
assert.equal((await listPages('&qualityState=validated')).length, 0)
assert.equal((await listPages('&qualityState=withheld')).length, 0)
await api(`/api/fangji/projects/${project.id}/pages?qualityState=quarantine`, { token, status: 400 })

const first = pages[0]
const second = pages[1]

// 3）candidate → validated 必须带依据，并把 who / when / basis 一起记下。
const validated = await api(`/api/fangji/projects/${project.id}/pages/${first.id}/quality-state`, {
  method: 'POST', token, body: { state: 'validated', basis: '两轮一致，无待仲裁项' }
})
assert.equal(validated.qualityState, 'validated')
assert.equal(validated.qualityBy, admin.record.id)
assert.equal(validated.qualityBasis, '两轮一致，无待仲裁项')
assert.ok(validated.qualityAt, 'qualityAt must be recorded')

const reloaded = (await listPages()).find((page) => page.id === first.id)
assert.equal(reloaded.quality_state, 'validated')
assert.equal(reloaded.quality_state_by, admin.record.id)
assert.equal(reloaded.quality_state_basis, '两轮一致，无待仲裁项')

// 4）无效输入：没有理由、取值表外、以及同值重写。
await api(`/api/fangji/projects/${project.id}/pages/${second.id}/quality-state`, {
  method: 'POST', token, status: 400, body: { state: 'validated' }
})
await api(`/api/fangji/projects/${project.id}/pages/${second.id}/quality-state`, {
  method: 'POST', token, status: 400, body: { state: 'validated', basis: '   ' }
})
await api(`/api/fangji/projects/${project.id}/pages/${second.id}/quality-state`, {
  method: 'POST', token, status: 400, body: { state: 'quarantine', basis: '未知取值' }
})
await api(`/api/fangji/projects/${project.id}/pages/${first.id}/quality-state`, {
  method: 'POST', token, status: 400, body: { state: 'validated', basis: '重新确认' }
})

// 5）any → withheld 同样要理由；退回 candidate 是撤销动作，可以不写。
const withheld = await api(`/api/fangji/projects/${project.id}/pages/${second.id}/quality-state`, {
  method: 'POST', token, body: { state: 'withheld', basis: '权利未决' }
})
assert.equal(withheld.qualityState, 'withheld')
await api(`/api/fangji/projects/${project.id}/pages/${second.id}/quality-state`, {
  method: 'POST', token, body: { state: 'candidate' }
})

// 6）汇总与逐条读取对账：这是「覆盖大项目」那条验收的最小形式，
// 汇总走 COUNT(*) GROUP BY，逐条走分页接口，两者的桶必须一致。
const summary = await api(`/api/fangji/projects/${project.id}/quality-summary`, { token })
assert.equal(summary.total, 4)
assert.equal(summary.byState.validated, 1)
assert.equal(summary.byState.withheld, 0)
assert.equal(summary.byState.candidate, 3)
assert.equal(summary.byState.validated + summary.byState.withheld + summary.byState.candidate, summary.total)
assert.equal(summary.byImportBatch.length, 1)
assert.equal(summary.byImportBatch[0].importJob, job.id)
assert.equal(summary.byImportBatch[0].count, 4)

const perState = {}
for (const state of ['candidate', 'validated', 'withheld']) {
  perState[state] = (await listPages(`&qualityState=${state}`)).length
}
assert.deepEqual(perState, {
  candidate: summary.byState.candidate,
  validated: summary.byState.validated,
  withheld: summary.byState.withheld
})

// 7）权限：项目成员（校对员）不是 manager，读写都必须被挡住；
// 非成员连汇总也看不到。用 403 而不是 200+空数据，避免「看起来能读」。
const member = await api('/api/collections/users/records', {
  method: 'POST',
  body: {
    email: 'quality-member@example.com',
    name: 'member',
    role: 'user',
    password: 'QualityTest12345!',
    passwordConfirm: 'QualityTest12345!'
  }
})
const memberAuth = await api('/api/collections/users/auth-with-password', {
  method: 'POST',
  body: { identity: 'quality-member@example.com', password: 'QualityTest12345!' }
})
await api(`/api/fangji/projects/${project.id}/members/${member.id}`, { method: 'PUT', token, body: { role: 'proofreader' } })
await api(`/api/fangji/projects/${project.id}/pages/${first.id}/quality-state`, {
  method: 'POST', token: memberAuth.token, status: 403, body: { state: 'withheld', basis: '校对员不该能改' }
})
await api(`/api/fangji/projects/${project.id}/quality-summary`, { token: memberAuth.token, status: 403 })
await api(`/api/fangji/projects/${project.id}/pages?qualityState=validated`, { token: memberAuth.token, status: 403 })

const outsider = await api('/api/collections/users/records', {
  method: 'POST',
  body: {
    email: 'quality-outsider@example.com',
    name: 'outsider',
    role: 'user',
    password: 'QualityTest12345!',
    passwordConfirm: 'QualityTest12345!'
  }
})
const outsiderAuth = await api('/api/collections/users/auth-with-password', {
  method: 'POST',
  body: { identity: 'quality-outsider@example.com', password: 'QualityTest12345!' }
})
await api(`/api/fangji/projects/${project.id}/quality-summary`, { token: outsiderAuth.token, status: 403 })
assert.ok(outsider.id)

// 8）条目属于别的项目时按 404 报，不能用 403 承认「这个 id 在别处存在」。
const other = await api('/api/fangji/projects', { method: 'POST', token, body: { name: '质量状态旁项目' }, status: 201 })
await api(`/api/fangji/projects/${other.id}/pages/${first.id}/quality-state`, {
  method: 'POST', token, status: 404, body: { state: 'withheld', basis: '跨项目' }
})

console.log('PASS: quality state transitions, permissions and summary reconciliation')
