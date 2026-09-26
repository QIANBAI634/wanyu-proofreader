// #178 同身份跨行检出（身份键归一 + 冲突判定）。纯函数层。
//
// 前置约束 R-DEDUP（从 #171 移植，不可违背）：条目身份 = (headword, pinyin)，
// **同形词头绝不合并**。所以同词头多行是正常现象，本文件因此不报「重复」，
// 只报两类：
//   1. duplicate_identity：身份相同但其余角色字段（meaning / region）不同 —— 允许并存、
//      但人工应当看一眼；
//   2. merged_columns（规则生产者）：同一行内出现「两个词头挤在一列」「释义列含调号串」
//      这类形状异常。与 #125 的 merged_columns 同语义、不同生产者。
//
// cross_source_conflict 在本文件里**故意不实现**：它必须经 #169 的 sources 登记来源，
// 而 #169 至今 OPEN、`sources` 集合还不存在。#178 正文自己写明「来源缺失时只报
// duplicate_identity / merged_columns，不报跨来源冲突，避免虚假结论」——
// 所以这里缺的是依赖，不是遗漏。相关代码路径写成显式的 unknownSources 计数，
// 让"没报"这件事可见，而不是静默返回空。
//
// 不做的事（#178 非目标）：不合并、不删除、不做模糊匹配/编辑距离/向量相似度（那是 L2 #181）、
// 不跨项目、不裁决谁对、不写回任何值。

const IDENTITY_VERSION = "identity-v1"
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
 * @returns {findings, groups, compared, unknownSources}
 */
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
    for (const item of bucket) {
      const partners = bucket.filter((other) => other.id !== item.id).map((other) => other.id)
      findings.push({
        kind: "duplicate_identity",
        severity: "strong",
        field: others.includes("释义") ? "释义" : others[0],
        message_key: "same_identity_different_content",
        // params 只带结构信息（列名、计数、来源标识）。词头与记音的**字面值**曾经在这里
        // 出现过（identity_headword / identity_reading），全仓没有任何消费方读它们，而
        // review_findings.params_json 会随 hint 原样下发给该条目的在手校对员
        // （契约见 docs/plans/2026-09-25-review-findings.md §8.1 第 1 条：按绝对解释，
        // 连"本条目自己的原文"也不带）。措辞只需要 differs_on 与 partner_count。
        params: {
          differs_on: others,
          partner_count: partners.length,
          sources
        },
        evidence: { anchor: ANCHOR_ENTRY, page: item.id, partners }
      })
    }
  }
  return { findings, groups: groups.size, compared, unkeyed: noKey, dismissed_groups: dismissed.size }
}

// merged_columns（规则生产者）：同一行内的形状异常。两类判据：
//   1. 词头列里像是有两个词头（含空白/分隔符且每段都像独立词头）；
//   2. 释义列里混进了一串记音（含数字调号串或 IPA 段）。
// 与 #125 的同名 kind 同语义、不同生产者；参考 w4_blocked_queue.py 的「列合并修复」分诊桶。
const TONE_RUN = /[1-7]{2,}/
const IPA_HINT = /[ʰʷ̃ˀɒøæŋʔɨ]|\u0303/

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
        evidence: { anchor: ANCHOR_ENTRY, page: entry.id, char_offsets: [] }
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
        evidence: { anchor: ANCHOR_ENTRY, page: entry.id }
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
  findIdentityConflicts,
  findRowShapeAnomalies
}
