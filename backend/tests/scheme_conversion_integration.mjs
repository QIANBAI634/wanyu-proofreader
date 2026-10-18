// #190 拼音转换的运行面：作业、四行汇总、复核队列、结论回流与断点续跑。
//
// 规则用的是 #281 的**合成适配器**（每条 basis 都写着 synthetic），不是任何一套真实
// 莆仙方案——真实方案要等 #114 点名的乡音社清单到手。所以这条套件证明的是「机器能跑」，
// 不是「转换是对的」；它产出的拼音不能进乡声集盒。这一点同时写在 PR 正文与页面文案里。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const base = process.env.PB_URL

async function api(path, { method = 'GET', token = '', body, expected = 200 } = {}) {
  const form = body instanceof FormData
  const response = await fetch(base + path, {
    method,
    headers: { ...(token ? { Authorization: token } : {}), ...(body && !form ? { 'Content-Type': 'application/json' } : {}) },
    body: body === undefined ? undefined : form ? body : JSON.stringify(body)
  })
  const raw = await response.text()
  const parsed = raw ? JSON.parse(raw) : null
  assert.equal(response.status, expected, `${method} ${path}: ${raw}`)
  return parsed
}

const admin = await api('/api/collections/users/auth-with-password', {
  method: 'POST',
  body: { identity: process.env.APP_ADMIN_EMAIL, password: process.env.APP_ADMIN_PASSWORD }
})
const superAuth = await api('/api/collections/_superusers/auth-with-password', {
  method: 'POST',
  body: { identity: process.env.PB_SUPER_EMAIL, password: process.env.PB_SUPER_PASSWORD }
})
let token = admin.token
if (admin.record.must_change_password) {
  await api(`/api/collections/users/records/${admin.record.id}`, {
    method: 'PATCH', token: superAuth.token, body: { must_change_password: false }
  })
  token = (await api('/api/collections/users/auth-with-password', {
    method: 'POST',
    body: { identity: process.env.APP_ADMIN_EMAIL, password: process.env.APP_ADMIN_PASSWORD }
  })).token
}

// SOURCE_SCHEME 由第 1 节的方案清单按 rule_status 挑出来（见那里），不在这里写死。
const suffix = Date.now()

// 夹具按合成适配器的规则表挑出来，覆盖四种状态与一个「没有值」的行：
//   pa533 → p→b, a→e, 533        ⇒ EXACT        be533
//   ti21  → t→d, i→u, 21          ⇒ EXACT        du21
//   kn533 → k→g, rime n 一对多    ⇒ AMBIGUOUS    无值（候选 u / ə）
//   ma533 → onset m 没有规则      ⇒ UNSUPPORTED  无值
//   ki533 → 上下文 k+i 腭化成 ʃ   ⇒ EXACT        ʃu533
//   sa533 → 整条例外 E-sa533      ⇒ EXACT        de533
//   pa21  → 整条例外 E-pa21       ⇒ REVIEWED     bu533
//   （空） → 没有可转换的值        ⇒ 跳过
const ROWS = [
  ['甲', 'pa533', 1],
  ['乙', 'ti21', 2],
  ['丙', 'kn533', 3],
  ['丁', 'ma533', 4],
  ['戊', 'ki533', 5],
  ['己', 'sa533', 6],
  ['庚', 'pa21', 7],
  ['辛', '', 8]
]
const EXPECTED = { total: 8, exact: 4, reviewed: 1, ambiguous: 1, unsupported: 1, skipped: 1, failed: 0 }

// 建项目 + 标列角色：#190 的一切都要求「恰好一个记音列」，所以夹具一律照这个形状铺。
async function projectWithReadingColumn(name) {
  const created = await api('/api/fangji/projects', {
    method: 'POST', token, expected: 201, body: { name }
  })
  await api(`/api/fangji/projects/${created.id}/column-roles`, {
    method: 'PUT', token, body: { roles: { 词头: 'headword', 读音: 'reading' } }
  })
  return created
}

// CSV 导入是两段式的（inspect 校验 → commit 落库），套件里用两次，抽成一处。
async function importCSV(projectId, rows, filename) {
  const csv = new FormData()
  csv.set('file', new Blob([`词头,读音,PDF页码\n${rows.map((row) => row.join(',')).join('\n')}\n`]), filename)
  csv.set('inspect_only', 'true')
  const inspect = await api(`/api/fangji/projects/${projectId}/imports/csv`, {
    method: 'POST', token, body: csv, expected: 202
  })
  for (let attempt = 0; attempt < 100; attempt++) {
    const job = await api(`/api/collections/import_jobs/records/${inspect.id}`, { token })
    assert.notEqual(job.status, 'failed', JSON.stringify(job))
    if (job.status === 'validated') break
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  await api(`/api/fangji/imports/${inspect.id}/commit`, { method: 'POST', token, expected: 202 })
  for (let attempt = 0; attempt < 100; attempt++) {
    const job = await api(`/api/collections/import_jobs/records/${inspect.id}`, { token })
    if (job.status === 'completed') break
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return inspect
}

const project = await projectWithReadingColumn(`拼音转换夹具 ${suffix}`)
await importCSV(project.id, ROWS, 'scheme.csv')

async function waitConversion(jobId, statuses = ['completed', 'completed_with_errors', 'failed']) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const job = await api(`/api/collections/conversion_jobs/records/${jobId}`, { token: superAuth.token })
    if (statuses.includes(job.status)) return job
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error('conversion timeout')
}

const listPages = async (projectId = project.id) => (await api(
  `/api/collections/pages/records?perPage=50&sort=page_number&filter=${encodeURIComponent(`project="${projectId}"`)}`,
  { token: superAuth.token })).items

// ---------- 1. 方案清单、规则状态与「没有规则目录」的可诊断状态 ----------
// 目录里有两份文件（见 harness.write_scheme_adapters）：仓库里的夹具原样一份（声明 test），
// 以及只供本次一次性实例使用的可运行副本一份（声明 production）。这里不写死哪一份能跑，
// 而是从清单里按 rule_status 挑——顺带就把清单新增的 rule_status 字段验了。
const adapters = await api('/api/fangji/scheme-adapters', { token })
assert.equal(adapters.notice, '', '配置了规则目录时不应有 notice')
const runnable = adapters.schemes.find((item) => item.rule_status === 'production')
const fixture = adapters.schemes.find((item) => item.rule_status !== 'production')
assert.ok(runnable, `清单里要有一套声明为 production 的方案：${JSON.stringify(adapters.schemes)}`)
assert.ok(fixture, `清单里要有一套声明为 test 的夹具：${JSON.stringify(adapters.schemes)}`)
assert.equal(fixture.source_scheme_id, 'synthetic-source', '夹具的 id 就是仓库文件里那个')
// 规则版本不写死：--verify-rule-change 那一次跑之前，脚手架会把副本换成下一版，
// 这条套件本身不该在换版之后失效。版本的正确性由第 3 节「作业记的就是 adapter 记的」保证。
assert.ok(runnable.rule_version, `方案清单要给出规则版本：${JSON.stringify(runnable)}`)
const SOURCE_SCHEME = runnable.source_scheme_id
const FIXTURE_SCHEME = fixture.source_scheme_id

// ---------- 2. 三种拒绝是三句不同的话：没声明 / 没登记 / 登记了但声明为测试夹具 ----------
await api(`/api/fangji/projects/${project.id}/conversions`, {
  method: 'POST', token, expected: 400, body: {}
})
await api(`/api/fangji/projects/${project.id}/conversions`, {
  method: 'POST', token, expected: 400, body: { source_scheme_id: 'puxian-dictionary' }
})
// 第三条是 #289 新增的闸门。它必须连作业都不建出来：只回一句 400 但库里留了半条作业，
// 会让「闸门拦住了」和「作业跑炸了」在管理端看起来一模一样。
const refused = await api(`/api/fangji/projects/${project.id}/conversions`, {
  method: 'POST', token, expected: 400, body: { source_scheme_id: FIXTURE_SCHEME }
})
assert.match(refused.message, /只能用于测试/, JSON.stringify(refused))
assert.match(refused.message, new RegExp(FIXTURE_SCHEME), '拒绝理由要点名是哪套方案')
const noJobs = await api(
  `/api/collections/conversion_jobs/records?filter=${encodeURIComponent(`project="${project.id}"`)}`,
  { token: superAuth.token })
assert.equal(noJobs.totalItems, 0, `被闸门拒绝的请求不得留下作业记录：${JSON.stringify(noJobs)}`)

// ---------- 3. 正式跑一次：四行汇总与手算一致 ----------
const job = await api(`/api/fangji/projects/${project.id}/conversions`, {
  method: 'POST', token, expected: 202, body: { source_scheme_id: SOURCE_SCHEME }
})
const done = await waitConversion(job.id)
assert.equal(done.status, 'completed', JSON.stringify(done))
assert.equal(done.canonical_scheme, runnable.canonical_scheme_id)
assert.equal(done.rule_version, runnable.rule_version, '作业记下的规则身份就是发起时那一套')
for (const [key, want] of Object.entries(EXPECTED)) {
  const actual = done[`${key}_count`] ?? done[`${key}Count`]
  assert.equal(actual, want, `${key}: 实得 ${actual}，手算 ${want}`)
}
assert.equal(done.exact_count + done.reviewed_count, 5, '自动确定 = EXACT + REVIEWED')

const pages = await listPages()
const byHeadword = Object.fromEntries(pages.map((page) => [JSON.parse(page.ocr_row_json).词头, page]))
assert.equal(byHeadword.甲.canonical_pronunciation, 'be533')
assert.equal(byHeadword.甲.normalization_status, 'EXACT')
assert.equal(byHeadword.甲.normalization_source_column, '读音')
assert.equal(byHeadword.乙.canonical_pronunciation, 'du21')
assert.equal(byHeadword.戊.canonical_pronunciation, 'ʃu533', '上下文规则 k+i 应当腭化成 ʃ')
assert.equal(byHeadword.己.canonical_pronunciation, 'de533', '例外表优先于常规映射')
assert.equal(byHeadword.庚.normalization_status, 'REVIEWED', '例外声明的状态要如实落库')
// 拒绝的两种状态都不能带值——带值的 AMBIGUOUS 下游再也分不出它和确定值。
assert.equal(byHeadword.丙.normalization_status, 'AMBIGUOUS')
assert.equal(byHeadword.丙.canonical_pronunciation, '', 'AMBIGUOUS 不得产出统一写法')
assert.deepEqual(JSON.parse(byHeadword.丙.normalization_candidates_json), ['u', 'ə'])
assert.equal(byHeadword.丁.normalization_status, 'UNSUPPORTED')
assert.equal(byHeadword.丁.canonical_pronunciation, '')
assert.equal(byHeadword.辛.normalization_status, '', '没有值的条目不该被硬造一个结论')
assert.ok(byHeadword.甲.normalization_trace_json.includes('O-p-b'), 'trace 要点名生效的规则')

// ---------- 4. 复核队列：只列需要人看的，且给得出候选 ----------
const queue = await api(`/api/fangji/projects/${project.id}/normalizations`, { token })
assert.equal(queue.totalItems, 1)
assert.equal(queue.items[0].id, byHeadword.丙.id)
assert.deepEqual(queue.items[0].candidates, ['u', 'ə'])
const unsupported = await api(`/api/fangji/projects/${project.id}/normalizations?status=UNSUPPORTED`, { token })
assert.equal(unsupported.totalItems, 1)
await api(`/api/fangji/projects/${project.id}/normalizations?status=NOPE`, { token, expected: 400 })
// perPage 有上界：队列端点不能成为「一次拉全库」的后门。page 也有上界（夹到最后一页），
// 翻过头不返回空页——空页会让界面显示「一共 0 条待复核」，而队列其实还有内容。
const clamped = await api(`/api/fangji/projects/${project.id}/normalizations?perPage=1000&page=99`, { token })
assert.equal(clamped.perPage, 100, `perPage 要被夹到 100：${JSON.stringify(clamped)}`)
assert.equal(clamped.page, 1, '只有一页时 page 要夹回第 1 页')
assert.equal(clamped.totalItems, 1)

// ---------- 4b. 原值快照：转换之后有人动了那一格，结论针对的原值不能跟着变 ----------
// 队列里的「原值」与例外草案里的 source_pronunciation 都要说明「这条结论是针对哪个值下的」。
// 现读校对行的话，那个值会在校对之后被静默换掉——一条已经定过的结论，它针对的对象换了，
// 界面上却看不出来。
//
// 那一格也只能这样改：pages 集合的 updateRule 是 null（只有服务端写），认领守卫又会挡下
// 任何不是「认领」的直接改写（平台管理员也被这条守卫挡着）。所以这里走真实校对流程，
// 按法定人数（默认 2 人）各自独立提交同一个新值：两名校对员都改口之后
// page.proofread_row_json 才跟着变。这就是「有人动了那一格」在真实系统里的样子，
// 不是给测试开的后门。
//
// 另起一个只放一条条目的项目，是为了让「领取」一次就拿到它，不必在别人的队列里
// 领一条放一条地凑到 丙 面前。
const snapshotProject = await projectWithReadingColumn(`原值快照夹具 ${suffix}`)
await importCSV(snapshotProject.id, [['丙', 'kn533', 1]], 'snapshot.csv')
const snapshotRun = await api(`/api/fangji/projects/${snapshotProject.id}/conversions`, {
  method: 'POST', token, expected: 202, body: { source_scheme_id: SOURCE_SCHEME }
})
await waitConversion(snapshotRun.id)

const [snapshotPage] = await listPages(snapshotProject.id)
assert.equal(snapshotPage.normalization_status, 'AMBIGUOUS', '快照夹具本身要先落成「需人工确认」')
for (const index of [1, 2]) {
  const email = `scheme-reader-${index}-${suffix}@example.com`
  const password = 'SchemeTest12345!'
  const reader = await api('/api/collections/users/records', {
    method: 'POST',
    body: { email, password, passwordConfirm: password, name: `校对员${index}-${suffix}`, role: 'user' }
  })
  const readerAuth = await api('/api/collections/users/auth-with-password', {
    method: 'POST', body: { identity: email, password }
  })
  await api(`/api/fangji/projects/${snapshotProject.id}/members/${reader.id}`, {
    method: 'PUT', token, body: { role: 'proofreader' }
  })
  const claimed = await api(`/api/fangji/projects/${snapshotProject.id}/claim`, {
    method: 'POST', token: readerAuth.token
  })
  assert.equal(claimed.id, snapshotPage.id, '这个项目只有一条条目，领取拿到的必须是它')
  await api(`/api/fangji/pages/${claimed.id}/submit`, {
    method: 'POST', token: readerAuth.token,
    body: {
      // 字段要与识别原文逐字一致（PDF页码 那一列落成 page/pdf_page，不进正文行）。
      rowJson: JSON.stringify({ 词头: '丙', 读音: 'tu533' }),
      leaseToken: claimed.leaseToken
    }
  })
}
// 反空转：先证明那一格真的被改掉了。少了这一步，「原值仍是 kn533」在「校对其实什么也没做」
// 的时候也会绿，而那时这条断言什么都没证明。
const editedPage = await api(`/api/collections/pages/records/${snapshotPage.id}`, { token: superAuth.token })
assert.equal(editedPage.status, 'approved', '两名校对员改口一致后条目才定稿，那一格才落到页面上')
assert.equal(JSON.parse(editedPage.proofread_row_json).读音, 'tu533',
  `校对流程必须真的改掉那一格，否则下面那条断言是空的：${editedPage.proofread_row_json}`)
assert.equal(editedPage.ocr_row_json, snapshotPage.ocr_row_json, '识别原文不该被动')
const snapshotQueue = await api(`/api/fangji/projects/${snapshotProject.id}/normalizations`, { token })
assert.equal(snapshotQueue.totalItems, 1)
assert.equal(snapshotQueue.items[0].source_pronunciation, 'kn533',
  `队列里的原值必须是转换那一刻的值，不是现在的校对值：${JSON.stringify(snapshotQueue.items[0])}`)
assert.equal(snapshotQueue.items[0].normalization_status, 'AMBIGUOUS', '校对不改机器给出的状态')

// ---------- 5. 人工结论：必须给值与依据 ----------
// 第 1 道闸：只有机器判不出来的条目才收人工结论。三种「不该出现在这里」的条目各给一句话，
// 且都必须原样留着不改——一个 400 把行写坏比不收更糟。
const exactRow = await api(`/api/fangji/pages/${byHeadword.甲.id}/normalization`, {
  method: 'POST', token, expected: 400, body: { canonical_pronunciation: 'be533', basis: '我觉得对' }
})
assert.match(exactRow.message, /机器已经判定了/, JSON.stringify(exactRow))
const reviewedRow = await api(`/api/fangji/pages/${byHeadword.庚.id}/normalization`, {
  method: 'POST', token, expected: 400, body: { canonical_pronunciation: 'bu533', basis: '我觉得对' }
})
assert.match(reviewedRow.message, /已经有人给过结论/, JSON.stringify(reviewedRow))
const neverConverted = await api(`/api/fangji/pages/${byHeadword.辛.id}/normalization`, {
  method: 'POST', token, expected: 400, body: { canonical_pronunciation: 'be533', basis: '我觉得对' }
})
assert.match(neverConverted.message, /还没有跑过转换/, JSON.stringify(neverConverted))

await api(`/api/fangji/pages/${byHeadword.丙.id}/normalization`, {
  method: 'POST', token, expected: 400, body: { canonical_pronunciation: 'gu533' }
})
await api(`/api/fangji/pages/${byHeadword.丙.id}/normalization`, {
  method: 'POST', token, expected: 400, body: { basis: '看过了' }
})
// 第 3 道闸：写法必须是目标方案拼得出来的音节。adapter 自带目标侧清单（韵母 e/u/ə，调值 533/21/4），
// 所以「拼不出来」与「超长」是两句不同的话。编号沿用 decideNormalization 里那三个注释，
// 中间的「第 2 道闸」（规则版本绑定）的取证不在这一段——整套套件只有 --verify-rule-change
// 那一刻版本是对不上的，见那边。
const notSpellable = await api(`/api/fangji/pages/${byHeadword.丙.id}/normalization`, {
  method: 'POST', token, expected: 400, body: { canonical_pronunciation: 'za533', basis: '我觉得对' }
})
assert.match(notSpellable.message, /不是「synthetic-canonical」能拼出的音节/, JSON.stringify(notSpellable))
await api(`/api/fangji/pages/${byHeadword.丙.id}/normalization`, {
  method: 'POST', token, expected: 400,
  body: { canonical_pronunciation: 'b'.repeat(201), basis: '我觉得对' }
})
const stillUndecided = (await listPages()).find((page) => page.id === byHeadword.丙.id)
assert.equal(stillUndecided.normalization_status, 'AMBIGUOUS', '被拒绝的结论不得改动这一行')
assert.equal(stillUndecided.normalization_basis, '')

const decided = await api(`/api/fangji/pages/${byHeadword.丙.id}/normalization`, {
  method: 'POST', token,
  body: { canonical_pronunciation: 'gu533', basis: '对照原书凡例，n 在 k 后作 u' }
})
assert.equal(decided.normalization_status, 'REVIEWED')
assert.equal(decided.canonical_pronunciation, 'gu533')
assert.equal(decided.normalization_basis, '对照原书凡例，n 在 k 后作 u')
assert.equal(decided.normalization_reviewed_by, admin.record.id)
assert.ok(decided.normalization_reviewed_at, '人工结论必须记时间')
// 三道路闸都过了之后写回的值：人工结论也要记下「在哪个规则版本下判的」，
// 否则升版时找不出该重看的结论。
assert.equal(decided.normalization_rule_version, runnable.rule_version)
// 结论针对的原值仍然是转换那一刻的那个：上面的改动没把它带走。
assert.equal(decided.source_pronunciation, 'kn533')
assert.equal((await api(`/api/fangji/projects/${project.id}/normalizations`, { token })).totalItems, 0,
  '复核过的条目不该再留在队列里')

// ---------- 6. 重跑不得回退人工结论 ----------
const again = await api(`/api/fangji/projects/${project.id}/conversions`, {
  method: 'POST', token, expected: 202, body: { source_scheme_id: SOURCE_SCHEME }
})
const second = await waitConversion(again.id)
assert.equal(second.status, 'completed')
const afterRerun = (await listPages()).find((page) => page.id === byHeadword.丙.id)
assert.equal(afterRerun.normalization_status, 'REVIEWED', '重跑不得把人工结论推回机器判断')
assert.equal(afterRerun.canonical_pronunciation, 'gu533')
assert.equal(afterRerun.normalization_basis, '对照原书凡例，n 在 k 后作 u')
// 重跑时 丙 已经有人复核过，它属于「跳过」而不是「被重新判定」；
// 例外表给的 庚 仍然算「已复核」。五个计数互不重叠，所以这里能逐项对账。
assert.equal(second.reviewed_count, 1, '例外表给的结论仍算「已复核」')
assert.equal(second.skipped_count, 2, '丙 已被人工复核、辛 没有值，两者都不该再被转换')
assert.equal(second.ambiguous_count, 0, '丙 已有人工结论，重跑时不再落回「需人工确认」')

// ---------- 7. 结论回流：只产草案，不改规则文件 ----------
// source_scheme_id 是必填的：草案要回流到哪一套规则，只有调用方说得清，
// 从这个项目的条目里推不出来（同一本书可能先按一套方案录、后来改按另一套录）。
await api(`/api/fangji/projects/${project.id}/normalization-exceptions`, { token, expected: 400 })
await api(`/api/fangji/projects/${project.id}/normalization-exceptions?source_scheme_id=nope`, {
  token, expected: 400
})
const drafts = await api(
  `/api/fangji/projects/${project.id}/normalization-exceptions?source_scheme_id=${SOURCE_SCHEME}`, { token })
const draft = drafts.exceptions.find((item) => item.canonical_pronunciation === 'gu533')
assert.ok(draft, JSON.stringify(drafts.exceptions))
assert.equal(draft.source_pronunciation, 'kn533')
assert.equal(draft.status, 'REVIEWED')
assert.equal(draft.basis, '对照原书凡例，n 在 k 后作 u')
assert.match(drafts.note, /不会自动写入任何规则文件/)
assert.equal(drafts.source_scheme_id, SOURCE_SCHEME)

// ---------- 8. 断点续跑：把作业停在半程，重启后接着跑而不是从头再数一遍 ----------
if (process.argv.includes('--prepare-resume')) {
  const handoff = process.env.SCHEME_CONVERSION_HANDOFF
  assert.ok(handoff, '--prepare-resume needs SCHEME_CONVERSION_HANDOFF')
  // 停在「前三条处理完」的位置：cursor 指向第 3 条的 page_number，计数与之配套。
  // 重启后必须从这里续——从头再跑会让四行汇总翻倍，那正是这条验收要防的。
  const third = (await listPages()).find((page) => JSON.parse(page.ocr_row_json).词头 === '丙')
  await api(`/api/collections/conversion_jobs/records/${job.id}`, {
    method: 'PATCH', token: superAuth.token,
    body: {
      status: 'processing', cursor: third.page_number,
      total_count: 3, exact_count: 2, reviewed_count: 0,
      ambiguous_count: 1, unsupported_count: 0, skipped_count: 0, failed_count: 0
    }
  })
  const parked = await api(`/api/collections/conversion_jobs/records/${job.id}`, { token: superAuth.token })
  assert.equal(parked.status, 'processing')
  assert.equal(parked.cursor, third.page_number)
  const { writeFileSync } = await import('node:fs')
  writeFileSync(handoff, JSON.stringify({ jobId: job.id, projectId: project.id }))
  console.log(`PREPARED: conversion job ${job.id} parked mid-way for the restart phase`)
} else if (process.argv.includes('--verify-resume')) {
  const handoff = JSON.parse(readFileSync(process.env.SCHEME_CONVERSION_HANDOFF, 'utf8'))
  const resumed = await waitConversion(handoff.jobId)
  assert.equal(resumed.status, 'completed', '恢复后必须落到确定态，不能留在 processing')
  // 续跑的 oracle 是「不翻倍」而不是某一组固定数字：断点前的计数是持久化的，
  // 续跑只处理 cursor 之后的条目，所以 total 应当仍是条目总数 8。
  // 若续跑无视 cursor 从头再来，total 会变成 3 + 8 = 11 —— 这正是这条验收要防的。
  assert.equal(resumed.total_count, 8, `续跑不得重复计数：${JSON.stringify(resumed)}`)
  assert.equal(resumed.exact_count, 4)
  assert.equal(resumed.unsupported_count, 1)
  assert.equal(resumed.ambiguous_count, 1)
  assert.equal(resumed.failed_count, 0)
  const spread = resumed.exact_count + resumed.reviewed_count + resumed.ambiguous_count
    + resumed.unsupported_count + resumed.skipped_count
  assert.equal(spread, resumed.total_count, `五个计数之和必须等于 total，差额说明有没归类的分支：${JSON.stringify(resumed)}`)
  // cursor 越过的那条人工结论必须原样还在（续跑不该回头把它推回机器判断）。
  const humanDecided = (await api(
    `/api/collections/pages/records?perPage=50&filter=${encodeURIComponent(`project="${handoff.projectId}" && normalization_status="REVIEWED"`)}`,
    { token: superAuth.token })).items.filter((page) => page.normalization_basis !== '')
  assert.equal(humanDecided.length, 1, JSON.stringify(humanDecided))
  assert.equal(humanDecided[0].canonical_pronunciation, 'gu533')
  // 为下一阶段铺前置：下一次启动之前脚手架会把规则文件换成下一版，所以这里先停一个
  // 「记着当前版本、还没开始处理」的作业。cursor 与计数全部归零，好让下一阶段能断言
  // 「拦在第一条之前」——只断言状态是 failed 的话，一个处理到一半才失败的作业也会通过。
  const { writeFileSync } = await import('node:fs')
  await api(`/api/collections/conversion_jobs/records/${again.id}`, {
    method: 'PATCH', token: superAuth.token,
    body: {
      status: 'processing', cursor: 0, total_count: 0, exact_count: 0, reviewed_count: 0,
      ambiguous_count: 0, unsupported_count: 0, skipped_count: 0, failed_count: 0
    }
  })
  writeFileSync(process.env.SCHEME_RULE_CHANGE_HANDOFF,
    JSON.stringify({ jobId: again.id, projectId: project.id }))
  console.log(`PREPARED: conversion job ${again.id} parked across a rule upgrade`)
  console.log('PASS: conversion job resumed from its cursor without double counting')
} else if (process.argv.includes('--verify-rule-change')) {
  // 作业停在半程、规则文件换版、重启续跑。续跑会把一半条目落在旧规则下、一半落在新规则下，
  // 而汇总只有一个数——比整批重跑更难对账，所以这一条必须是一个响亮的失败而不是静默续跑。
  const handoff = JSON.parse(readFileSync(process.env.SCHEME_RULE_CHANGE_HANDOFF, 'utf8'))
  const drifted = await waitConversion(handoff.jobId, ['failed'])
  assert.equal(drifted.status, 'failed', `换版之后不得续跑：${JSON.stringify(drifted)}`)
  assert.equal(drifted.error_code, 'CONVERSION_RULE_VERSION_CHANGED', JSON.stringify(drifted))
  assert.match(drifted.error_message, /规则已换版/)
  assert.equal(drifted.cursor, 0, '换版要在处理第一条之前拦下，不能留下半截进度')
  for (const key of ['total_count', 'exact_count', 'reviewed_count', 'ambiguous_count',
    'unsupported_count', 'skipped_count', 'failed_count']) {
    assert.equal(drifted[key], 0, `${key} 不该有值：被拦下的作业没有处理过任何条目`)
  }
  console.log('PASS: a mid-job rule upgrade stops the resume instead of re-counting under two rule sets')

  // 人工复核这一侧的同一件事：条目上还留着旧版规则跑出来的 status / trace / candidates，
  // 而目录里已经是新版。整套套件只有这一刻版本是对不上的，所以这条断言只能放在这里。
  // 用交接项目里那批旧条目，不能用本次运行新建的项目——它是在新版规则下转换的，版本本来就一致。
  const stalePages = (await api(
    `/api/collections/pages/records?perPage=50&filter=${encodeURIComponent(`project="${handoff.projectId}" && normalization_status="UNSUPPORTED"`)}`,
    { token: superAuth.token })).items
  assert.ok(stalePages.length > 0, '换版之后要留下一条旧规则跑出来的待复核条目，这条断言才有对象')
  const staleRow = await api(`/api/fangji/pages/${stalePages[0].id}/normalization`, {
    method: 'POST', token, expected: 400,
    body: { canonical_pronunciation: 'de533', basis: '我觉得对' }
  })
  assert.match(staleRow.message, /规则版本/, JSON.stringify(staleRow))
  assert.match(staleRow.message, /重跑一次转换/, `要给出一条可走的路，不能只说「不允许」：${JSON.stringify(staleRow)}`)
  assert.match(staleRow.message, /synthetic-v1/, '要点名这一条是哪个版本跑出来的')
  const untouched = (await api(`/api/collections/pages/records/${stalePages[0].id}`, { token: superAuth.token }))
  assert.equal(untouched.normalization_status, 'UNSUPPORTED', '被拒绝的结论不得改动这一行')
  assert.equal(untouched.normalization_reviewed_by, '')
  console.log('PASS: an entry produced under the previous rule version cannot collect a human conclusion')
} else {
  console.log('PASS: scheme conversion job, four-line summary, review queue and exception drafts')
}
