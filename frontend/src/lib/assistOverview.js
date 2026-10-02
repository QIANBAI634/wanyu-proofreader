// #234 管理端「机器疑点」区块的纯逻辑。
//
// 这块 UI 的意义是把"没有入口就永远不会算"的批处理侧交到管理员手上，
// 所以这里最要紧的不是排版，而是**不许把"没跑过"说成"没问题"**：
// 一份空列表既可能是"这个项目从没跑过项目级重算"，也可能是"跑过且真的干净"，
// 两者对管理员的动作完全不同（前者该点按钮，后者该去别处找问题）。
import { hintKindLabel } from './fieldHints.js'

export const SEVERITY_LABELS = { strong: '需立刻看', warn: '建议看', info: '仅统计' }

export function severityCount(items, severity) {
  return (items ?? []).filter((item) => item?.severity === severity).length
}

// 按 kind 汇总，顺序按数量降序、同数量按 kind 名，保证同一份数据渲染顺序稳定。
export function kindBreakdown(items) {
  const counts = new Map()
  for (const item of items ?? []) {
    const kind = String(item?.kind ?? '')
    if (!kind) continue
    counts.set(kind, (counts.get(kind) ?? 0) + 1)
  }
  return [...counts.entries()]
    .map(([kind, count]) => ({ kind, label: hintKindLabel(kind), count }))
    .sort((a, b) => (b.count - a.count) || (a.kind < b.kind ? -1 : 1))
}

// `off` 档的疑点数量：门槛文档 §2 的"仍计算、仍写库、只在管理端统计"就是这一格。
// 没有它，管理员看到一堆疑点却不知道哪些今天不会下发给校对员，只能靠猜。
export function gatedOffCount(items) {
  return (items ?? []).filter((item) => item?.gate === 'off').length
}

export function truncatedNotice(listResponse) {
  const bits = []
  if (listResponse?.gate_rows_truncated) bits.push('门控登记表读取被截断，超出部分的规则一律按 off 处理')
  if (listResponse?.hasMore) bits.push('疑点列表还有下一页')
  return bits.join('；')
}

// 空列表的三种来源必须能被区分出来。everRun 来自"这次会话里点过重算"或后端摘要，
// pagesScanned 是重算摘要里扫过的条目数 —— 0 条目的空与扫过 500 条的空不是一回事。
/**
 * 空列表的成因。`runs` 是**两类覆盖范围**（rules = 项目级重算，identity = 跨行身份重算），
 * 不能用一个布尔代表"跑过了"：只点跨行重算时列级/页级判据一条都没算，
 * 此时说"当前批次没有疑点"是假承诺（#235 二轮评审阻断项）。
 */
export function emptyReason({ items, runs, pagesScanned }) {
  if ((items ?? []).length > 0) return 'has-findings'
  const rulesRun = Boolean(runs?.rules)
  if (!rulesRun && !runs?.identity) return 'never-run'
  if (!rulesRun) return 'identity-only'
  if (pagesScanned === 0) return 'no-entries'
  return 'clean'
}

export const EMPTY_MESSAGES = {
  'has-findings': '',
  'never-run': '这个项目还没跑过项目级重算。列级与页级疑点（编码形式、标点混用、分页异常）必须看到整批数据才判得出来，所以它们现在一定是空的——这不表示资料干净。',
  'no-entries': '项目里还没有可扫描的条目，重算跑不出东西。',
  clean: '跑过了，当前批次没有疑点。',
  // 只跑过跨行重算时的说法：不得宣称"没有疑点"，那等于把没算过的判据说成算了且干净。
  'identity-only': '这个项目只跑过跨行身份重算：列级与页级判据（编码形式、标点混用、分页异常）还没看到整批数据，因此这里为空不表示资料干净。请再点一次「按项目重算疑点」。'
}

// 重算摘要 → 一句人话。字段名不猜：缺什么就不说什么，绝不编一个数出来。
export function recomputeNotice(summary, { identity = false } = {}) {
  if (!summary || typeof summary !== 'object') return ''
  const bits = []
  if (Number.isFinite(summary.pages)) bits.push(`扫了 ${summary.pages} 条`)
  if (Number.isFinite(summary.findings)) bits.push(`产出 ${summary.findings} 条疑点`)
  if (Number.isFinite(summary.superseded)) bits.push(`下线旧批次 ${summary.superseded} 条`)
  if (Number.isFinite(summary.duration_ms)) bits.push(`用时 ${summary.duration_ms} ms`)
  if (Number.isFinite(summary.unanchored) && summary.unanchored > 0) {
    bits.push(`有 ${summary.unanchored} 条找不到挂靠条目，没写进去（要看日志）`)
  }
  if (identity && Number.isFinite(summary.unattributed_groups) && summary.unattributed_groups > 0) {
    bits.push(`${summary.unattributed_groups} 组有分歧但登记来源不足以判成跨来源冲突，只报了同身份分歧`)
  }
  if (identity && summary.difficulty_stale) {
    bits.push('跨行检出不刷任务难度：这批疑点会影响 tier，需要再点一次「按项目重算疑点」才会更新分层')
  }
  return bits.join('；')
}
