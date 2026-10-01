// #178 同身份跨行检出（身份键归一 + 冲突判定）。纯函数层。
//
// 前置约束 R-DEDUP（从 #171 移植，不可违背）：条目身份 = (headword, pinyin)，
// **同形词头绝不合并**。所以同词头多行是正常现象，本文件因此不报「重复」，
// 只报两类：
//   1. duplicate_identity：身份相同但其余角色字段（meaning / region）不同 —— 允许并存、
//      但人工应当看一眼；
//   2. cross_source_conflict：同一身份的不同取值来自**两个以上不同的登记来源**（#169 的
//      `sources`）—— 同一个结论比 1 更值得先看，因为分歧不是"两次录入"而是"两份材料互斥"；
//   3. merged_columns（规则生产者）：同一行内出现「两个词头挤在一列」「释义列含调号串」
//      这类形状异常。与 #125 的 merged_columns 同语义、不同生产者。
//
// 2 与 1 **互斥而不是并列**：一组条目里取值分歧若已能归因到不同登记来源，就报
// cross_source_conflict，否则报 duplicate_identity。两条都打会让同一条目挂两个 strong、
// 把 difficulty_tier 直接推上 C 两次，队列里也会出现同一件事的两个条目（#178 验收要求
// 的是"标在条目上并列出冲突来源集合"，不是一套事实两份疑点）。
// 来源不足（未关联 sources，或整组只有单一来源）时一律落 1，并把这组计入
// `unattributed_groups` 返回 —— "没报跨来源"必须是个可见的计数，不是静默省略。
//
// 不做的事（#178 非目标）：不合并、不删除、不做模糊匹配/编辑距离/向量相似度（那是 L2 #181）、
// 不跨项目、不裁决谁对、不写回任何值。

const IDENTITY_VERSION = "identity-v2"
// 从 v1 升版的原因不是加了第三个 kind，而是**同身份分歧的归类规则变了**：
// 以前所有分歧都叫 duplicate_identity，现在能归因到不同登记来源的那批改叫
// cross_source_conflict。同一份数据用 v1 与 v2 会产出不同 kind，而 gate 的四元组里
// 带 producer_version，所以升版等于"新 kinds 一律从 off 重新攒证据"——这正是
// docs/plans/2026-09-25-assist-rule-thresholds.md §2 想要的效果，不是副作用。
// 挂靠口径的词表由 assist_rules.js 拥有（ANCHOR_ENTRY / ANCHOR_COLUMN / ANCHOR_PDF_PAGE）。
// #178 的三条疑点都是"逐成员产条、挂在这个成员自己那一条上"，所以一律 entry；契约侧
// anchor 是**每条**必填（docs/plans/2026-09-25-review-findings.md §8.1 第 2 条），
// 读取端不必先判作用域再决定这条有没有口径。identity_integration.mjs 钉住两个词表值一致，
// 免得这里是一份会各自漂移的字面量。
const ANCHOR_ENTRY = "entry"

// 莆仙正本的列名。#170 落地后要改成按角色查询（与 #177 的 R5/R6 同一处债务）。
const HEADWORD_FIELDS = ["词条"]
const READING_FIELDS = ["拼音", "莆田IPA", "仙游IPA"]
const COMPARABLE_FIELDS = ["释义", "地区", "来源"]

// 全/半角折叠：复用 #177 R4 的成对表，避免两处各写一份折叠规则而漂移。
const WIDTH_FOLDS = new Map([
  ["（", "("], ["）", ")"], ["［", "["], ["］", "]"], ["；", ";"],
  ["，", ","], ["：", ":"], ["　", " "]
])

function foldWidths(text) {
  let out = ""
  for (const ch of text) out += WIDTH_FOLDS.get(ch) ?? ch
  return out
}

// 归一化只做到「NFC + 去空白 + 全半角折叠」：
// 不做大小写折叠（记音里大小写有区别，O/0 之类的混淆正是 R2 的靶子），
// 也不做任何 Unicode 等价"合并"——那是 #174 的范围，两边口径必须一致。
function normalizeText(value) {
  const folded = foldWidths(String(value ?? "").normalize("NFC"))
  return folded.replace(/\s+/g, "")
}

function firstPresent(row, fields) {
  for (const field of fields) {
    const value = row?.[field]
    if (String(value ?? "").trim() !== "") return { field, value: String(value) }
  }
  return null
}

/**
 * 条目身份键 = 归一化(词头) + 单个空格 + 归一化(记音)。
 *
 * 分隔符必须是**可打印字符**：这个键要落到 pages.entry_identity_key 和
 * finding_dismissals.group_key 两个文本列里，用 \u0000 会被 PocketBase 的文本校验拒成 400，
 * 而且没人能在管理端肉眼读出一个含 NUL 的分组键。
 * 归一化已经把两段里的空白全部去掉了，所以空格分隔是无损、可反解的。
 *
 * 两段任一缺失就返回 null：宁可不算，也不拿一个不完整的键去误伤别的条目。
 */
function entryIdentityKey(row) {
  const headword = firstPresent(row, HEADWORD_FIELDS)
  const reading = firstPresent(row, READING_FIELDS)
  if (!headword || !reading) return null
  return `${normalizeText(headword.value)} ${normalizeText(reading.value)}`
}

function identityParts(row) {
  const key = entryIdentityKey(row)
  if (!key) return null
  const cut = key.indexOf(" ")
  return { key, headword: key.slice(0, cut), reading: key.slice(cut + 1) }
}

/**
 * 按身份键分组并找冲突。
 * @param entries [{id, project, row, source?}]  row 是已解析的对象
 * @param dismissed Set<groupKey>  人工标过 not_conflict 的组，整组跳过
 * @returns {findings, groups, compared, unkeyed, unattributed_groups, dismissed_groups}
 */
// 一次身份分组里，哪些字段的分歧可以归因到**不同的登记来源**。
// 判据：该字段有 ≥2 个不同取值，且这些取值背后的来源集合不止一种。
// 来源为空串（未关联 sources）不参与来源集合 —— 拿"未知"去证明"两份材料互斥"
// 就是虚假结论，这正是 #178 正文要求"来源缺失时不报跨来源冲突"的原因。
function crossSourceFields(bucket) {
  const fields = []
  for (const field of COMPARABLE_FIELDS) {
    const signatures = new Set()
    let valueCount = 0
    const byValue = new Map()
    for (const item of bucket) {
      const value = normalizeText(item.row?.[field])
      if (!value) continue
      if (!byValue.has(value)) { byValue.set(value, new Set()); valueCount += 1 }
      const source = String(item.source ?? "")
      if (source) byValue.get(value).add(source)
    }
    if (valueCount < 2) continue
    for (const sources of byValue.values()) {
      if (sources.size) signatures.add([...sources].sort().join("|"))
    }
    if (signatures.size >= 2) fields.push(field)
  }
  return fields
}

function findIdentityConflicts(entries, dismissed = new Set()) {
  const groups = new Map()
  let noKey = 0
  for (const entry of entries) {
    const parts = identityParts(entry.row)
    if (!parts) { noKey += 1; continue }
    const bucket = groups.get(parts.key) ?? []
    bucket.push({ ...entry, parts })
    groups.set(parts.key, bucket)
  }

  const findings = []
  let compared = 0
  let unattributed = 0
  for (const [key, bucket] of [...groups].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    if (bucket.length < 2) continue
    if (dismissed.has(key)) continue
    const others = COMPARABLE_FIELDS
      .map((field) => {
        const values = new Set(bucket.map((item) => normalizeText(item.row?.[field])).filter(Boolean))
        return values.size > 1 ? field : null
      })
      .filter(Boolean)
    if (!others.length) continue
    // 同词头不同拼音的两条根本不会落进同一个 key，所以 R-DEDUP 的反向用例由分组保证，
    // 不是靠"记得判断"。这里断言的是一次比较都发生在身份相同的前提下。
    compared += bucket.length
    const sources = [...new Set(bucket.map((item) => item.source).filter(Boolean))]
    const cross = crossSourceFields(bucket)
    // 两个事实分开表达，不互相覆盖：
    // - `differs_on` 是**这一组里所有取值有分歧的列**（措辞需要的是全集）；
    // - `kind` / `message_key` 只在"至少有一列能归因到 ≥2 个登记来源"时才升级成跨来源冲突。
    // 早先写成 `cross.length ? cross : others`，含义变成"只要有一列能归因，其余归因不到的
    // 列就不再被报告"——那一列的分歧会同时从疑点、从 differs_on、从计数器上消失，
    // 而 `unattributed_groups` 仍然报 0。这就是下面那段注释要防的"没人知道这里没报"。
    const differsOn = others
    // 计数口径与之一致：只要**存在归因不到的分歧列**就计数，不管是整组没归因（cross 为空）
    // 还是部分列没归因。#178 规定来源缺失时只报 duplicate_identity，这是纪律不是遗漏。
    if (others.some((field) => !cross.includes(field))) unattributed += 1
    for (const item of bucket) {
      const partners = bucket.filter((other) => other.id !== item.id).map((other) => other.id)
      findings.push({
        kind: cross.length ? "cross_source_conflict" : "duplicate_identity",
        severity: "strong",
        field: differsOn.includes("释义") ? "释义" : differsOn[0],
        message_key: cross.length ? "same_identity_across_sources" : "same_identity_different_content",
        // params 只带结构信息（列名、计数、来源标识）。词头与记音的**字面值**曾经在这里
        // 出现过（identity_headword / identity_reading），全仓没有任何消费方读它们，而
        // review_findings.params_json 会随 hint 原样下发给该条目的在手校对员
        // （契约见 docs/plans/2026-09-25-review-findings.md §8.1 第 1 条：按绝对解释，
        // 连"本条目自己的原文"也不带）。措辞只需要 differs_on / partner_count / sources。
        params: {
          differs_on: differsOn,
          partner_count: partners.length,
          sources
        },
        evidence: { anchor: ANCHOR_ENTRY, page: item.id, partners }
      })
    }
  }
  return {
    findings,
    groups: groups.size,
    compared,
    unkeyed: noKey,
    unattributed_groups: unattributed,
    dismissed_groups: dismissed.size
  }
}

// merged_columns（规则生产者）：同一行内的形状异常。两类判据：
//   1. 词头列里像是有两个词头（含空白/分隔符且每段都像独立词头）；
//   2. 释义列里混进了一串记音（含数字调号串或 IPA 段）。
// 与 #125 的同名 kind 同语义、不同生产者；参考 w4_blocked_queue.py 的「列合并修复」分诊桶。
const TONE_RUN = /[1-7]{2,}/
const IPA_HINT = /[ʰʷ̃ˀɒøæŋʔɨ]|\u0303/

// 命中区间：`[[start, end), …]`，码位计、半开区间，口径与 assist_rules.js 的
// predicateSpans 一字不差（消费端是 frontend/src/lib/fieldHints.js 的 locateSpan）。
// 这里没有从 assist_rules.js 取那份现成实现，是因为本文件与它一样刻意保持"不 require 别的 lib"
// ——两者都要能在 node 里直接跑，而 hook 侧的 `${__hooks}` 路径解析在 node 里不存在。
// 新增第三处使用者时应当把它们收到同一个纯模块里，而不是再抄第三遍。
function cellSpans(text, isHit) {
  const indices = []
  let index = 0
  for (const ch of Array.from(String(text ?? ""))) {
    if (isHit(ch)) indices.push(index)
    index += 1
  }
  const merged = []
  for (const position of indices) {
    const last = merged[merged.length - 1]
    // 与前一段的尾（开区间的下一个位置）相接才并入；写成 last[1] - 1 会把
    // 「乙丙」这样相邻的两个码位拆成两段，高亮就变成一格一字。
    if (last && position === last[1]) last[1] = position + 1
    else merged.push([position, position + 1])
  }
  return merged
}

const CELL_SEPARATOR = /[\s、,，;；]/

function findRowShapeAnomalies(entry) {
  const out = []
  const row = entry.row ?? {}
  for (const field of HEADWORD_FIELDS) {
    const value = String(row[field] ?? "").trim()
    if (!value) continue
    const segments = value.split(/[\s、,，;；]+/).filter(Boolean)
    if (segments.length >= 2) {
      out.push({
        kind: "merged_columns", severity: "strong", field,
        message_key: "multiple_headwords_in_cell",
        params: { segments: segments.length, sample_lengths: segments.slice(0, 4).map((s) => Array.from(s).length) },
        // 区间算在**未 trim 的原值**上：前端标的是 `originalRow[字段]` 那个串本身，
        // 在 trim 后的串上取下标会整体偏移。分隔符不算命中，所以每段自然各自成区间。
        evidence: {
          anchor: ANCHOR_ENTRY, page: entry.id,
          char_offsets: cellSpans(row[field], (ch) => !CELL_SEPARATOR.test(ch))
        }
      })
    }
  }
  for (const field of ["释义"]) {
    const value = String(row[field] ?? "")
    if (!value.trim()) continue
    if (TONE_RUN.test(value) || IPA_HINT.test(value)) {
      out.push({
        kind: "merged_columns", severity: "warn", field,
        message_key: "reading_inside_meaning_row",
        params: { has_tone_digits: TONE_RUN.test(value), has_ipa_marks: IPA_HINT.test(value) },
        // 标的是「这格里像记音的那些字符」：判据本身就是"含数字调号串或 IPA 段"，
        // 所以逐字符命中比只标第一个匹配更贴近校对员要看的东西。
        evidence: {
          anchor: ANCHOR_ENTRY, page: entry.id,
          char_offsets: cellSpans(value, (ch) => /[1-7]/.test(ch) || IPA_HINT.test(ch))
        }
      })
    }
  }
  return out
}

module.exports = {
  ANCHOR_ENTRY,
  IDENTITY_VERSION,
  HEADWORD_FIELDS,
  READING_FIELDS,
  COMPARABLE_FIELDS,
  WIDTH_FOLDS,
  normalizeText,
  foldWidths,
  entryIdentityKey,
  identityParts,
  crossSourceFields,
  findIdentityConflicts,
  findRowShapeAnomalies
}
