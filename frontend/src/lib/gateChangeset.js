// #228 门控变更集在前端侧的读取与呈现。
//
// 这里**不复算放行判据**：门槛（θ / n_min）的唯一出处是后端 `pb_hooks/lib/gate_release.js`，
// 打分器也从那里取常数。前端再算一遍就会漂，而漂了的症状是"界面说可以放行、
// 后端把这条拒了"，运维只能靠人肉对齐两边。前端只做三件事：读文件、原样提交、如实展示被拒原因。

const CHANGESET_FIELDS = ['changeset', 'entries']

export const GATE_LABELS = {
  strong: 'strong（高亮放行）',
  warn: 'warn（次要标记）',
  off: 'off（不进校对端）'
}

export const ACTION_LABELS = {
  applied: '已写入',
  updated: '已更新',
  unchanged: '无需改动',
  refused: '被拒绝',
  locked: '保持人工降档'
}

// 通道的三种说法。`unknown` 不并进前两类：表上没登记的身份，
// 连"能不能拿到档位"都不知道，替它下结论就是 #254 反对的那种沉默。
export const CHANNEL_LABELS = {
  scored: '可打分',
  unscored: '无打分通道',
  unknown: '未登记通道'
}

export function channelLabel(channel) {
  return CHANNEL_LABELS[channel] ?? CHANNEL_LABELS.unknown
}

export function channelBadgeClass(channel) {
  if (channel === 'unscored') return 'badge badge-warn'
  if (channel === 'unknown') return 'badge badge-neutral'
  return 'badge badge-ok'
}

export function gateLabel(gate) {
  return GATE_LABELS[gate] || gate || '未登记'
}

// 只复用 style.css 里已有的 badge-* 修饰类（approved 绿 / pending 黄 / 无修饰中性），
// 不为这张表新造配色：新增样式类会绕开 #161 对界面一致性的约束。
// 未知档位回显原值并保持中性样式，后端加档时前端不至于渲染成空白。
export function gateBadgeClass(gate) {
  if (gate === 'strong') return 'badge badge-approved'
  if (gate === 'warn') return 'badge badge-pending'
  return 'badge'
}

// n=0 时 precision_hat 允许是 null（门槛文件 §3：没有命中样本就没有精度可谈）。
// 显示成 0.0000 会被读成"实测精度为零"，而那是两个不同的结论、两种不同的处置。
// 注意 `Number(null) === 0`：不先挡空值就会把 n/a 悄悄渲染成 0.0000。
export function precisionText(item) {
  const raw = item?.precision_hat
  if (raw === null || raw === undefined || raw === '') return 'n/a'
  const value = Number(raw)
  if (!Number.isFinite(value)) return 'n/a'
  return value.toFixed(4)
}

export function evidenceText(item) {
  const samples = Number(item?.sample_n)
  const n = Number.isFinite(samples) ? samples : 0
  return `n=${n} · p̂=${precisionText(item)}`
}

/**
 * 把 `scripts/assist/gate_changeset.mjs` 产出的 JSON 读成请求体。
 *
 * 只取 `changeset` 与 `entries` 两个字段：脚本产物还带着 `criteria`、`excluded`、
 * `criteria_source` 这些给人评审用的旁注，把它们原样 POST 进去会让后端去校验
 * 前端根本不关心的结构，报错信息也就跟着跑到无关字段上。
 */
export function readChangeset(text) {
  const raw = String(text ?? '').trim()
  if (!raw) return { ok: false, problem: '变更集内容是空的' }
  let parsed = null
  try {
    parsed = JSON.parse(raw)
  } catch (cause) {
    return { ok: false, problem: `不是合法 JSON：${cause.message}` }
  }
  if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') {
    return { ok: false, problem: '变更集必须是一个 JSON 对象' }
  }
  const entries = parsed.entries
  if (!Array.isArray(entries) || !entries.length) {
    return { ok: false, problem: '变更集里没有 entries 条目；空变更集请改用撤销入口逐条关档' }
  }
  const missing = CHANGESET_FIELDS.filter((field) => field !== 'entries')
    .filter((field) => !String(parsed[field] ?? '').trim())
  if (missing.length) return { ok: false, problem: `变更集缺少 ${missing.join('、')}` }
  const noIdentity = entries.filter((entry) => !entry
    || !['producer', 'producer_version', 'kind', 'message_key'].every((field) => String(entry[field] ?? '').trim()))
  if (noIdentity.length) {
    return {
      ok: false,
      problem: `有 ${noIdentity.length} 条缺少完整规则身份四元组（producer / producer_version / kind / message_key）`
    }
  }
  return {
    ok: true,
    payload: { changeset: String(parsed.changeset).trim(), entries },
    preview: previewChangeset(parsed.changeset, entries)
  }
}

// 提交前先把"会改成什么档"摊开给人看一眼：变更集一旦被误用（比如拿旧日期的文件），
// 唯一的发现机会就是这次确认，而不是等校对员抱怨标记突然变多。
export function previewChangeset(changesetId, entries) {
  const byGate = new Map()
  for (const entry of entries) {
    byGate.set(entry.gate, (byGate.get(entry.gate) || 0) + 1)
  }
  return {
    changeset: String(changesetId).trim(),
    total: entries.length,
    by_gate: Object.fromEntries(byGate),
    approvers: [...new Set(entries.map((entry) => String(entry.approved_by ?? '').trim()).filter(Boolean))]
  }
}

export function summariseApply(result) {
  const counts = ['applied', 'unchanged', 'refused', 'locked']
    .map((key) => `${ACTION_LABELS[key] || key} ${Number(result?.[key]) || 0}`)
    .join(' · ')
  const refused = (result?.entries || []).filter((entry) => entry.action === 'refused')
  const locked = (result?.entries || []).filter((entry) => entry.action === 'locked')
  return {
    counts,
    changeset: result?.changeset || '',
    refused,
    locked,
    // 一次应用里"没有任何东西被改变"必须显式说，否则空变更集看起来像成功放行。
    inert: (Number(result?.applied) || 0) === 0
  }
}
