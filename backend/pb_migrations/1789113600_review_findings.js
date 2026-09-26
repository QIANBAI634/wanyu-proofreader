// #176 — 机器疑点数据模型与门控登记表。
//
// review_findings 是 append-only 的：重算只写新批次并把旧批次标 superseded_at，
// 不覆写、不物理删除（对齐 #91「原始证据不可覆写」）。因此三个写规则全部 null，
// 只有服务端特权代码路径（hook / Go 作业）能写；读也一律走 /api/fangji 路由，
// 集合 API 不给 listRule/viewRule，避免绕过盲校与门控过滤。
//
// assist_rule_gates 承载 docs/plans/2026-09-25-assist-rule-thresholds.md §2.1 的
// 「gate 状态存在哪里」，以规则身份四元组为键；缺行按 off 处理。
const FINDING_KINDS = [
  "char_out_of_repertoire",
  "confusable_substitution",
  "encoding_form_anomaly",
  "missing_field",
  "reading_format_invalid",
  "punctuation_mix",
  "page_outlier",
  "duplicate_identity",
  "cross_source_conflict",
  "merged_columns"
]

const text = (name, required, id) => ({
  autogeneratePattern: "", hidden: false, id, max: 0, min: required ? 1 : 0,
  name, pattern: "", presentable: false, primaryKey: false, required, system: false, type: "text"
})
const select = (name, values, id) => ({
  hidden: false, id, maxSelect: 1, name, presentable: false, required: true,
  system: false, type: "select", values
})
const date = (name, required, id) => ({
  hidden: false, id, max: "", min: "", name, presentable: false, required,
  system: false, type: "date"
})
const number = (name, { required = false, min = null, max = null, onlyInt = true, id }) => ({
  hidden: false, id, max, min, name, onlyInt, presentable: false, required,
  system: false, type: "number"
})
const relation = (name, collectionId, id, cascadeDelete = true) => ({
  cascadeDelete, collectionId, hidden: false, id, maxSelect: 1, minSelect: 0,
  name, presentable: false, required: true, system: false, type: "relation"
})

const autoTimes = [
  { hidden: false, id: "autodate2990389176", name: "created", onCreate: true, onUpdate: false, presentable: false, system: false, type: "autodate" },
  { hidden: false, id: "autodate3332085495", name: "updated", onCreate: true, onUpdate: true, presentable: false, system: false, type: "autodate" }
]

const findingsSpec = (pagesId, projectsId) => ({
  name: "review_findings",
  type: "base",
  system: false,
  listRule: null,
  viewRule: null,
  createRule: null,
  updateRule: null,
  deleteRule: null,
  indexes: [
    "CREATE INDEX idx_findings_page_current ON review_findings (page, superseded_at)",
    "CREATE INDEX idx_findings_project_kind ON review_findings (project, kind)",
    "CREATE INDEX idx_findings_rule_identity ON review_findings (producer, producer_version, kind, message_key)"
  ],
  fields: [
    { autogeneratePattern: "[a-z0-9]{15}", hidden: false, id: "text3208210256", max: 15, min: 15, name: "id", pattern: "^[a-z0-9]+$", presentable: false, primaryKey: true, required: true, system: true, type: "text" },
    relation("project", projectsId, "rfproject1"),
    relation("page", pagesId, "rfpage0001"),
    text("field_name", false, "rffldname1"),
    number("round", { required: false, min: 1, max: null, id: "rfround001" }),
    select("kind", FINDING_KINDS, "rfkind0001"),
    select("severity", ["info", "warn", "strong"], "rfseverity"),
    text("message_key", true, "rfmsgkey01"),
    text("params_json", true, "rfparamsj1"),
    text("evidence_json", false, "rfevidence"),
    select("producer", ["rule", "ocr", "bundle_import"], "rfproducer"),
    text("producer_version", true, "rfprodver1"),
    date("produced_at", true, "rfprodctat"),
    date("superseded_at", false, "rfsupdat01"),
    ...autoTimes
  ]
})

const gatesSpec = () => ({
  name: "assist_rule_gates",
  type: "base",
  system: false,
  listRule: null,
  viewRule: null,
  createRule: null,
  updateRule: null,
  deleteRule: null,
  indexes: [
    "CREATE UNIQUE INDEX idx_gate_rule_identity ON assist_rule_gates (producer, producer_version, kind, message_key)"
  ],
  fields: [
    { autogeneratePattern: "[a-z0-9]{15}", hidden: false, id: "text3208210256", max: 15, min: 15, name: "id", pattern: "^[a-z0-9]+$", presentable: false, primaryKey: true, required: true, system: true, type: "text" },
    select("producer", ["rule", "ocr", "bundle_import"], "gtproducer"),
    text("producer_version", true, "gtprodver1"),
    select("kind", FINDING_KINDS, "gtkind0001"),
    text("message_key", true, "gtmsgkey01"),
    select("gate", ["strong", "warn", "off"], "gtgate0001"),
    number("sample_n", { required: false, min: 0, max: null, id: "gtsampln01" }),
    // p̂ 是 0..1 的比率，不是整数，onlyInt 必须为 false。
    { hidden: false, id: "gtprecisi1", max: 1, min: 0, name: "precision_hat", onlyInt: false, presentable: false, required: false, system: false, type: "number" },
    date("window_started_at", false, "gtwindowa1"),
    date("window_ended_at", false, "gtwindowb1"),
    date("evaluated_at", false, "gtevaluata"),
    text("note", false, "gtnote0001"),
    ...autoTimes
  ]
})

const exists = (app, name) => {
  try {
    app.findCollectionByNameOrId(name)
    return true
  } catch {
    return false
  }
}

migrate((app) => {
  const pages = app.findCollectionByNameOrId("pages")
  const projects = app.findCollectionByNameOrId("projects")
  const specs = []
  // 幂等：既有库已建过就跳过，全新库才导入。重复 import 会重建字段并换掉记录 id。
  if (!exists(app, "review_findings")) specs.push(findingsSpec(pages.id, projects.id))
  if (!exists(app, "assist_rule_gates")) specs.push(gatesSpec())
  if (specs.length) app.importCollections(specs, false)
}, (app) => {
  for (const name of ["assist_rule_gates", "review_findings"]) {
    if (!exists(app, name)) continue
    const collection = app.findCollectionByNameOrId(name)
    app.delete(collection)
  }
})
