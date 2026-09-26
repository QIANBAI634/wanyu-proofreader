// #180 任务难度 A/B/C 信号推导。
//
// 纯函数层：输入信号，输出 {tier, basis, version, blocked_reason}。
// 「信号 → 层级」是一张可评审的表（TIER_RULES），不是散在代码里的 if —— #180 的验收项
// 明确要求这一点，且「改表必改测试」（assist_difficulty 的表驱动测试逐行走查，防门禁恒真）。
//
// 两条红线（#175 红线 1 + #180 正文）：
// 1. tier 绝不得由「他人提交结果」推导——本层的输入里没有任何他人 attempt 内容，
//    只有疑点、列角色、页码、阻塞原因与项目内的形状统计；
// 2. tier 不是轮次线索，只作为自领时的筛选维度（对校对端响应里出现 tier 由测试守住）。
//
// 阻塞原因与任务难度是**两个维度**（#196 并入本 issue 的那条）：blocked_reason 回答
// "现在为什么做不下去"，tier 回答"要多长时间/多高专业度"。#162 只消费 tier，
// #188 只消费 blocked_reason，两者都在这里算但互不推导。

const DIFFICULTY_VERSION = "tier-v1"

const TIERS = ["unknown", "A", "B", "C"]
// 多条信号同时命中时取**最严的一条**（上确界），不做平均也不做多数表决：
// 分层的目的是别把 C 派给只会秒判 A 的人，向下取会直接坏事。
const TIER_RANK = { unknown: 0, A: 1, B: 2, C: 3 }

// 阻塞原因分桶，移植 w4_blocked_queue.py 的分诊语义（按「什么输入才能真正解开它」分类）。
const BLOCKED_BUCKETS = ["glyph_table", "scanned_read", "column_merge", "rights_gate", "unknown"]

// 判定表。**每一行都必须有用例覆盖**；加一行不写用例，表驱动测试会红。
const TIER_RULES = [
  { id: "cross_source_conflict", tier: "C", signal: "带 cross_source_conflict 疑点",
    rationale: "多个登记来源给出不同值，要判断而不是照抄" },
  { id: "rights_gate_blocked", tier: "C", signal: "blocked_reason = rights_gate",
    rationale: "授权未决的条目不该由志愿者开工，该走 #188 升级" },
  { id: "scanned_read_blocked", tier: "C", signal: "blocked_reason = scanned_read",
    rationale: "扫描页识读需要肉眼辨认与领域知识" },
  { id: "strong_findings_ge_2", tier: "C", signal: "strong 级疑点 ≥ 2",
    rationale: "多处结构级问题叠加" },
  { id: "reading_and_meaning_change", tier: "B", signal: "列角色同时含 reading 与 meaning",
    rationale: "要理解词义才能定读法，需上下文" },
  { id: "column_merge_blocked", tier: "B", signal: "blocked_reason = column_merge",
    rationale: "先修结构再谈内容" },
  { id: "strong_findings_eq_1", tier: "B", signal: "恰好 1 条 strong 级疑点",
    rationale: "单点结构问题，看一眼就够，不必专业判断" },
  { id: "missing_pdf_page", tier: "B", signal: "缺 pdf_page（前端定位降级警告同源）",
    rationale: "看不到原文页，只能靠已有文本推断" },
  { id: "row_shape_outlier", tier: "B", signal: "字段数或最长值对项目分布离群",
    rationale: "形状异常通常意味着拆分/合并问题" },
  { id: "warn_findings_ge_3", tier: "B", signal: "warn 级疑点 ≥ 3",
    rationale: "单条 warn 是噪声，成堆说明这行不干净" },
  { id: "frequent_arbitration", tier: "B", signal: "该条目涉及的列历史仲裁进入率 ≥ 0.25",
    rationale: "「这个位置常出事」是比单条内容更强的先验（来自 #179 的分布）" },
  { id: "glyph_table_blocked", tier: "A", signal: "blocked_reason = glyph_table",
    rationale: "查表填字是机械操作，量大但不难——正是该被大量吞掉的 A" },
  { id: "pure_transcription", tier: "A", signal: "列角色只有 headword/reading 且零疑点",
    rationale: "照抄型任务" }
]

const ARBITRATION_RATE_TRIGGER = 0.25
const FIELD_COUNT_OUTLIER = 2          // 与项目中位数相差 2 列以上
const VALUE_LENGTH_OUTLIER_MADS = 6    // 最长值超过中位数 + 6×MAD

function isEmptyValue(value) {
  return String(value ?? "").trim() === ""
}

function normalizeBlocked(value) {
  return BLOCKED_BUCKETS.includes(value) ? value : "unknown"
}

// 从疑点里能自动认出的阻塞原因。其余分桶要等 #123（缺字表）与 #124（预览）给出信号，
// 认不出来就留 unknown——不得为了"看起来有信号"而猜。
function blockedReasonFromFindings(findings) {
  const list = Array.isArray(findings) ? findings : []
  if (list.some((item) => item.kind === "merged_columns")) return "column_merge"
  if (list.some((item) => item.kind === "missing_glyph_placeholder")) return "glyph_table"
  return "unknown"
}

function firedRuleIds(input) {
  const findings = Array.isArray(input.findings) ? input.findings : []
  const strong = findings.filter((item) => item.severity === "strong").length
  const warn = findings.filter((item) => item.severity === "warn").length
  const blocked = normalizeBlocked(input.blockedReason)
  const roles = input.roles && Object.keys(input.roles).length ? input.roles : null
  const roleSet = roles ? new Set(Object.values(roles)) : null
  const stats = input.projectStats || {}
  const fired = new Set()

  if (findings.some((item) => item.kind === "cross_source_conflict")) fired.add("cross_source_conflict")
  if (blocked === "rights_gate") fired.add("rights_gate_blocked")
  if (blocked === "scanned_read") fired.add("scanned_read_blocked")
  if (blocked === "column_merge") fired.add("column_merge_blocked")
  if (blocked === "glyph_table") fired.add("glyph_table_blocked")
  if (strong >= 2) fired.add("strong_findings_ge_2")
  else if (strong === 1) fired.add("strong_findings_eq_1")
  if (warn >= 3) fired.add("warn_findings_ge_3")
  if (isEmptyValue(input.pdfPage) || Number(input.pdfPage) <= 0) fired.add("missing_pdf_page")

  if (roleSet) {
    const hasReading = roleSet.has("reading")
    const hasMeaning = roleSet.has("meaning")
    if (hasReading && hasMeaning) fired.add("reading_and_meaning_change")
    const onlyCopyRoles = [...roleSet].every((role) => role === "headword" || role === "reading")
    if (onlyCopyRoles && !hasMeaning && strong === 0 && warn === 0) fired.add("pure_transcription")
  }

  const medianFields = Number(stats.medianFieldCount)
  if (Number.isFinite(medianFields) && input.fieldCount
    && Math.abs(input.fieldCount - medianFields) >= FIELD_COUNT_OUTLIER) fired.add("row_shape_outlier")
  const medianLength = Number(stats.medianValueLength)
  const madLength = Number(stats.madValueLength)
  if (Number.isFinite(medianLength) && Number.isFinite(madLength) && madLength > 0
    && Array.isArray(input.valueLengths) && input.valueLengths.length) {
    const longest = Math.max(...input.valueLengths.map((value) => Number(value) || 0))
    if (longest - medianLength > VALUE_LENGTH_OUTLIER_MADS * madLength) fired.add("row_shape_outlier")
  }

  // #179 的分布今天还没有：arbitrationRates 为 null 时**不产生信号**。
  // 当 0 用会让所有条目系统性偏 A（"没测过"被当成"从不出事"），这是本文件最容易犯的错。
  const rates = input.arbitrationRates
  if (rates && typeof rates === "object") {
    for (const value of Object.values(rates)) {
      if (Number.isFinite(Number(value)) && Number(value) >= ARBITRATION_RATE_TRIGGER) {
        fired.add("frequent_arbitration")
        break
      }
    }
  }
  return fired
}

function deriveDifficulty(input) {
  const fired = firedRuleIds(input)
  const matched = TIER_RULES.filter((rule) => fired.has(rule.id))
  if (!matched.length) {
    return { tier: "unknown", basis: [], version: DIFFICULTY_VERSION,
      blocked_reason: normalizeBlocked(input.blockedReason) }
  }
  let tier = "unknown"
  for (const rule of matched) if (TIER_RANK[rule.tier] > TIER_RANK[tier]) tier = rule.tier
  return {
    tier,
    basis: matched.map((rule) => rule.id),
    version: DIFFICULTY_VERSION,
    blocked_reason: normalizeBlocked(input.blockedReason)
  }
}

function tierRank(tier) {
  return TIER_RANK[TIERS.includes(tier) ? tier : "unknown"]
}

module.exports = {
  DIFFICULTY_VERSION,
  TIERS,
  TIER_RANK,
  TIER_RULES,
  BLOCKED_BUCKETS,
  ARBITRATION_RATE_TRIGGER,
  FIELD_COUNT_OUTLIER,
  VALUE_LENGTH_OUTLIER_MADS,
  deriveDifficulty,
  blockedReasonFromFindings,
  normalizeBlocked,
  tierRank
}
