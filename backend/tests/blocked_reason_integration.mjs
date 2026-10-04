import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

// #240：`pages.blocked_reason` 的人工写入口。权限口径由维护者定为 (B) 平台管理员。
//
// 这一支测的是"接口存在之后，那三条今天不可达的 tier 判据是不是真的可达了"——
// 所以核心不是能不能写，而是**写完 tier 会不会跟着动、清掉会不会回落**，
// 以及库里到底存的是"没人说过"（空串）还是"看过但认不出"（unknown）。
const base = process.env.PB_URL || 'http://127.0.0.1:18091'

async function api(path, { method = 'GET', token = '', body, status = 200 } = {}) {
  const response = await fetch(base + path, {
    method,
    headers: { Authorization: token, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined
  })
  const raw = await response.text()
  let data = null
  if (raw) { try { data = JSON.parse(raw) } catch { data = raw } }
  assert.equal(response.status, status, `${method} ${path} -> ${response.status} ${raw}`)
  return data
}

const platform = await api('/api/collections/users/auth-with-password', {
  method: 'POST', body: { identity: process.env.APP_ADMIN_EMAIL, password: process.env.APP_ADMIN_PASSWORD }
})
const superAuth = await api('/api/collections/_superusers/auth-with-password', {
  method: 'POST', body: { identity: process.env.PB_SUPER_EMAIL, password: process.env.PB_SUPER_PASSWORD }
})
const suffix = `${Date.now()}`
const password = 'BlockedReason123!'

async function user(label, role = 'user') {
  const email = `${label}-${suffix}@example.com`
  const record = await api('/api/collections/users/records', {
    method: 'POST', token: superAuth.token,
    body: { email, password, passwordConfirm: password, name: label, role }
  })
  const auth = await api('/api/collections/users/auth-with-password', {
    method: 'POST', body: { identity: email, password }
  })
  return { id: record.id, token: auth.token }
}

const project = await api('/api/fangji/projects', {
  method: 'POST', token: platform.token, status: 201, body: { name: `阻塞结论 ${suffix}` }
})
const manager = await user('blocked-manager')
const proofreader = await user('blocked-reader')
const outsider = await user('blocked-outsider')
await api(`/api/fangji/projects/${project.id}/members/${manager.id}`, { method: 'PUT', token: platform.token, body: { role: 'manager' } })
await api(`/api/fangji/projects/${project.id}/members/${proofreader.id}`, { method: 'PUT', token: platform.token, body: { role: 'proofreader' } })

const page = await api('/api/collections/pages/records', {
  method: 'POST', token: superAuth.token,
  body: {
    project: project.id, page_number: 1, pdf_page: 1,
    ocr_row_json: JSON.stringify({ 词条: '人' }), ocr_text: '人',
    proofread_round: 1, mismatch_count: 0, status: 'pending'
  }
})
const route = `/api/fangji/pages/${page.id}/blocked-reason`
const readPage = async () => api(`/api/collections/pages/records/${page.id}`, { token: superAuth.token })

// 先算一次，再取"原层级"。新导入的条目 `difficulty_tier` 是空串（从没算过），
// 而清除路径会在接口内部刷一次档，拿空串当基线就会得出"清掉后没回落"的假失败——
// 真正该相等的是"算过但无信号"的 unknown。
await api(`/api/fangji/projects/${project.id}/findings/recompute`, { method: 'POST', token: platform.token })
const before = await readPage()
assert.equal(before.blocked_reason ?? '', '', `空串起步：没写过就该是空，实得 ${JSON.stringify(before.blocked_reason)}`)
const tierBefore = before.difficulty_tier

// ---------- 写：档位必须在同一次请求里跟着动（#240 验收第 4 条选的那个选项） ----------
const written = await api(route, {
  method: 'PUT', token: platform.token,
  body: { reason: 'rights_gate', basis: '授权邮件 2026-10-03：本条目未获授权' }
})
assert.equal(written.difficulty_tier, 'C', JSON.stringify(written))
assert.ok(written.difficulty_basis.includes('rights_gate_blocked'),
  `C 档判据没因人工写值而命中：${JSON.stringify(written.difficulty_basis)}`)
const afterWrite = await readPage()
assert.equal(afterWrite.blocked_reason, 'rights_gate')
assert.equal(afterWrite.blocked_reason_by, (await api('/api/collections/users/auth-with-password', {
  method: 'POST', body: { identity: process.env.APP_ADMIN_EMAIL, password: process.env.APP_ADMIN_PASSWORD }
})).record.id, 'who 没落库')
assert.ok(afterWrite.blocked_reason_at, 'when 没落库')
assert.match(afterWrite.blocked_reason_note, /未获授权/, 'basis 没落库')

// ---------- 读回 ----------
const read = await api(route, { token: platform.token })
assert.equal(read.blocked_reason, 'rights_gate')
assert.equal(read.blocked_reason_note, afterWrite.blocked_reason_note)
// who 必须给得出名字：界面那行"登记者"只有 id 的话，一张截图证明不了是谁登记的。
assert.equal(read.blocked_reason_by_name, platform.record.name, JSON.stringify(read))
assert.equal(written.blocked_reason_by_name, platform.record.name, JSON.stringify(written))

// ---------- 值域与必填：白名单，绝不把输入拼进任何过滤表达式 ----------
await api(route, { method: 'PUT', token: platform.token, body: { reason: 'not_a_bucket', basis: 'x' }, status: 400 })
await api(route, { method: 'PUT', token: platform.token, body: { reason: 'rights_gate' }, status: 400 })
await api(route, { method: 'PUT', token: platform.token, body: { reason: 'rights_gate', basis: '   ' }, status: 400 })
// 带引号的输入必须被白名单挡在拼串之前：这一条不是"顺手测一下"，
// 而是历史上同类过滤表达式真出过注入面（见 `lib/findings.js` 里 enumParam 的注释）。
const injection = 'rights_gate" || project != "'
await api(route, { method: 'PUT', token: platform.token, body: { reason: injection, basis: '注入应当被白名单挡下' }, status: 400 })

// ---------- 权限：三类身份逐个测（owner ≠ 有 manager 成员行，别漏） ----------
await api(route, { method: 'PUT', token: proofreader.token, body: { reason: 'rights_gate', basis: 'x' }, status: 403 })
await api(route, { method: 'PUT', token: manager.token, body: { reason: 'rights_gate', basis: 'x' }, status: 403 })
await api(route, { method: 'PUT', token: outsider.token, body: { reason: 'rights_gate', basis: 'x' }, status: 403 })
await api(route, { token: manager.token, status: 403 })
await api(route, { method: 'DELETE', token: manager.token, status: 403 })

// ---------- 机器不得 stamp：全量重算之后人写的值必须原样在 ----------
await api(`/api/fangji/projects/${project.id}/findings/recompute`, { method: 'POST', token: platform.token })
const afterRecompute = await readPage()
assert.equal(afterRecompute.blocked_reason, 'rights_gate', '重算把人工结论洗掉了')
assert.equal(afterRecompute.blocked_reason_note, afterWrite.blocked_reason_note)

// ---------- 清除：回到"没人说过"= 空串，而不是 unknown ----------
const cleared = await api(route, { method: 'DELETE', token: platform.token })
assert.equal(cleared.blocked_reason, '')
assert.equal(cleared.difficulty_tier, tierBefore, `清掉后没回落到原层级：${JSON.stringify(cleared)}`)
assert.equal(cleared.difficulty_basis.includes('rights_gate_blocked'), false)
const afterClear = await readPage()
for (const field of ['blocked_reason', 'blocked_reason_by', 'blocked_reason_at', 'blocked_reason_note']) {
  assert.equal(afterClear[field] ?? '', '', `${field} 清除后不是空串：${JSON.stringify(afterClear[field])}`)
}
// 读回口也不能留着署名：界面那行"登记者"会指向一个已经没有结论的人。
const readAfterClear = await api(route, { token: platform.token })
assert.equal(readAfterClear.blocked_reason, '')
assert.equal(readAfterClear.blocked_reason_by, '')
assert.equal(readAfterClear.blocked_reason_by_name ?? '', '', JSON.stringify(readAfterClear))
assert.equal(readAfterClear.blocked_reason_note ?? '', '')

// unknown 是一个**结论**，与"没人说过"必须能在库里区分开
await api(route, { method: 'PUT', token: platform.token, body: { reason: 'unknown', basis: '看过，认不出是什么卡住了' } })
assert.equal((await readPage()).blocked_reason, 'unknown')
await api(route, { method: 'DELETE', token: platform.token })
assert.equal((await readPage()).blocked_reason, '')

// ---------- 四条判据逐条可达 ----------
// issue 标题说的是"4 条 tier 判据读不到东西"，所以只钉 `rights_gate` 一条不算交付完：
// 每个桶各自落在不同档位（A/B/C），漏掉任何一个的症状都是"这个桶登记了但分层没反应"，
// 而界面上那句"登记与撤销都会立刻重算层级"就成了假话。
// 期望档位从 `assist_difficulty.js` 的 TIER_RULES 读，不在测试里另抄一份数字：
// 抄一份的话规则改了档位，测试会跟着红在"我以为它是 B"而不是"库里确实是 B"。
const difficultySource = await readFile(
  new URL('../pb_hooks/lib/assist_difficulty.js', import.meta.url), 'utf8')
const expectedTier = (ruleId) => {
  const match = difficultySource.match(new RegExp(`id: "${ruleId}", tier: "(\\w)"`))
  assert.ok(match, `TIER_RULES 里找不到 ${ruleId}：这条防漏测试已经失效`)
  return match[1]
}
for (const [bucket, ruleId] of [
  ['glyph_table', 'glyph_table_blocked'],
  ['scanned_read', 'scanned_read_blocked'],
  ['column_merge', 'column_merge_blocked'],
  ['rights_gate', 'rights_gate_blocked']
]) {
  const tier = expectedTier(ruleId)
  const result = await api(route, {
    method: 'PUT', token: platform.token, body: { reason: bucket, basis: `逐桶可达性验证：${bucket}` }
  })
  assert.equal(result.blocked_reason, bucket)
  assert.equal(result.difficulty_tier, tier, `${bucket} 应把档位推到 ${tier}，实得 ${JSON.stringify(result)}`)
  assert.ok(result.difficulty_basis.includes(ruleId), `${ruleId} 没因人工写值而命中：${JSON.stringify(result.difficulty_basis)}`)
  // 库里存的必须就是人写的那个桶：机器路径只读不 stamp，写后被洗掉是本 issue 立项的根因
  assert.equal((await readPage()).blocked_reason, bucket, `${bucket} 写进去又被人读成别的值`)
  await api(route, { method: 'DELETE', token: platform.token })
}
// 四个桶都过完之后必须回到"没人说过"，否则后面删项目前的状态是脏的
assert.equal((await readPage()).blocked_reason, '')
assert.equal((await readPage()).difficulty_tier, tierBefore, `逐桶验证之后没回落到基线档位`)

await api(`/api/collections/projects/records/${project.id}`, { method: 'DELETE', token: superAuth.token, status: 204 })
for (const id of [manager.id, proofreader.id, outsider.id]) {
  await api(`/api/collections/users/records/${id}`, { method: 'DELETE', token: superAuth.token, status: 204 })
}
console.log('PASS: 阻塞结论只有平台管理员能写、值域白名单、basis 必填、写完即刷档、重算不洗、清除回到空串且层级回落、四个桶各自把档位推到 TIER_RULES 写的值')
