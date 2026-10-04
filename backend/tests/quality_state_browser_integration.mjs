// #172 的界面证据驱动程序：造出三桶各有取值的项目与一个空项目，
// 然后交给 quality_state_browser.cjs 在真实服务端上截图（静态资源走 frontend/dist，
// /api/* 转发到 harness 起的那个真实 PocketBase，不是 mock）。
//
// 只有设了 QUALITY_BROWSER_SCRIPT 才跑浏览器（与 assist_browser / pdf_upload_browser
// 的模式一致）：本地与 CI 都需要先装 playwright 并构建前端，缺任何一步都让它显式失败，
// 而不是静默产出一张"看起来对"的空图。
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const base = process.env.PB_URL
const script = process.env.QUALITY_BROWSER_SCRIPT
if (!script) {
  console.log('SKIP: 未设置 QUALITY_BROWSER_SCRIPT（需要 playwright 与已构建的 frontend/dist）')
  process.exit(0)
}

async function api (p, { method = 'GET', token = '', body, status = 200 } = {}) {
  const form = body instanceof FormData
  const r = await fetch(base + p, {
    method,
    headers: { ...(token ? { Authorization: token } : {}), ...(!form && body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? (form ? body : JSON.stringify(body)) : undefined
  })
  const raw = await r.text()
  let data = null
  if (raw) { try { data = JSON.parse(raw) } catch { data = raw } }
  assert.equal(r.status, status, `${method} ${p} -> ${r.status} ${raw}`)
  return data
}

const admin = await api('/api/collections/users/auth-with-password', {
  method: 'POST', body: { identity: process.env.APP_ADMIN_EMAIL, password: process.env.APP_ADMIN_PASSWORD }
})
// 删除项目只对 superuser 开放（API 规则，不是成员权限），所以收尾要用另一个身份。
const superAuth = await api('/api/collections/_superusers/auth-with-password', {
  method: 'POST', body: { identity: process.env.PB_SUPER_EMAIL, password: process.env.PB_SUPER_PASSWORD }
})
const suffix = `${Date.now()}`

async function waitJob (jobId, status) {
  for (let i = 0; i < 200; i++) {
    const current = await api(`/api/collections/import_jobs/records/${jobId}`, { token: admin.token })
    if (current.status === status) return current
    assert.notEqual(current.status, 'failed', JSON.stringify(current))
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error('import timeout')
}

async function importCsv (projectId, csv) {
  const upload = new FormData()
  upload.set('file', new Blob([csv]), 'quality-browser.csv')
  upload.set('inspect_only', 'true')
  const created = await api(`/api/fangji/projects/${projectId}/imports/csv`, {
    method: 'POST', token: admin.token, body: upload, status: 202
  })
  await waitJob(created.id, 'validated')
  await api(`/api/fangji/imports/${created.id}/commit`, { method: 'POST', token: admin.token, status: 202 })
  await waitJob(created.id, 'completed')
}

const project = await api('/api/fangji/projects', {
  method: 'POST', token: admin.token, status: 201, body: { name: `质量状态截图 ${suffix}` }
})
await importCsv(project.id, '词头,释义,PDF页码\n甲,一,1\n乙,二,2\n丙,三,3\n丁,四,4\n')

const pages = await api(
  `/api/collections/pages/records?perPage=50&sort=page_number&filter=${encodeURIComponent(`project="${project.id}"`)}`,
  { token: admin.token }
)
assert.equal(pages.items.length, 4, '夹具应有 4 条条目')

// 两桶各一条，留两条在缺省桶：三枚芯片才会出现不同的数字——
// 全 0 或全相同的截图无法证明汇总真的在按桶计数。
const mark = (page, state, basis) => api(`/api/fangji/projects/${project.id}/pages/${page.id}/quality-state`, {
  method: 'POST', token: admin.token, body: { state, basis }
})
await mark(pages.items[0], 'validated', '两轮一致，无待仲裁项')
await mark(pages.items[1], 'withheld', '权利未决，暂不外发')

const summary = await api(`/api/fangji/projects/${project.id}/quality-summary`, { token: admin.token })
assert.deepEqual(
  { candidate: summary.byState.candidate, validated: summary.byState.validated, withheld: summary.byState.withheld },
  { candidate: 2, validated: 1, withheld: 1 },
  `截图的夹具桶不对：${JSON.stringify(summary.byState)}`
)

const emptyProject = await api('/api/fangji/projects', {
  method: 'POST', token: admin.token, status: 201, body: { name: `质量状态空态 ${suffix}` }
})

const fixture = path.resolve(process.env.QUALITY_BROWSER_FIXTURE || 'quality-browser-fixture.json')
mkdirSync(path.dirname(fixture), { recursive: true })
writeFileSync(fixture, JSON.stringify({
  base,
  manager: { token: admin.token, record: admin.record },
  project,
  emptyProject
}))
const outDir = process.env.QUALITY_BROWSER_OUTPUT || path.resolve('.', 'output/playwright/quality-state')

const result = spawnSync('node', [script], {
  stdio: 'inherit',
  env: { ...process.env, QUALITY_BROWSER_FIXTURE: fixture, QUALITY_BROWSER_OUTPUT: outDir }
})
assert.equal(result.status, 0, `quality_state_browser.cjs 退出码 ${result.status}`)

for (const name of ['quality-state-summary', 'quality-state-filter-withheld', 'quality-state-basis-required',
  'quality-state-server-rejected', 'quality-state-after-change', 'quality-state-empty-project']) {
  const file = path.join(outDir, `${name}.png`)
  assert.ok(existsSync(file), `缺截图：${file}`)
  assert.ok(statSync(file).size > 4096, `截图过小，疑似空白页：${file} ${statSync(file).size}`)
}
console.log('Quality state browser integration test passed.')

for (const id of [project.id, emptyProject.id]) {
  await api(`/api/collections/projects/records/${id}`, { method: 'DELETE', token: superAuth.token, status: 204 })
}
