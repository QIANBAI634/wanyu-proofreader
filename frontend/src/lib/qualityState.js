// 相对路径而不是 @/：backend 侧的 node:test 直接跑这些 lib 模块，它不认识 Vite 的别名。
import { QUALITY_STATE, QUALITY_STATE_LABELS, QUALITY_STATES } from '../constants/qualityState.js'

// #172 质量状态在前端侧的呈现与缺省归一。
//
// 这里**不复算状态转移规则**：能不能改、要不要写依据由后端 backend/quality_state.go
// 判定，前端只做两件事——把空值按 v0 语义显示成「待定」，以及在提交前把明显不成立的
// 请求挡下来（按钮禁用），真正的裁决仍以服务端返回为准。前端再实现一遍状态机就会漂，
// 而漂了的症状是「界面允许、后端 400」，与 #228 在前端复算放行判据是同一个坑。

// 空串在 v0 里等同 candidate（迁移回填了存量、创建时由 Go 钩子归一，但手工 SQL 或
// 属性规则落地前检出的库仍可能带空值）。取值表外的值原样返回：把陌生值渲染成
// 「待定」会让一次迁移与代码的漂移在界面上彻底消失。
export function normalizeQualityState(value) {
  const text = String(value ?? '').trim()
  if (!text) return QUALITY_STATE.CANDIDATE
  return text
}

export function qualityStateLabel(value) {
  const state = normalizeQualityState(value)
  return QUALITY_STATE_LABELS[state] || state
}

// 只复用 style.css 里已有的 badge-* 修饰类（待定用 pending 黄、已确认用 approved 绿、
// 暂缓外发用 rejected 红），不为这三个状态新造配色。
export function qualityStateBadgeClass(value) {
  const state = normalizeQualityState(value)
  if (state === QUALITY_STATE.VALIDATED) return 'badge badge-approved'
  if (state === QUALITY_STATE.WITHHELD) return 'badge badge-rejected'
  if (state === QUALITY_STATE.CANDIDATE) return 'badge badge-pending'
  return 'badge'
}

// 会改变「这条能不能外发」的目标必须带依据。这里只是提前禁用按钮，规则本身以后端为准。
export function qualityStateNeedsBasis(target) {
  return normalizeQualityState(target) !== QUALITY_STATE.CANDIDATE
}

// 汇总投影：三桶按固定顺序铺开，服务端多出来的键（迁移与代码漂移的证据）追加在后面，
// 不并进 candidate、也不丢弃——静默并桶比多一个陌生键更难查。
export function qualityStateSummaryRows(summary) {
  const byState = summary?.byState || {}
  const rows = QUALITY_STATES.map((state) => ({
    state,
    label: QUALITY_STATE_LABELS[state],
    count: Number(byState[state] || 0)
  }))
  for (const [state, count] of Object.entries(byState)) {
    if (QUALITY_STATES.includes(state)) continue
    rows.push({ state, label: state, count: Number(count || 0) })
  }
  return rows
}
