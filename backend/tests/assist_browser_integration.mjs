// #234 / #162 的界面证据套件：造出三种管理端状态与一个有层级数据的大厅，
// 然后交给 assist_browser.cjs 在真实服务端上截图（静态资源走 frontend/dist，
// /api/* 转发到 harness 起的那个真实 PocketBase，不是 mock）。
//
// 只有设了 ASSIST_BROWSER_SCRIPT 才跑浏览器（与 pdf_upload_browser 的模式一致）：
// 本地与 CI 都需要先装 playwright 并构建前端，缺任何一步都让它显式失败，
// 而不是静默产出一张"看起来对"的空图。
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const base = process.env.PB_URL
const script = process.env.ASSIST_BROWSER_SCRIPT
if (!script) {
  console.log('SKIP: 未设置 ASSIST_BROWSER_SCRIPT（需要 playwright 与已构建的 frontend/dist）')
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
const superAuth = await api('/api/collections/_superusers/auth-with-password', {
  method: 'POST', body: { identity: process.env.PB_SUPER_EMAIL, password: process.env.PB_SUPER_PASSWORD }
})
const suffix = `${Date.now()}`
const password = 'AssistBrowser123!'

async function userWithAuth (label) {
  const email = `${label}-${suffix}@example.com`
  const record = await api('/api/collections/users/records', {
    method: 'POST', token: superAuth.token,
    body: { email, password, passwordConfirm: password, name: label, role: 'user' }
  })
  const auth = await api('/api/collections/users/auth-with-password', {
    method: 'POST', body: { identity: email, password }
  })
  return { id: record.id, token: auth.token, record: auth.record }
}

const manager = await userWithAuth('assist-manager')
const reader = await userWithAuth('assist-reader')
const hallReader = await userWithAuth('assist-hall-reader')
const editorReader = await userWithAuth('assist-editor-reader')

const H = '词条,拼音,莆田IPA,仙游IPA,释义,PDF页码'
const DIRTY = `${H}\n人,lang2,kʰan2,taŋ2,人类,1\n人,lang2,kʰan2,taŋ2,别人,2\n甲 乙,ka1,ka32,ka32,两种东西,3\n`
const CLEAN = `${H}\n天,thin1,tʰĩ1,tʰĩ1,天空,1\n`
// 校对端证据用的两份词头：每一行都会撞上 `multiple_headwords_in_cell`（strong 级、
// 带 char_offsets），所以认领到哪一页都能看到同一种疑点——截图不依赖认领顺序。
const EDIT = `${H}\n甲 乙,ka1,ka32,ka32,两种东西,1\n丙 丁,pe1,pe32,pe32,两类东西,2\n`
// 管理端两种 off 措辞各要一份**只落在一类里**的夹具：混在一起时界面会把两句话都念出来
// （那是正确行为），但那张图就分不出钉的是哪一种。两行两列、标了列角色之后
// `meaningField` 为空，`reading_inside_meaning_row` 那条根本不会判，
// 于是无通道那一份只剩 `multiple_headwords_in_cell`，等证据那一份只剩 R6 的 l0-v1 判据。
const TWO_COL = '词头,莆田IPA,PDF页码'
const TWO_ROLES = { 词头: 'headword', 莆田IPA: 'reading' }
const NO_CHANNEL = `${TWO_COL}\n甲 乙,kʰin1,1\n丙 丁,kʰin1,2\n`
const WAITING = `${TWO_COL}\n甲,kʰin9876,1\n乙,kʰin98765,2\n`

async function makeProject (name, csv, { recompute = true, roles = null } = {}, members = []) {
  const project = await api('/api/fangji/projects', {
    method: 'POST', token: admin.token, status: 201, body: { name: `${name} ${suffix}` }
  })
  for (const [user, role] of members) {
    await api(`/api/fangji/projects/${project.id}/members/${user}`, { method: 'PUT', token: admin.token, body: { role } })
  }
  const form = new FormData()
  form.set('file', new Blob([csv]), 'seed.csv')
  form.set('inspect_only', 'true')
  const job = await api(`/api/fangji/projects/${project.id}/imports/csv`, { method: 'POST', token: admin.token, status: 202, body: form })
  for (const want of ['validated', 'completed']) {
    for (let i = 0; i < 200; i++) {
      const cur = await api(`/api/collections/import_jobs/records/${job.id}`, { token: superAuth.token })
      assert.notEqual(cur.status, 'failed', JSON.stringify(cur))
      if (cur.status === want) break
      await new Promise((r) => setTimeout(r, 100))
    }
    if (want === 'validated') await api(`/api/fangji/imports/${job.id}/commit`, { method: 'POST', token: admin.token, status: 202 })
  }
  // 列角色必须在重算之前落库：档位是按角色口径推的，晚一步就等于这批 tier 用旧口径算完再改。
  if (roles) {
    await api(`/api/fangji/projects/${project.id}/column-roles`, { method: 'PUT', token: admin.token, body: { roles } })
  }
  if (recompute) {
    await api(`/api/fangji/projects/${project.id}/identity/recompute`, { method: 'POST', token: admin.token })
    await api(`/api/fangji/projects/${project.id}/findings/recompute`, { method: 'POST', token: admin.token })
  }
  return project
}

const projectWithFindings = await makeProject('浏览器验收·有疑点', DIRTY, {}, [[manager.id, 'manager'], [reader.id, 'proofreader']])
const projectNeverRun = await makeProject('浏览器验收·未重算', DIRTY, { recompute: false }, [[manager.id, 'manager']])
const projectClean = await makeProject('浏览器验收·干净', CLEAN, {}, [[manager.id, 'manager']])
// 大厅那份单独用「词头 + 记音」两列：`kʰin9876` 那条被 R6 判 strong 落 B，
// 另两条零疑点走 pure_transcription 落 A（与 tier_dispatch 的已验证形状一致）。
// 一份 CSV 只落一档的话，这张图证明的就只是"层级条渲染了"，而不是"分层并存"（#162 第 4 条）。
// 三行由生产者算出 B/A/A；unknown 与 unlabeled 那两条另建（见下方注释），
// 于是层级条同时出现四枚芯片：两档可领 + 两种"没有档"各说各话（#247）。
const HALL_CSV = '词头,莆田IPA,PDF页码\n甲,kʰin9876,1\n乙,kʰin1,2\n丙,kʰin1,3\n'
const hallProject = await makeProject('浏览器验收·大厅层级', HALL_CSV,
  { roles: { 词头: 'headword', 莆田IPA: 'reading' } }, [[hallReader.id, 'proofreader']])
const editorProject = await makeProject('浏览器验收·校对端', EDIT, {}, [[editorReader.id, 'proofreader']])
const projectNoChannel = await makeProject('浏览器验收·无打分通道', NO_CHANNEL, { roles: TWO_ROLES }, [[manager.id, 'manager']])
const projectWaiting = await makeProject('浏览器验收·等证据', WAITING, { roles: TWO_ROLES }, [[manager.id, 'manager']])

// 截图前先把服务端事实钉住：三态在数据层必须真的不同，否则截图毫无意义。
const dirtyView = await api(`/api/fangji/projects/${projectWithFindings.id}/findings?per=200`, { token: admin.token })
assert.ok(dirtyView.items.length >= 2, JSON.stringify(dirtyView.items.map((i) => i.kind)))
const neverView = await api(`/api/fangji/projects/${projectNeverRun.id}/findings?per=200`, { token: admin.token })
assert.equal(neverView.items.length, 0, '未重算的项目不该已有疑点')
const cleanView = await api(`/api/fangji/projects/${projectClean.id}/findings?per=200`, { token: admin.token })
assert.equal(cleanView.items.length, 0, `干净项目不该产出疑点：${JSON.stringify(cleanView.items.map((i) => [i.kind, i.message.key]))}`)
const hallPages = await api(`/api/collections/pages/records?filter=${encodeURIComponent(`project="${hallProject.id}"`)}`, { token: superAuth.token })
const hallTiers = hallPages.items.map((p) => p.difficulty_tier).sort()
assert.deepEqual(hallTiers, ['A', 'A', 'B'], `大厅项目必须分层并存：${JSON.stringify(hallTiers)}`)
// unknown（算过但信号不足）与 unlabeled（从没算过）是两种"没有档"，界面必须分开说。
// 档位本身的生产由 tier_dispatch 套件钉，这里只要存储形状对就行——大厅读的是这一列。
// 只能**新建**而不能 PATCH 已有条目：待认领的页被 `pages` 的写入钩子挡着
// （"待认领任务只允许执行认领操作"），这条限制本身由 task_leases 套件守。
for (const [number, tier] of [[4, 'unknown'], [5, '']]) {
  await api('/api/collections/pages/records', {
    method: 'POST', token: superAuth.token,
    body: {
      project: hallProject.id, page_number: number, pdf_page: number,
      ocr_row_json: JSON.stringify({ 词头: `条${number}` }), ocr_text: `条${number}`,
      difficulty_tier: tier, proofread_round: 1, mismatch_count: 0, status: 'pending'
    }
  })
}
const hallQueue = await api('/api/fangji/proofreading-queues?page=1&perPage=50', { token: hallReader.token })
const hallRow = hallQueue.items.find((item) => JSON.stringify(item).includes(hallProject.id))
assert.deepEqual(hallRow.tiers, { A: 2, B: 1, C: 0, other: 1, unlabeled: 1 }, JSON.stringify(hallRow.tiers))
assert.equal(hallRow.claimable, 5, JSON.stringify(hallRow))
// 校对员触发项目级重算必须是 403（截图里"看不到按钮"的前提是接口真的拒）
await api(`/api/fangji/projects/${projectWithFindings.id}/findings/recompute`, {
  method: 'POST', token: reader.token, status: 403
})

// 两类措辞在数据层必须真的分得开：截图里那句话的前提是"这个项目当前批次的
// off 疑点全部落在同一类"，否则界面上同时出现两句话，图证就说不清钉的是哪一条。
const noChannelView = await api(`/api/fangji/projects/${projectNoChannel.id}/findings?per=200`, { token: admin.token })
assert.ok(noChannelView.items.length >= 2, JSON.stringify(noChannelView.items.map((i) => i.kind)))
assert.deepEqual([...new Set(noChannelView.items.map((i) => i.scoring_channel))], ['unscored'],
  JSON.stringify(noChannelView.items.map((i) => [i.kind, i.message.key, i.severity, i.scoring_channel])))
const waitingView = await api(`/api/fangji/projects/${projectWaiting.id}/findings?per=200`, { token: admin.token })
assert.ok(waitingView.items.length >= 1, JSON.stringify(waitingView.items.map((i) => [i.kind, i.message.key])))
assert.deepEqual([...new Set(waitingView.items.map((i) => i.scoring_channel))], ['scored'],
  JSON.stringify(waitingView.items.map((i) => [i.kind, i.message.key, i.severity, i.scoring_channel])))

// ---------- 校对端证据：先钉住"门控挡着"，再把放行动作交给截图脚本 ----------
//
// 这两张图要证明的是同一件事的两面：同一份疑点、同一个校对员、同一个条目，
// 唯一的差别是规则档位。所以放行必须在浏览器跑到一半时才发生，
// 这里只准备 payload——数字（n=120 / p̂=0.95）是**夹具自证的样例证据**，
// 不是对线上规则的结论；判据本身由 gate_release.js 校验，refused 必须为 0。
const editorPage = await api(`/api/fangji/projects/${editorProject.id}/claim`, {
  method: 'POST', token: editorReader.token, body: {}
})
const gated = await api(`/api/fangji/pages/${editorPage.id}/findings`, { token: editorReader.token })
assert.equal(gated.hints.length, 0, `规则没放行却有 hints：${JSON.stringify(gated.hints)}`)
assert.ok(gated.suppressed_by_gate >= 1, `校对端必须知道"有东西被挡住"：${JSON.stringify(gated)}`)

const editorIdentities = await api(`/api/fangji/projects/${editorProject.id}/findings?per=200`, { token: admin.token })
assert.ok(editorIdentities.items.length >= 2, JSON.stringify(editorIdentities.items.map((i) => [i.kind, i.message.key])))
// 四元组从**库里读**，不在这儿硬编码：硬编码的档位身份一旦和生产者漂移，
// 变更集会 refuse 或更糟——放行一条根本不存在的规则，截图照样"对"。
const seen = new Set()
const entries = []
for (const item of editorIdentities.items) {
  const identity = [item.producer, item.producer_version, item.kind, item.message.key].join('\u0000')
  if (seen.has(identity)) continue
  seen.add(identity)
  if (item.severity === 'info') continue
  const strong = item.severity === 'strong'
  entries.push({
    producer: item.producer,
    producer_version: item.producer_version,
    kind: item.kind,
    message_key: item.message.key,
    // strong 档要 n≥100 且 p̂≥0.90，warn 档要 n≥150 且 p̂≥0.60（门槛文件 §2，
    // 唯一出处是 gate_release.js 的 GATE_CRITERIA）。这里按各自门槛给足。
    gate: strong ? 'strong' : 'warn',
    sample_n: strong ? 120 : 160,
    precision_hat: strong ? 0.95 : 0.75,
    approved_by: 'platform-admin@assist-browser-evidence',
    approved_at: new Date().toISOString()
  })
}
assert.ok(entries.length >= 1, '没有可放行的 strong/warn 疑点，校对端截图无法成立')
assert.ok(entries.some((e) => e.gate === 'strong'), '至少要有一条 strong，否则高亮分支不会被走到')

const fixture = path.resolve(process.env.ASSIST_BROWSER_FIXTURE || '/tmp/assist-browser-fixture.json')
// #240 的三态截图需要一条"此刻库里确实没有结论"的条目：截图里那句"还没有人登记过"
// 如果其实是加载失败留下的空壳，这张图就不能当验收证据。
const blockedPages = await api(`/api/collections/pages/records?filter=${encodeURIComponent(`project="${projectWithFindings.id}"`)}&sort=page_number&perPage=1`, { token: superAuth.token })
const blockedPage = blockedPages.items[0]
assert.ok(blockedPage, '有疑点的项目里必须有条目')
assert.equal(blockedPage.blocked_reason ?? '', '', `截图要拍的那条必须还没有结论：${JSON.stringify(blockedPage.blocked_reason)}`)
writeFileSync(fixture, JSON.stringify({
  base, manager, reader, hallReader, editorReader,
  admin: { token: admin.token, record: admin.record },
  projectWithFindings, projectNeverRun, projectClean, hallProject, editorProject,
  projectNoChannel, projectWaiting,
  blockedPage, editorPage, editorIdentities: entries
}))
const outDir = process.env.ASSIST_BROWSER_OUTPUT || path.resolve('.', 'output/playwright/assist-admin')

const result = spawnSync('node', [script], {
  stdio: 'inherit',
  env: { ...process.env, ASSIST_BROWSER_FIXTURE: fixture, ASSIST_BROWSER_OUTPUT: outDir }
})
assert.equal(result.status, 0, `assist_browser.cjs 退出码 ${result.status}`)

for (const name of ['findings-normal', 'findings-empty-never-run', 'findings-empty-clean', 'findings-forbidden',
  'findings-no-channel', 'findings-waiting-evidence', 'hall-tiers', 'hall-claim-by-tier',
  'proofreader-gated', 'proofreader-hints',
  'blocked-conclusion-unset', 'blocked-conclusion-settled', 'blocked-conclusion-no-permission']) {
  const file = path.join(outDir, `${name}.png`)
  assert.ok(existsSync(file), `缺截图：${file}`)
  assert.ok(statSync(file).size > 4096, `截图过小，疑似空白页：${file} ${statSync(file).size}`)
  const size = statSync(file).size
  console.log(`screenshot ${name}.png ${size} bytes`)
}
console.log('Assist browser integration test passed.')

for (const id of [projectWithFindings.id, projectNeverRun.id, projectClean.id, hallProject.id, editorProject.id,
  projectNoChannel.id, projectWaiting.id]) {
  await api(`/api/collections/projects/records/${id}`, { method: 'DELETE', token: superAuth.token, status: 204 })
}
for (const id of [manager.id, reader.id, hallReader.id, editorReader.id]) {
  await api(`/api/collections/users/records/${id}`, { method: 'DELETE', token: superAuth.token, status: 204 })
}
