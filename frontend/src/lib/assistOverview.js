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

// `off` 档的两种成因必须分开数（#254）。它们都写"尚未放行"，但动作完全不同：
// 前者是等证据，后者按现有流程永远等不到——把后者说成"尚未放行"，
// manager 就会排一次永远不会发生的放行。`unknown` 单列：表上没登记的身份
// 连有没有通道都不知道，并进任何一类都是替它编一个结论。
export function gatedOffSplit(items) {
  const split = { waiting: 0, noChannel: 0, unknown: 0, total: 0 }
  for (const item of items ?? []) {
    if (item?.gate !== 'off') continue
    split.total += 1
    if (item?.scoring_channel === 'unscored') split.noChannel += 1
    else if (item?.scoring_channel === 'scored') split.waiting += 1
    else split.unknown += 1
  }
  return split
}

export function gatedOffNotice(split) {
  if (!split?.total) return ''
  const parts = []
  if (split.waiting) parts.push(`${split.waiting} 条所在规则有打分通道、这轮证据未达档（n/p̂ 不够），补够样本并人工批准后可放行`)
  if (split.noChannel) parts.push(`${split.noChannel} 条所属判据没有弱标注打分通道，按现有流程拿不到档位——不是"再等等"`)
  if (split.unknown) parts.push(`${split.unknown} 条所属判据未登记在通道表里，界面无法判断它能否拿到档位，需要补 rule_coverage.js`)
  return parts.join('；')
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

// ---- 疑点定位 ----
//
// 只有 kind / 字段 / 措辞时，管理员读完一批疑点仍然不知道"去哪一条核对"，
// 这些函数把后端下发的 page_number / pdf_page / evidence 变成能照着找的东西。
//
// anchor 决定了「第 N 条」能不能直说：`entry` 是真挂靠在这条上，
// 而 `column_first_entry` / `pdf_page_first_entry` 只是整批判据挑的第一个条目当锚点，
// 此时说"疑点在第 41 条"会把"整列都有问题"说成"这一条有问题"——必须换个说法。
const ANCHOR_PREFIX = {
  column_first_entry: '整列判定，挂靠',
  pdf_page_first_entry: '整页判定，挂靠'
}
// 每处命中区间的展示上限：一行里堆十个区间就没法扫了。
const MAX_SPANS_SHOWN = 3

// 「第几个字」：char_offsets 是码位半开区间 [[start, end), …]，展示成 1 起的闭区间。
// 契约（review-findings.md §2）写明只有格级判据带区间，R5 与列级/页级判据天生看不到单格，
// 所以缺区间要说成"这类判据指不到字"，不能留白让人以为已经看过。
export function findingSpanText(row) {
  const spans = row?.evidence?.char_offsets
  if (!Array.isArray(spans) || spans.length === 0) {
    return row?.evidence?.anchor === 'entry'
      ? '未给出命中位置'
      : '该类判据按整批数据判定，指不到具体字'
  }
  const parts = spans
    .filter((pair) => Array.isArray(pair) && pair.length === 2)
    .filter(([start, end]) => Number.isInteger(start) && Number.isInteger(end) && end > start)
    .slice(0, MAX_SPANS_SHOWN)
    .map(([start, end]) => (end - start === 1 ? `第 ${start + 1} 字` : `第 ${start + 1}–${end} 字`))
  if (!parts.length) return '未给出命中位置'
  const rest = spans.length - parts.length
  return `命中${parts.join('、')}${rest > 0 ? ` 等 ${spans.length} 处` : ''}`
}

// 挂靠条目 + PDF 页 + 能不能一键筛。缺值一律如实说出来，不许留白。
// `page` 是 cascadeDelete 的 relation，条目删除会连带删掉疑点，所以这里不存在
// 「疑点还挂着但条目没了」那一档，缺号只可能是没填或读取异常 ⇒ 一律说"未知"。
export function findingLocator(row) {
  const anchor = String(row?.evidence?.anchor ?? '')
  const prefix = ANCHOR_PREFIX[anchor] ?? ''
  const pageNumber = Number(row?.page_number)
  const entryText = Number.isInteger(pageNumber) && pageNumber > 0
    ? `${prefix}第 ${pageNumber} 条`
    : `${prefix}条目号未知`
  const pdfPage = Number(row?.pdf_page)
  const hasPdf = Number.isInteger(pdfPage) && pdfPage > 0
  // 条目列表的 PDF 页范围是后端精确数值过滤（q 是子串匹配，拿来跳某一条会误命中），
  // 所以只有拿到页号时才给这个按钮。
  return {
    entryText,
    pdfText: hasPdf ? `PDF 第 ${pdfPage} 页` : '无 PDF 页号（CSV 直接导入的条目）',
    jumpable: hasPdf,
    pdfPage: hasPdf ? pdfPage : null
  }
}
