// #228 规则门控的放行判据与写入通道。
//
// 这里是门槛口径在代码里的**唯一定义**：文档侧对应
// docs/plans/2026-09-25-assist-rule-thresholds.md §2/§5，打分器
// scripts/assist/lib/labeling.mjs 从本文件取常数。两侧各写一份迟早会漂，而漂了之后的
// 症状是「打分器建议 warn、写入侧按另一套 n_min 判成证据不足」，只能靠人肉发现。

const GATE_TIERS = ["strong", "warn", "off"]
// 放行严格度序。升档必须过判据；降档永远允许——kill switch 不该被判据挡住。
const TIER_RANK = { off: 0, warn: 1, strong: 2 }
const GATE_CRITERIA = [
  { gate: "strong", theta: 0.90, nMin: 100 },
  { gate: "warn", theta: 0.60, nMin: 150 }
]
const IDENTITY_FIELDS = ["producer", "producer_version", "kind", "message_key"]
// 四元组的每个分量都会被拼进过滤表达式，所以先按字符集挡一道：它们本来就是
// `rule` / `l0-v1` / `missing_field` / `required_role_field_empty` 这一类 token。
// 生产者、版本、kind、message_key 里出现引号或括号一律视为非法输入。
const IDENTITY_PATTERN = /^[A-Za-z0-9._:-]{1,64}$/
const MAX_CHANGESET_ENTRIES = 200
const APPROVER_MAX_LENGTH = 200

// 门槛文件 §3 的三分法：先问「证据够不够」，再问「精度达没达标」，
// 而且「够不够」是相对**该精度本来够格的那一档**的 n_min 说的——
// 拿全局最小 n_min 判会把 n=149、p̂=0.65 误报成「精度不足」，
// 而它其实是 warn 档的证据不足（warn 要 150）。两者处置不同：前者关规则，后者等证据。
function suggestGate(n, precision) {
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

function trimIdentityPart(entry, field) {
  return String(entry[field] ?? "").trim()
}

// 变更集条目必须自带完整四元组：`kind` 单独不够
// （`encoding_form_anomaly` 被两个语义完全不同的检测器共用）。
function validateEntry(entry, index) {
  const problems = []
  const label = `第 ${index + 1} 条`
  if (!entry || typeof entry !== "object") {
    return [`${label}不是对象`]
  }
  for (const field of IDENTITY_FIELDS) {
    const value = trimIdentityPart(entry, field)
    if (!value) problems.push(`${label}缺少 ${field}`)
    else if (!IDENTITY_PATTERN.test(value)) problems.push(`${label}的 ${field} 含非法字符`)
  }
  if (!GATE_TIERS.includes(entry.gate)) problems.push(`${label}的 gate 必须是 ${GATE_TIERS.join("/")}`)
  const sample = Number(entry.sample_n)
  if (!Number.isFinite(sample) || sample < 0) problems.push(`${label}的 sample_n 必须是非负数`)
  // precision_hat 允许 null（n=0 时无精度可谈），但给了就必须是 0..1 的比率。
  if (entry.precision_hat !== null && entry.precision_hat !== undefined) {
    const precision = Number(entry.precision_hat)
    if (!Number.isFinite(precision) || precision < 0 || precision > 1) {
      problems.push(`${label}的 precision_hat 必须是 0..1 的比率或 null`)
    }
  }
  const approver = String(entry.approved_by ?? "").trim()
  if (!approver) problems.push(`${label}缺少批准人 approved_by`)
  else if (approver.length > APPROVER_MAX_LENGTH) problems.push(`${label}的批准人过长`)
  if (!String(entry.approved_at ?? "").trim()) problems.push(`${label}缺少批准时间 approved_at`)
  return problems
}

// 判据不满足时不得放行（#228 验收标准第 4 条）。降档/关档不受此限。
function releaseCheck(entry) {
  const suggested = suggestGate(Number(entry.sample_n) || 0, Number(entry.precision_hat) || 0)
  if (entry.gate === "off") {
    return { allowed: true, reason: `关档不受判据约束（建议档 ${suggested.gate}）` }
  }
  if (TIER_RANK[suggested.gate] >= TIER_RANK[entry.gate]) {
    return { allowed: true, reason: suggested.basis }
  }
  return {
    allowed: false,
    reason: `证据不支持 ${entry.gate}：按 ${suggested.basis}${suggested.note ? `（${suggested.note}）` : ""} 只够 ${suggested.gate}`
  }
}

function findGateRow(app, entry) {
  const clauses = IDENTITY_FIELDS.map((field) => `${field} = "${trimIdentityPart(entry, field)}"`)
  return app.findRecordsByFilter("assist_rule_gates", clauses.join(" && "), "", 1, 0)
}

function stamp() {
  return new Date().toISOString()
}

function gateValues(record) {
  return {
    gate: record.getString("gate"),
    sample_n: record.getInt("sample_n"),
    precision_hat: record.get("precision_hat"),
    approved_by: record.getString("approved_by"),
    approved_at: record.getString("approved_at"),
    changeset: record.getString("changeset"),
    revoked_at: record.getString("revoked_at")
  }
}

function sameRelease(current, entry, changesetId) {
  // `current` 是 gateValues() 摊平后的普通对象，不是 Record——这里再调 .get() 会抛
  // "Object has no member 'get'"，把一次本该判成 unchanged 的重放变成 400。
  // 变更集身份在 payload 上，不在条目里，所以由调用方传进来。
  const wanted = entry.precision_hat === null || entry.precision_hat === undefined
    ? null : Number(entry.precision_hat)
  const stored = current.precision_hat === null || current.precision_hat === undefined
    ? null : Number(current.precision_hat)
  return current.gate === entry.gate
    && Number(current.sample_n) === Number(entry.sample_n)
    && (stored === null ? wanted === null : stored === wanted)
    && current.approved_by === String(entry.approved_by).trim()
    && current.changeset === String(changesetId ?? "")
}

// 把一份**已由人批准**的变更集应用到库。幂等：同一条变更集重放两次结果一致；
// 已被 revoke 的规则不再被抬升（#228 验收标准第 5 条）。
// 本函数不做任何自动放行判断——判据在这里只是"拒绝不合规的升档"，
// 决定升不升的仍然是产变更集与批准它的人。
function applyChangeset(app, payload, actor) {
  const entries = Array.isArray(payload && payload.entries) ? payload.entries : []
  const changeset = String((payload && payload.changeset) ?? "").trim()
  const result = {
    changeset,
    applied_by: actor ? actor.id : "",
    applied_at: stamp(),
    applied: 0, unchanged: 0, refused: 0, locked: 0,
    entries: []
  }
  if (!entries.length) throw new BadRequestError("变更集为空")
  if (entries.length > MAX_CHANGESET_ENTRIES) {
    throw new BadRequestError(`一次最多应用 ${MAX_CHANGESET_ENTRIES} 条，本次 ${entries.length} 条`)
  }
  const collection = app.findCollectionByNameOrId("assist_rule_gates")
  for (const [index, entry] of entries.entries()) {
    const identity = IDENTITY_FIELDS.map((field) => trimIdentityPart(entry || {}, field))
    const view = {
      producer: identity[0], producer_version: identity[1],
      kind: identity[2], message_key: identity[3]
    }
    const problems = validateEntry(entry, index)
    if (problems.length) {
      result.refused += 1
      result.entries.push({ ...view, action: "refused", reason: problems.join("；") })
      continue
    }
    const check = releaseCheck(entry)
    if (!check.allowed) {
      result.refused += 1
      result.entries.push({ ...view, action: "refused", reason: check.reason, gate: entry.gate })
      continue
    }
    const found = findGateRow(app, entry)
    if (!found.length) {
      if (entry.gate === "off") {
        // 从没登记过的规则「关到 off」是空操作。留一条 off 行反而会让 gateMap 多占一行，
        // 逼近 MAX_GATE_ROWS 时把真规则挤成静默 off，所以不落库、只报告。
        result.unchanged += 1
        result.entries.push({ ...view, action: "unchanged", gate: "off", reason: "该规则本就没有登记行，默认即 off" })
        continue
      }
      const record = new Record(collection)
      IDENTITY_FIELDS.forEach((field, position) => record.set(field, identity[position]))
      record.set("gate", entry.gate)
      record.set("sample_n", Number(entry.sample_n) || 0)
      record.set("precision_hat", entry.precision_hat === null || entry.precision_hat === undefined
        ? null : Number(entry.precision_hat))
      record.set("evaluated_at", String(entry.approved_at))
      record.set("approved_by", String(entry.approved_by).trim())
      record.set("approved_at", String(entry.approved_at))
      record.set("changeset", changeset)
      record.set("applied_by", result.applied_by)
      app.save(record)
      result.applied += 1
      result.entries.push({ ...view, action: "created", gate: entry.gate, reason: check.reason })
      continue
    }
    const existing = found[0]
    const current = gateValues(existing)
    // 人工降过档的规则：同一个变更集重放不许把它抬回去。
    if (entry.gate !== "off" && current.revoked_at) {
      result.locked += 1
      result.entries.push({
        ...view, action: "locked", gate: current.gate,
        reason: `该规则已于 ${current.revoked_at} 被人工降档，重放变更集不再抬升；要恢复需显式新发一条变更集并撤销降档`
      })
      continue
    }
    if (sameRelease(current, entry, changeset)) {
      result.unchanged += 1
      result.entries.push({ ...view, action: "unchanged", gate: current.gate })
      continue
    }
    existing.set("gate", entry.gate)
    existing.set("sample_n", Number(entry.sample_n) || 0)
    existing.set("precision_hat", entry.precision_hat === null || entry.precision_hat === undefined
      ? null : Number(entry.precision_hat))
    existing.set("evaluated_at", String(entry.approved_at))
    existing.set("approved_by", String(entry.approved_by).trim())
    existing.set("approved_at", String(entry.approved_at))
    existing.set("changeset", changeset)
    existing.set("applied_by", result.applied_by)
    app.save(existing)
    result.applied += 1
    result.entries.push({ ...view, action: "updated", gate: entry.gate, reason: check.reason })
  }
  return result
}

// kill switch：把一条规则改回 off 并留下「谁在什么时候因为什么降档」。
// 幂等——已经 off 且已标记的规则再撤一次不产生新状态。
// restore 只清除降档标记、**不改 gate**：要把规则抬回去仍然必须再发一份变更集，
// 否则这个口就成了绕过判据的第二条升档路径。
function revokeGate(app, identityParts, actor, note, restore = false) {
  const entry = {}
  IDENTITY_FIELDS.forEach((field, position) => { entry[field] = identityParts[position] })
  const problems = IDENTITY_FIELDS
    .filter((field) => !trimIdentityPart(entry, field) || !IDENTITY_PATTERN.test(trimIdentityPart(entry, field)))
    .map((field) => `${field} 非法`)
  if (problems.length) throw new BadRequestError(problems.join("；"))
  const found = findGateRow(app, entry)
  if (!found.length) {
    return { action: "unchanged", gate: "off", reason: "该规则没有登记行，默认即 off" }
  }
  const record = found[0]
  if (restore) {
    if (!record.getString("revoked_at")) {
      return { action: "unchanged", gate: record.getString("gate"), reason: "该规则没有被人工降档，无需撤销" }
    }
    record.set("revoked_at", "")
    record.set("revoked_by", "")
    if (note) record.set("note", String(note).slice(0, 500))
    app.save(record)
    return { action: "restored", gate: record.getString("gate"), reason: "降档标记已清除；升档仍需新的变更集" }
  }
  if (record.getString("gate") === "off" && record.getString("revoked_at")) {
    return { action: "unchanged", gate: "off", revoked_at: record.getString("revoked_at") }
  }
  record.set("gate", "off")
  record.set("revoked_at", stamp())
  record.set("revoked_by", actor ? actor.id : "")
  if (note) record.set("note", String(note).slice(0, 500))
  app.save(record)
  return { action: "revoked", gate: "off", revoked_at: record.getString("revoked_at") }
}

// 门控登记表全貌。这张表是全局的（规则身份跨项目共用），所以只给平台管理员看。
// 截断必须有可判定信号：静默按 off 处理会让"某条规则突然不显示"变成查不出来的幽灵。
function gateListView(app, { limit = 200, offset = 0 } = {}) {
  const coverage = require(`${__hooks}/lib/rule_coverage.js`)
  const size = Math.max(1, Math.min(1000, Number(limit) || 200))
  const start = Math.max(0, Number(offset) || 0)
  const rows = app.findRecordsByFilter("assist_rule_gates", "", "-approved_at,kind", size + 1, start)
  const items = rows.slice(0, size).map((record) => ({
    producer: record.getString("producer"),
    producer_version: record.getString("producer_version"),
    kind: record.getString("kind"),
    message_key: record.getString("message_key"),
    gate: record.getString("gate"),
    sample_n: record.getInt("sample_n"),
    precision_hat: record.get("precision_hat") === null ? null : Number(record.get("precision_hat")),
    evaluated_at: record.getString("evaluated_at"),
    approved_by: record.getString("approved_by"),
    approved_at: record.getString("approved_at"),
    changeset: record.getString("changeset"),
    applied_by: record.getString("applied_by"),
    revoked_at: record.getString("revoked_at"),
    revoked_by: record.getString("revoked_by"),
    note: record.getString("note"),
    // #254 第 3 件事：这张表以前只说得出"当前档位与样本数"，于是"有通道、等证据"
    // 与"现有流程永远拿不到档位"在两栏数字上长得一模一样。通道值仍由
    // rule_coverage 单一定义算出，这里不另写一份判据。
    // 必须摊平成普通对象再查：`channelOf` 读的是 `entry.producer_version` 这类属性，
    // 而 goja 侧的 Record 只有 getString()——直接把 Record 传进去，每个字段都是
    // undefined，于是所有行都退化成 `unknown`（这条正是被门控表那组断言抓出来的）。
    scoring_channel: coverage.channelOf({
      producer_version: record.getString("producer_version"),
      kind: record.getString("kind"),
      message_key: record.getString("message_key")
    })
  }))
  return { items, truncated: rows.length > size, limit: size, offset: start }
}

module.exports = {
  APPROVER_MAX_LENGTH,
  GATE_CRITERIA,
  GATE_TIERS,
  IDENTITY_FIELDS,
  MAX_CHANGESET_ENTRIES,
  TIER_RANK,
  applyChangeset,
  gateListView,
  releaseCheck,
  revokeGate,
  suggestGate,
  validateEntry
}
