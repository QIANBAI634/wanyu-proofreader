// #176 机器疑点的读取与门控。
//
// 这里的口径全部来自 docs/plans/2026-09-25-assist-rule-thresholds.md §2，改语义要同时改那份文件：
// - `gate` 是放行范围的「下限」，不是「恰好」：warn 与 strong 两档放行的集合相同，
//   差别只在 strong 是否高亮；
// - `info` 永不进校对端，只作管理端统计；
// - 登记表缺行按 `off` 处理（新规则初始一律 off，先有数据才有档位）。

// #176 期望结果 5：除 superseded_at 之外的字段一律不可改。
// 放在 lib 里而不是 hook 文件的顶层——PocketBase 的 JSVM 只在文件求值时保留顶层绑定，
// 回调真正执行时读不到同文件的顶层 const（会抛 ReferenceError）。
const IMMUTABLE_FINDING_FIELDS = [
  "project",
  "page",
  "field_name",
  "round",
  "kind",
  "severity",
  "message_key",
  "params_json",
  "evidence_json",
  "producer",
  "producer_version",
  "produced_at"
]

const GATE_RELEASES = {
  off: [],
  warn: ["warn", "strong"],
  strong: ["warn", "strong"]
}
const DEFAULT_GATE = "off"
// 一次读取里最多带回的 finding 条数；门控与统计页都不能把这张表当成无界来源。
// 校对端与统计端共用这一个上限：两个口各写一个数，早晚会只剩一个被人记得改。
// 超出时响应里带 truncated，绝不静默少给。
const MAX_PAGE_SIZE = 200
const MAX_GATE_ROWS = 2000
const FINDING_KINDS = [
  "char_out_of_repertoire", "confusable_substitution", "encoding_form_anomaly",
  "missing_field", "reading_format_invalid", "punctuation_mix", "page_outlier",
  "duplicate_identity", "cross_source_conflict", "merged_columns"
]
const PRODUCERS = ["rule", "ocr", "bundle_import"]

// 查询参数必须是**白名单值**，不能被拼进过滤表达式。
// 这两个参数直接来自 URL；拼进 filter 文本后，kind 里塞 `x") || (producer = "ocr`
// 会让 `&&` 的高优先级把后半段变成一条不受 project、也不受 superseded_at 约束的析取分支
// —— 任意项目的 manager 就能读全库疑点。枚举字段用白名单比转义引号更严也更短。
function enumParam(value, allowed) {
  const text = String(value ?? "").trim()
  return allowed.includes(text) ? text : ""
}

function identityOf(record) {
  return [
    record.getString("producer"),
    record.getString("producer_version"),
    record.getString("kind"),
    record.getString("message_key")
  ].join("\u0000")
}

function gateMap(dao, limit = MAX_GATE_ROWS) {
  const rows = dao.findRecordsByFilter("assist_rule_gates", "", "", limit, 0)
  if (rows.length >= limit) {
    // 截断方向是安全的（落不进 map 的规则按 off 处理，只会更不可见），
    // 但必须留痕，否则"某条规则突然不显示"会变成查不出来的幽灵。
    console.warn(`assist_rule_gates 读取被截断在 ${limit} 行，超出的规则一律按 off 处理`)
  }
  const map = new Map()
  for (const row of rows) map.set(identityOf(row), row)
  return map
}

function gateOf(gates, record) {
  const row = gates.get(identityOf(record))
  if (!row) return { gate: DEFAULT_GATE, row: null }
  const gate = row.getString("gate")
  // 登记表里出现未知值时按最保守的 off 处理，而不是放行。
  return { gate: GATE_RELEASES[gate] ? gate : DEFAULT_GATE, row }
}

function parseJson(value, fallback) {
  const text = String(value ?? "")
  if (!text) return fallback
  try {
    const parsed = JSON.parse(text)
    return parsed && typeof parsed === "object" ? parsed : fallback
  } catch {
    return fallback
  }
}

// 当前批次：未被 superseded 的那一批。重算只写新批次并标旧批次，
// 所以「未 superseded」本身就定义了当前批次（#176 期望结果 5）。
function currentRecords(dao, filter, sort, limit, offset) {
  const parts = [`superseded_at = ""`]
  if (filter) parts.push(`(${filter})`)
  return dao.findRecordsByFilter("review_findings", parts.join(" && "), sort, limit, offset)
}

function hintView(record, gate) {
  return {
    field: record.getString("field_name"),
    kind: record.getString("kind"),
    severity: record.getString("severity"),
    message: {
      key: record.getString("message_key"),
      params: parseJson(record.get("params_json"), {})
    },
    // 校对端只需要知道要不要高亮；档位本身不下发，避免把它当置信度读。
    highlight: record.getString("severity") === "strong" && gate === "strong",
    evidence: parseJson(record.get("evidence_json"), {})
  }
}

// 管理端口不下发 highlight：档位才是它要表达的东西，高亮是校对端的事。
// 注意不要写成 highlight: undefined —— goja 会把 undefined 转成 null 落进响应里。
function statisticsView(record, gate, row) {
  const view = hintView(record, gate)
  return {
    id: record.id,
    field: view.field,
    kind: view.kind,
    severity: view.severity,
    message: view.message,
    evidence: view.evidence,
    page: record.getString("page"),
    project: record.getString("project"),
    producer: record.getString("producer"),
    producer_version: record.getString("producer_version"),
    produced_at: record.getString("produced_at"),
    gate,
    gate_sample_n: row ? row.getInt("sample_n") : 0,
    gate_precision_hat: row ? Number(row.get("precision_hat") || 0) : null
  }
}

// 校对端：按 gate 与 severity 双重过滤后的 hints（#176 期望结果 4）。
function hintsForPage(dao, pageId) {
  const gates = gateMap(dao)
  const records = currentRecords(dao, `page = "${pageId}"`, "kind,message_key", MAX_PAGE_SIZE + 1, 0)
  const hints = []
  for (const record of records) {
    const { gate } = gateOf(gates, record)
    const severity = record.getString("severity")
    if (!GATE_RELEASES[gate].includes(severity)) continue
    hints.push(hintView(record, gate))
  }
  return { hints, truncated: records.length > MAX_PAGE_SIZE }
}

// 管理端：不做门控过滤，info 与 off 一律可见——门槛文件 §2 要求 off 只挡校对端，
// 「仍计算、仍写库、只在管理端统计」依赖这个读取口。
function listForProject(dao, projectId, { page = 1, per = 50, kind = "", producer = "" } = {}) {
  const clauses = [`project = "${projectId}"`]
  const safeKind = enumParam(kind, FINDING_KINDS)
  const safeProducer = enumParam(producer, PRODUCERS)
  if (safeKind) clauses.push(`kind = "${safeKind}"`)
  if (safeProducer) clauses.push(`producer = "${safeProducer}"`)
  const size = Math.max(1, Math.min(MAX_PAGE_SIZE, Number(per) || 50))
  const index = Math.max(1, Number(page) || 1)
  const gates = gateMap(dao)
  // 多取一条用来判断是否还有下一页，不依赖 count 查询。
  const records = currentRecords(dao, clauses.join(" && "), "-produced_at,kind,message_key", size + 1, (index - 1) * size)
  const items = records.slice(0, size).map((record) => {
    const { gate, row } = gateOf(gates, record)
    return statisticsView(record, gate, row)
  })
  return { items, hasMore: records.length > size, page: index, per: size }
}

module.exports = {
  DEFAULT_GATE,
  FINDING_KINDS,
  PRODUCERS,
  enumParam,
  IMMUTABLE_FINDING_FIELDS,
  GATE_RELEASES,
  MAX_PAGE_SIZE,
  identityOf,
  gateOf,
  gateMap,
  hintsForPage,
  listForProject
}
