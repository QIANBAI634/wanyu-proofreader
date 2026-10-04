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

// 返回 { map, truncated }：截断与否必须是可判定的返回值，不能只留一条 console.warn。
// 校对端与管理端都靠它把「读不全」这件事如实告诉调用方——否则某条规则突然不显示
// 就成了查不出来的幽灵（#228 验收标准第 7 条）。
function gateMap(dao, limit = MAX_GATE_ROWS) {
  const rows = dao.findRecordsByFilter("assist_rule_gates", "", "", limit + 1, 0)
  const truncated = rows.length > limit
  if (truncated) {
    console.warn(`assist_rule_gates 读取被截断在 ${limit} 行，超出的规则一律按 off 处理`)
  }
  const map = new Map()
  for (const row of rows.slice(0, limit)) map.set(identityOf(row), row)
  return { map, truncated }
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

// 疑点挂靠条目的定位信息（只含条目号与 PDF 页号，不含单元格正文——契约 §6）。
//
// 管理端此前只下发 `page`（记录 id），而 id 在人眼里不可读，管理员看完一批疑点
// 仍然不知道去哪一条核对。取不到就留 null：`page` 是指向 pages 的 relation 且
// cascadeDelete=true，条目删除会连带删掉疑点，所以库里不存在悬挂引用，
// null 只可能是"该条没有 pdf_page（CSV 直接导入）"或读取异常，两者都由前端说成未知。
// 同一次请求里一批疑点常挂在同几条上，所以带 cache，不做 N 次重复查库。
function locatorOf(app, pageId, cache) {
  const unknown = { page_number: null, pdf_page: null }
  const id = String(pageId ?? "")
  if (!id) return unknown
  if (cache && cache.has(id)) return cache.get(id)
  let value = unknown
  try {
    const entry = app.findRecordById("pages", id)
    // number 字段未填时 goja 读到 null/""，而 pdf_page 的 min=1 ⇒ 0 一律当「未挂靠」。
    const asOrdinal = (raw) => {
      const n = Number(raw)
      return Number.isInteger(n) && n > 0 ? n : null
    }
    value = {
      page_number: asOrdinal(entry.get("page_number")),
      pdf_page: asOrdinal(entry.get("pdf_page"))
    }
  } catch {
    value = unknown
  }
  if (cache) cache.set(id, value)
  return value
}

// 管理端口不下发 highlight：档位才是它要表达的东西，高亮是校对端的事。
// 注意不要写成 highlight: undefined —— goja 会把 undefined 转成 null 落进响应里。
function statisticsView(record, gate, row, locator) {
  const view = hintView(record, gate)
  const coverage = require(`${__hooks}/lib/rule_coverage.js`)
  return {
    id: record.id,
    field: view.field,
    kind: view.kind,
    severity: view.severity,
    message: view.message,
    evidence: view.evidence,
    page: record.getString("page"),
    page_number: locator.page_number,
    pdf_page: locator.pdf_page,
    project: record.getString("project"),
    producer: record.getString("producer"),
    producer_version: record.getString("producer_version"),
    produced_at: record.getString("produced_at"),
    gate,
    // #254：`off` 有两种，界面必须说得出是哪一种——"有通道、等证据"与
    // "现有通道量不到精度"读起来都像"再等等"，但后者永远等不到。
    // 通道只下发给管理端：hintView（校对口）不带它，校对员不需要知道
    // 自己手上这条能不能打分，那是放行侧的事。
    scoring_channel: coverage.channelOf({
      producer_version: record.getString("producer_version"),
      kind: record.getString("kind"),
      message_key: record.getString("message_key")
    }),
    gate_sample_n: row ? row.getInt("sample_n") : 0,
    gate_precision_hat: row ? Number(row.get("precision_hat") || 0) : null
  }
}

// 校对端：按 gate 与 severity 双重过滤后的 hints（#176 期望结果 4）。
//
// `suppressed_by_gate` 是「本条目上有 warn/strong 级疑点，但所在规则档位没放行」的条数。
// 它存在的唯一理由是把「没下发」与「没疑点」这两件事在字段级分开（#228 验收标准第 6 条）：
// 只有 hints 数组时，gate 全 off 与这批资料真的干净，在响应里长得一模一样，
// 而后者会被读成「这批可以放心」。它只是一个计数，不含规则身份、不含内容，
// 因此不触碰盲校纪律（校对端仍看不到别人的结果、轮次与档位）。
function hintsForPage(dao, pageId) {
  const { map: gates, truncated: gateTruncated } = gateMap(dao)
  const records = currentRecords(dao, `page = "${pageId}"`, "kind,message_key", MAX_PAGE_SIZE + 1, 0)
  const hints = []
  let suppressed = 0
  for (const record of records) {
    const { gate } = gateOf(gates, record)
    const severity = record.getString("severity")
    if (!GATE_RELEASES[gate].includes(severity)) {
      // info 级本来就不进校对端（门槛文件 §2），不该混进「被门控挡住」这个数字里。
      if (gate === "off" && GATE_RELEASES.warn.includes(severity)) suppressed += 1
      continue
    }
    hints.push(hintView(record, gate))
  }
  return {
    hints,
    truncated: records.length > MAX_PAGE_SIZE,
    suppressed_by_gate: suppressed,
    gate_rows_truncated: gateTruncated
  }
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
  const { map: gates, truncated: gateTruncated } = gateMap(dao)
  // 多取一条用来判断是否还有下一页，不依赖 count 查询。
  const records = currentRecords(dao, clauses.join(" && "), "-produced_at,kind,message_key", size + 1, (index - 1) * size)
  const locatorCache = new Map()
  const items = records.slice(0, size).map((record) => {
    const { gate, row } = gateOf(gates, record)
    return statisticsView(record, gate, row, locatorOf(dao, record.getString("page"), locatorCache))
  })
  return { items, hasMore: records.length > size, page: index, per: size, gate_rows_truncated: gateTruncated }
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
  locatorOf,
  hintsForPage,
  listForProject
}
