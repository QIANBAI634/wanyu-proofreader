// #161 校对端疑点渲染的纯函数层。
//
// 形状唯一出处是 docs/plans/2026-09-25-review-findings.md §3.1：
//   hints = [{ field, kind, severity, message:{key,params}, highlight, evidence }]
// 服务端已按 gate 与 severity 过滤完毕（off 档与 info 级不会到达这里），
// 所以渲染端**不得**再实现任何"按 severity 决定要不要显示"的逻辑——
// `highlight` 是唯一的强调信号；密度控制只有本文件的 D_max 一条。
//
// 措辞一律走 findingMessages.js 的 renderFindingMessage（未知 key 退化为可读文本），
// 本文件不新增自由文本口径，也不显示 confidence 百分比或 producer（契约 §9）。

import { renderFindingMessage } from './findingMessages.js'

// D_max 取值归本 issue（#161 评论）：门槛文件 §8.1 实测每行 warn+strong 分布
// p99 = 1、max = 3（分母 15,022 行）。取 3 覆盖全部已观测密度，超出部分折叠成计数，
// 不做按历史误报率的动态调节（#179 回填明确禁止）。
// 口径与 §8.1 写定的 hint_density 一致：**整行**可见条数上限，而不是每字段各 3 条。
// 折叠计数仍按桶（字段卡 / 整条级）归属，被行级上限隐藏的疑点不会静默消失。
export const HINT_DISPLAY_LIMIT = 3

// kind 短标签：#176 §2 的 10 值枚举是封闭集合，新增 kind 需要迁移，
// 因此这里查不到时回退成 kind 本身（可读、不抛错）就是留给 #178 这类
// 后续生产者的接入点——渲染端永远不需要为新 kind 改代码。
const KIND_LABELS = {
  char_out_of_repertoire: '集外字符',
  confusable_substitution: '易混替换',
  encoding_form_anomaly: '编码形式',
  missing_field: '缺字段',
  reading_format_invalid: '记音格式',
  punctuation_mix: '标点混用',
  page_outlier: '分页异常',
  duplicate_identity: '疑似重复合并',
  cross_source_conflict: '跨来源不一致',
  merged_columns: '疑似列合并'
}

export function hintKindLabel(kind) {
  const key = String(kind ?? '')
  return KIND_LABELS[key] || key || '机器疑点'
}

// 一条 finding 的渲染视图：措辞 + 强调 + 定位所需的最小信息。
// evidence 原样保留（char_offsets/bbox 只在点击定位时消费），不解析、不猜形状。
function toHintView(hint) {
  return {
    field: String(hint?.field ?? ''),
    kind: String(hint?.kind ?? ''),
    severity: String(hint?.severity ?? ''),
    highlight: Boolean(hint?.highlight),
    text: renderFindingMessage(hint?.message),
    evidence: hint?.evidence && typeof hint.evidence === 'object' ? hint.evidence : {}
  }
}

// highlight 的排前，其余保持服务端给的顺序（kind,message_key 稳定序）。
// 这只是展示次序，不是过滤：可见集合不因 severity/gate 有任何变化。
function emphasisFirst(entries) {
  return entries
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => (Number(Boolean(b.entry.hint.highlight)) - Number(Boolean(a.entry.hint.highlight))) || (a.index - b.index))
    .map(({ entry }) => entry)
}

const EMPTY_PREPARED = Object.freeze({
  fields: Object.freeze({}),
  pageLevel: Object.freeze({ items: Object.freeze([]), overflow: 0 }),
  total: 0
})

// renderedColumns 是视图侧实际渲染的列名（rowHeaders）。传了它，`field` 命不中任何
// 已渲染列的疑点会并入整条级而不是静默消失——#161 的硬要求是「宁可多标也不要漏标」，
// 「请勿以无标记当作已核对通过」不能因为生产者与导入列名漂移而失效。
// 不传则维持纯按 field 分组的旧行为（纯函数层不猜视图）。
function toRenderedSet(renderedColumns) {
  if (Array.isArray(renderedColumns) || renderedColumns instanceof Set) {
    return new Set([...renderedColumns].map(String))
  }
  return null
}

// 唯一必须成立的退化保证：hints 恒为空数组时返回**引用稳定**的空结构，
// 消费端所有 v-if 都为假 → 界面与今天像素级一致（#179 回填：这是当前唯一情况）。
// 非数组、缺 field、未知 kind 一律按"无数据或可读退化"处理，不抛错。
export function prepareFieldHints(rawHints, renderedColumns) {
  if (!Array.isArray(rawHints) || rawHints.length === 0) return EMPTY_PREPARED
  const rendered = toRenderedSet(renderedColumns)
  const buckets = new Map()
  let total = 0
  for (const raw of rawHints) {
    const hint = toHintView(raw)
    total += 1
    const orphan = hint.field !== '' && rendered !== null && !rendered.has(hint.field)
    const key = hint.field === '' || orphan ? '' : hint.field
    if (!buckets.has(key)) buckets.set(key, [])
    buckets.get(key).push(hint)
  }
  // 行级总上限：跨桶统一 emphasis-first 后取前 D_max 条，剩余按桶记折叠数。
  const flat = []
  for (const [key, items] of buckets) {
    for (const hint of items) flat.push({ key, hint })
  }
  const visible = new Map()
  const overflow = new Map()
  let shown = 0
  for (const entry of emphasisFirst(flat)) {
    if (shown < HINT_DISPLAY_LIMIT) {
      if (!visible.has(entry.key)) visible.set(entry.key, [])
      visible.get(entry.key).push(entry.hint)
      shown += 1
    } else {
      overflow.set(entry.key, (overflow.get(entry.key) || 0) + 1)
    }
  }
  const fields = {}
  for (const key of buckets.keys()) {
    if (key === '') continue
    fields[key] = { items: visible.get(key) || [], overflow: overflow.get(key) || 0 }
  }
  const pageLevel = { items: visible.get('') || [], overflow: overflow.get('') || 0 }
  return { fields, pageLevel, total }
}

// 视图侧唯一入口：给 field 返回该字段卡的疑点（无则空数组——渲染端据此 v-if）。
export function hintsForField(prepared, field) {
  if (!prepared || !prepared.fields) return []
  const bucketOfField = prepared.fields[String(field ?? '')]
  return bucketOfField ? bucketOfField.items : []
}

export function hintsOverflowFor(prepared, field) {
  const bucketOfField = prepared?.fields?.[String(field ?? '')]
  return bucketOfField ? bucketOfField.overflow : 0
}

// 整条级（field 为空）疑点：挂在字段卡列表上方，同样"无数据不占位"。
export function pageLevelHints(prepared) {
  return prepared?.pageLevel?.items ?? []
}

export function pageLevelOverflow(prepared) {
  return prepared?.pageLevel?.overflow ?? 0
}

// ---- SourceSpan 定位（#161 期望结果 3 的"先字段内、后页图"的第一步）----
//
// evidence.char_offsets 是 [[start,end],…] 的**码位**偏移对（生产者侧 corpus_probe
// 与 #178 的 Python/JS 规则都以码位计），textarea/DOM 的 selection 是 UTF-16 索引，
// 所以必须换算；汉字表意文字补充平面（如 𰻞）会让两者相差 1/码位。
// 任何形状不符（缺省、非数组、区间倒置、越界）都返回 null——定位降级为"聚焦该字段"，
// 绝不因为证据形状问题阻断点击。

function codepointSpanToUtf16(text, start, end) {
  const chars = Array.from(text)
  if (start < 0 || end > chars.length || end <= start) return null
  let utf16Start = 0
  for (let i = 0; i < start; i += 1) utf16Start += chars[i].length
  let utf16End = utf16Start
  for (let i = start; i < end; i += 1) utf16End += chars[i].length
  return { start: utf16Start, end: utf16End }
}

export function locateSpan(text, charOffsets) {
  if (typeof text !== 'string' || !Array.isArray(charOffsets) || charOffsets.length === 0) return null
  for (const pair of charOffsets) {
    if (!Array.isArray(pair) || pair.length !== 2) continue
    const [rawStart, rawEnd] = pair
    if (!Number.isInteger(rawStart) || !Number.isInteger(rawEnd)) continue
    const span = codepointSpanToUtf16(text, rawStart, rawEnd)
    if (span) return span
  }
  return null
}

// #228/#234：被门控挡住的条数要说出来。
//
// 这条文案存在的唯一理由是：`hints: []` 有两种成因——规则没放行，或者这条真的没疑点。
// 两者在校对端长得一模一样，而后者会被读成"可以放心"。有了 suppressed_by_gate，
// 界面才能把第一种情况说成第一种。数字为 0 时返回空串（那就确实没有东西被挡住）。
export function gatedNotice(suppressed) {
  const count = Number(suppressed)
  if (!Number.isFinite(count) || count <= 0) return ''
  return `本条另有 ${Math.floor(count)} 处机器疑点暂未开放显示（规则尚未放行，不代表这条没有值得看的地方）。`
}
