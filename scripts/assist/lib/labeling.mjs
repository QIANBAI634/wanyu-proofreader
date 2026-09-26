// #179 弱标注集与规则打分——纯逻辑核心。
//
// 这里是全部可评审的判断；CLI 只负责把数据搬进来。
// 口径来源：docs/plans/2026-09-25-assist-rule-thresholds.md（分档判据、报告纪律、假分歧隔离）。
//
// 脱敏约定（与 scripts/corpus_probe 同一判据：码位是结构信息，字形序列是内容）：
// 默认输出**不含任何单元格正文**，只含 id、字段名、长度、码位集合与摘要。
// 想拿到值本身必须显式加 --show-values，并且它会把这件事打到 stderr。

import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const rules = require('../../../backend/pb_hooks/lib/assist_rules.js')

const Z = 1.96

// 门槛文件 §2 的两档判据；改这里必须同时改那份文档。
export const GATE_CRITERIA = [
  { gate: 'strong', theta: 0.90, nMin: 100 },
  { gate: 'warn', theta: 0.60, nMin: 150 }
]

export function digest(value) {
  // FNV-1a 32bit，够用且零依赖；目的只是「同值可对齐」，不是密码学。
  let hash = 0x811c9dc5
  const text = String(value ?? '')
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, "0")
}

export function codepointSet(value) {
  return [...new Set(Array.from(String(value ?? "")).map((ch) => ch.codePointAt(0)))]
    .sort((a, b) => a - b)
    .map((code) => `U+${code.toString(16).toUpperCase().padStart(4, "0")}`)
}

function parseJson(raw, fallback) {
  const text = String(raw ?? "")
  if (!text) return fallback
  try {
    const parsed = JSON.parse(text)
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : fallback
  } catch {
    return fallback
  }
}

// 字段级的「等价但不相等」：#174 未修期间 NFC/NFD 会让 submitted !== final
// 却语义一致。这类负例必须单独标记，主分析排除，但要报告数量与占比（门槛文件 §4）。
export function normalizationEquivalent(submitted, final) {
  const a = String(submitted ?? "")
  const b = String(final ?? "")
  if (a === b) return false
  return a.normalize("NFC") === b.normalize("NFC")
}

/**
 * 由「曾进仲裁的条目 + 其各次提交 + 最终行」产出字段级弱标注。
 * @param {{pages: Array, attempts: Array}} dataset
 *   pages:   {id, project, final_row_json}        最终采纳的行（arbitrated/approved）
 *   attempts:{id, page, project, round, kind, proofreader, row_json, submitted_at}
 */
export function buildLabels(dataset) {
  const finalByPage = new Map()
  for (const page of dataset.pages ?? []) {
    const row = parseJson(page.final_row_json, null)
    if (row) finalByPage.set(page.id, { page, row })
  }
  const labels = []
  for (const attempt of dataset.attempts ?? []) {
    const settled = finalByPage.get(attempt.page)
    if (!settled) continue // 没进过仲裁/未定稿的条目不产样本
    const submittedRow = parseJson(attempt.row_json, null)
    if (!submittedRow) continue
    const fields = new Set([...Object.keys(submittedRow), ...Object.keys(settled.row)])
    for (const field of [...fields].sort()) {
      const submitted = submittedRow[field] ?? ""
      const final = settled.row[field] ?? ""
      if (submitted === final) {
        labels.push(record({ attempt, settled, field, submitted, final, accepted: true }))
        continue
      }
      if (normalizationEquivalent(submitted, final)) {
        labels.push(record({ attempt, settled, field, submitted, final, accepted: true,
          reason_code: "unicode_equivalent" }))
        continue
      }
      labels.push(record({ attempt, settled, field, submitted, final, accepted: false }))
    }
  }
  return labels
}

function record({ attempt, settled, field, submitted, final, accepted, reason_code = "none" }) {
  const item = {
    page: attempt.page,
    project: attempt.project,
    attempt: attempt.id,
    round: Number(attempt.round ?? 0),
    kind: String(attempt.kind ?? ""),
    field,
    accepted,
    reason_code,
    submitted_digest: digest(submitted),
    final_digest: digest(final),
    submitted_length: Array.from(String(submitted)).length,
    final_length: Array.from(String(final)).length,
    // 码位是结构信息：负例与「伪分歧」都要留下它（伪分歧的性质正是要能被审计），
    // 但真正的正例不留，避免把整份语料的字符集都写进输出。
    submitted_codepoints: accepted && reason_code === "none" ? [] : codepointSet(submitted),
    final_codepoints: accepted && reason_code === "none" ? [] : codepointSet(final),
    // 打分需要按内容跑规则，但内容不许进默认输出：这条只在内存里存在。
    _submitted_value: submitted,
    _final_value: final
  }
  return item
}

export function stripSecrets(labels) {
  return labels.map(({ _submitted_value, _final_value, ...rest }) => rest)
}

// 一条规则在某个提交行上是否命中该字段。
export function ruleFlagsRow(ruleName, rowValues) {
  const ctx = ruleName.context ?? rules.makeContext({ keyboards: ruleName.keyboards ?? [] })
  ruleName.context = ctx
  const findings = rules.runPageRules(ctx, rowValues)
  const keys = new Set(findings
    .filter((item) => item.kind === ruleName.kind && item.message_key === ruleName.message_key)
    .map((item) => item.field))
  return keys
}

export function wilsonInterval(hits, total) {
  if (!total) return null
  const p = hits / total
  const denom = 1 + (Z * Z) / total
  const centre = (p + (Z * Z) / (2 * total)) / denom
  const half = (Z / denom) * Math.sqrt((p * (1 - p)) / total + (Z * Z) / (4 * total * total))
  return { lower: Number((centre - half).toFixed(4)), upper: Number((centre + half).toFixed(4)) }
}

export function suggestGate(n, precision) {
  // 门槛文件 §3 的三分法要求先问「证据够不够」，再问「精度达没达标」，
  // 而且「够不够」是相对**该精度本来够格的那一档**的 n_min 说的——
  // 拿全局最小 n_min 判会把 n=149、p̂=0.65 误报成「精度不足」，
  // 而它其实是 warn 档的证据不足（warn 要 150）。两者处置不同：前者关规则，后者等证据。
  if (!n) return { gate: "off", basis: "n/a", note: "无命中样本，证据不足以下结论" }
  const minNMin = Math.min(...GATE_CRITERIA.map((c) => c.nMin))
  const qualified = GATE_CRITERIA
    .filter((criterion) => precision >= criterion.theta)
    .sort((a, b) => b.theta - a.theta)[0]
  if (!qualified) {
    if (n < minNMin) {
      return { gate: "off", basis: "n/a", note: `样本量 ${n} 低于任何档的 n_min，不评精度` }
    }
    return { gate: "off", basis: `p̂=${precision.toFixed(4)} 未达任何档`, note: "有证据表明精度不足" }
  }
  if (n < qualified.nMin) {
    return { gate: "off", basis: "n/a", note: `样本量 ${n} 低于 ${qualified.gate} 档要求的 ${qualified.nMin}` }
  }
  return { gate: qualified.gate, basis: `p̂=${precision.toFixed(4)} ≥ ${qualified.theta} 且 n=${n} ≥ ${qualified.nMin}`, note: "" }
}

/**
 * 对一批规则逐条打分。
 * @param labels buildLabels 的输出（含内存值）
 * @param ruleList [{name, kind, message_key, context?|keyboards?}]
 * @returns 每条规则 {n, tp, fp, fn, precision, recall, wilson, gate, by_field, by_project}
 */
// 规则的字段作用域：recall 只能在「这条规则本来管得着」的字段上算。
// 仲裁差量给的是「这个字段被人工改掉了」，不是「本该由哪条规则发现」——
// 所以 precision（命中里有多少是负例）定义良好，而全量负例上的 recall 没有意义：
// 空释义是 R5 的靶子，R1 抓不到它不算漏检。详见本文件的 README 第 3 节。
const SCOPES = {
  all: () => true,
  reading: (field, ctx) => ctx.readingFields.includes(field),
  ipa: (field, ctx) => ctx.ipaFields.includes(field),
  role_required: (field, ctx) => REQUIRED_ROLES.includes(ctx.roles?.[field])
}

const REQUIRED_ROLES = ["headword", "reading", "meaning"]

export function scoreRules(labels, ruleList) {
  // 伪分歧在样本层就已经被 `accepted` 挡掉了（`buildLabels` 给 unicode_equivalent 的一律
  // accepted: true，assist_baseline_integration.mjs 里钉着这条不变量），所以这里不再写
  // `&& reason_code !== "unicode_equivalent"`：那个合取项在当前实现下永不生效，还会让读者
  // 以为剔除伪分歧有第二道保险。排除但必须报数那一条走 equivalentCount。
  const negatives = new Set(labels.filter((item) => !item.accepted)
    .map((item) => `${item.attempt}\u0000${item.field}`))
  const inScope = (rule, field, ctx) => (SCOPES[rule.scope ?? "all"])(field, ctx)
  const equivalentCount = labels.filter((item) => item.reason_code === "unicode_equivalent").length
  // 这两份索引与规则无关（键是 attempt），却原来长在规则循环里：5 条规则就把全量 labels
  // 重建 5 遍，再对每个 attempt 做一次 `labels.filter` 全表扫，合起来是
  // O(规则数 × 样本数) + O(条目数 × 样本数)。今天的 fixture 看不出来，#179 下一步拿 #93
  // 试点的真实数据（1 万条目 / 5 万字段样本）跑就是亿级比较。提到循环外各建一次。
  const rowsByAttempt = new Map()
  const labelsByAttempt = new Map()
  for (const label of labels) {
    if (!rowsByAttempt.has(label.attempt)) rowsByAttempt.set(label.attempt, new Map())
    rowsByAttempt.get(label.attempt).set(label.field, label._submitted_value)
    if (!labelsByAttempt.has(label.attempt)) labelsByAttempt.set(label.attempt, [])
    labelsByAttempt.get(label.attempt).push(label)
  }
  const scored = []
  for (const rule of ruleList) {
    let tp = 0
    let fp = 0
    let fn = 0
    const byField = new Map()
    const byProject = new Map()
    for (const [attempt, fields] of rowsByAttempt) {
      const rowValues = Object.fromEntries(fields)
      const flagged = ruleFlagsRow(rule, rowValues)
      for (const label of labelsByAttempt.get(attempt)) {
        const hit = flagged.has(label.field)
        const negative = negatives.has(`${attempt}\u0000${label.field}`)
        // 分项的 fn 必须与规则级同一个作用域口径。原来两边不一样：规则级只数「本条规则管得着」
        // 的负例，分项却把所有负例都记成漏检，于是 by_field 的 fn 之和对不上 rule.fn——
        // ipa 域的 R2 会出现「规则级 fn=0，分项里挂着一条 `释义` 的漏检」这种相反结论。
        // tp/fp/hits 两边都不判作用域，维持原有一致性。
        const scopedNegative = negative && inScope(rule, label.field, rule.context)
        bump(byField, label.field, hit, negative, scopedNegative)
        bump(byProject, label.project, hit, negative, scopedNegative)
        if (hit && negative) tp += 1
        else if (hit && !negative) fp += 1
        // 只有落在本规则作用域里的负例才算「本该抓到而没抓到」。
        else if (!hit && scopedNegative) fn += 1
      }
    }
    const n = tp + fp
    const precision = n ? Number((tp / n).toFixed(4)) : 0
    const denominator = tp + fn
    scored.push({
      rule: rule.name,
      kind: rule.kind,
      message_key: rule.message_key,
      hits: n,
      tp, fp, fn,
      negative_samples: denominator,
      precision: n ? precision : null,
      recall: denominator ? Number((tp / denominator).toFixed(4)) : null,
      wilson: wilsonInterval(tp, n),
      gate: suggestGate(n, precision),
      by_field: Object.fromEntries(byField),
      by_project: Object.fromEntries(byProject)
    })
  }
  return { scored, unicode_equivalent_excluded: equivalentCount, samples: labels.length }
}

// `scopedNegative` 只管 fn：漏检要按规则作用域算，与 scoreRules 里规则级那一条同口径。
// tp/fp 仍然看未判作用域的 `negative`——那是「命中里有多少是真问题」，与作用域无关。
function bump(map, key, hit, negative, scopedNegative = negative) {
  const current = map.get(key) ?? { hits: 0, tp: 0, fp: 0, fn: 0 }
  if (hit) current.hits += 1
  if (hit && negative) current.tp += 1
  else if (hit) current.fp += 1
  else if (scopedNegative) current.fn += 1
  map.set(key, current)
  return current
}

// 报告纪律（门槛文件 §6）：合成与真实分两栏，不合并、不平均；
// 真实栏在数据到位前字面写 n/a；每个比率随附 n 与 Wilson 区间；标明能否外推。
export function renderReport(result, { synthetic, real, generatedAt, sourceNote }) {
  const lines = []
  lines.push(`# 辅助规则基线报告（${generatedAt}）`)
  lines.push("")
  lines.push(sourceNote)
  lines.push("")
  lines.push("## 合成样本指标（验证打分工具自身正确，不代表线上表现）")
  lines.push(ruleTable(synthetic))
  lines.push("")
  // 证据范围必须写在渲染器里，不能只手改生成出来的 .md——那份文件下一次重跑（#93 试点数据
  // 进来那一次）会被整份覆盖。表里只有弱标注粒度能度量的判据，缺哪几条要点名，否则单看这份
  // 报告（或引用它的 README §8「所有规则一律保持 off」）会以为覆盖面是完整的。
  lines.push("> 本表只列弱标注粒度 `(提交, 字段)` 能度量的判据；R3 列级 `mixed_normalization_forms`、"
    + "R4 `punctuation_mix`、R7 的两个判据不参与打分，**它们的档位决策不在本报告的证据范围内**"
    + "（理由见 `scripts/assist/README.md` §4）。")
  lines.push("")
  lines.push("## 真实样本指标")
  if (!real || !real.scored?.length) {
    lines.push("n/a —— 部署库内尚无真实分歧/仲裁样本。")
  } else {
    lines.push(ruleTable(real))
  }
  lines.push("")
  lines.push("## 假分歧隔离")
  lines.push(`被排除的 unicode_equivalent 负例：**${synthetic.unicode_equivalent_excluded}** 条`
    + `（主分析不含它们；这个数字本身量化 #174 的代价）。`)
  if (real?.unicode_equivalent_excluded !== undefined) {
    lines.push(`真实样本中：**${real.unicode_equivalent_excluded}** 条。`)
  }
  lines.push("")
  lines.push("## 能否外推")
  lines.push("不能。合成样本按已知陷阱构造，命中分布由构造方式决定；"
    + "真实分布要等 #93 试点的数据。两栏数字不得合并、不得平均、不得对外用作准确率承诺（#97）。")
  return `${lines.join("\n")}\n`
}

function ruleTable(result) {
  const header = "| 规则 | 命中 n | TP | FP | FN | precision | recall | Wilson 95% | 建议 gate | 依据 |"
  const row = (item) => `| ${item.rule} | ${item.hits} | ${item.tp} | ${item.fp} | ${item.fn} | `
    + `${item.precision ?? "n/a"} | ${item.recall ?? "n/a"} | `
    + `${item.wilson ? `[${item.wilson.lower}, ${item.wilson.upper}]` : "n/a"} | `
    + `${item.gate.gate} | ${item.gate.basis}${item.gate.note ? `；${item.gate.note}` : ""} |`
  return [header, "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...result.scored.map(row)].join("\n")
}
