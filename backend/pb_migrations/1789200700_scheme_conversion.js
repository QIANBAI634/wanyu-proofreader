// #190 拼音转换的运行面：一条目一个当前结论（落在 pages），一批一个作业（新集合）。
//
// 索引只留队列那一条。「规则升版后列出受影响记录」是一次罕见的运维查询，
// 为它再往 pages 上挂一个索引不值：pages 是导入热路径上写入最频繁的表，
// 每加一条索引都要在每次插入时维护，而这条查询只在升版那一刻跑一次。
// 那条查询按项目扫一遍即可，已写成离线查询（见 docs/plans/2026-10-03-scheme-kernel.md）。
//
// 为什么结论落在 pages 而不是独立的结果集合：本仓已经不止一次把「派生值」物化在
// pages 上（difficulty_tier、entry_identity_key、quality_state），理由都是同一个——
// 它们要能被筛、被排序、被导出直读，而派生集合会让每一次读取都多一次 join 或回查。
// 规范化结论同时要被「复核队列」（按状态筛）与 #184 的导出（逐行给值）读，正好是这一类的。
//
// 为什么四个取值里 REVIEWED 与 EXACT 都要留 canonical_pronunciation：
// #281 的引擎已经立下不变式「只有 EXACT 与 REVIEWED 能带值」，这里沿用，不另立一套。
//
// 作业侧：conversion_jobs 与 import_jobs 同层但不同表。不复用 import_jobs 是因为
// 那张表的语义是「导入一个文件」，塞进「转换已有条目」会让 mode 与状态机长出第二层含义。
//
// down 只删这些列、索引与整张 conversion_jobs：规范化结论与人工复核结论都会一起丢掉，
// 要撤掉更早的迁移先备份 pb_data。

// 队列索引带 page_number, id，而不是只带 (project, normalization_status)。
// 这不是「多带两列更保险」，是实测出来的：复核队列的生产查询是
//   FindRecordsByFilter("pages", filter, "page_number,id", size, offset, params)
// （backend/scheme_conversion.go 的 listNormalizations），它带 ORDER BY page_number, id
// 与 LIMIT/OFFSET。本机 SQLite 对两种索引形状的 EXPLAIN QUERY PLAN：
//   (project, normalization_status)                 → SEARCH pages USING INDEX idx_pages_project_page_number (project=?)
//                                                     USE TEMP B-TREE FOR RIGHT PART OF ORDER BY
//   (project, normalization_status, page_number, id) → SEARCH pages USING COVERING INDEX idx_pages_normalization_queue
// 也就是说两列的版本**根本没被用上**，排序还得现搭临时 B 树；四列的版本既能选索引又是覆盖索引。
// check_migrations.py 里那条计划断言现在按生产查询的形状写，所以这个错误不会再溜过去。
const QUEUE_INDEX = "CREATE INDEX idx_pages_normalization_queue ON pages (project, normalization_status, page_number, id)"
const ACTIVE_INDEX = "CREATE UNIQUE INDEX idx_conversion_jobs_active ON conversion_jobs (project) WHERE status IN ('queued','processing')"
const JOB_INDEX = "CREATE INDEX idx_conversion_jobs_project ON conversion_jobs (project, created DESC)"

const STATUSES = ["EXACT", "REVIEWED", "AMBIGUOUS", "UNSUPPORTED"]
const JOB_STATUSES = ["queued", "processing", "completed", "completed_with_errors", "failed"]

// normalization_reviewed_by 存用户 id（15 码）而不是 relation：与 #228 的 approved_by、
// #172 的 quality_state_by 同一口径——人删了，改动痕迹还在。
const pageFields = [
  { build: () => new TextField({ name: "source_scheme_id", required: false, max: 200 }), remove: "source_scheme_id" },
  // 记音列名逐条记下来：项目的列角色可以改（#170），只存作业级的列名会让
  // 「这一条当时转的是哪一列」在改过列角色之后无从回答。
  { build: () => new TextField({ name: "normalization_source_column", required: false, max: 200 }),
    remove: "normalization_source_column" },
  { build: () => new TextField({ name: "canonical_scheme_id", required: false, max: 200 }), remove: "canonical_scheme_id" },
  { build: () => new TextField({ name: "canonical_pronunciation", required: false, max: 200 }),
    remove: "canonical_pronunciation" },
  // 转换那一刻读到的源值副本。复核队列与例外草案都要显示「这条结论是针对哪个原值下的」，
  // 而现读 proofread_row_json 会随校对改动而变——一条已经定过的结论，它针对的对象却会
  // 在背地里被换掉。所以转换时把值抄一份存下来，之后一律读这一份。
  // **刻意不给 max**：它是源单元格的副本，源那一列本身没有长度上限，给它加 max 只会
  // 新造一个「批次处理到某条就 Save 失败」的理由，而失败的那条恰恰是行长的那条。
  { build: () => new TextField({ name: "normalization_source_snapshot", required: false }),
    remove: "normalization_source_snapshot" },
  { build: () => new SelectField({ name: "normalization_status", maxSelect: 1, values: STATUSES, required: false }),
    remove: "normalization_status" },
  { build: () => new TextField({ name: "normalization_rule_version", required: false, max: 120 }),
    remove: "normalization_rule_version" },
  { build: () => new TextField({ name: "normalization_trace_json", required: false }), remove: "normalization_trace_json" },
  { build: () => new TextField({ name: "normalization_candidates_json", required: false }),
    remove: "normalization_candidates_json" },
  { build: () => new TextField({ name: "normalization_basis", required: false, max: 500 }), remove: "normalization_basis" },
  { build: () => new TextField({ name: "normalization_reviewed_by", required: false, max: 40 }),
    remove: "normalization_reviewed_by" },
  { build: () => new DateField({ name: "normalization_reviewed_at", required: false }),
    remove: "normalization_reviewed_at" }
]

const autoTimes = [
  { hidden: false, id: "autodate2990389176", name: "created", onCreate: true, onUpdate: false, presentable: false, system: false, type: "autodate" },
  { hidden: false, id: "autodate3332085495", name: "updated", onCreate: true, onUpdate: true, presentable: false, system: false, type: "autodate" }
]

const jobsSpec = (projectsId, usersId) => ({
  name: "conversion_jobs",
  type: "base",
  system: false,
  // 规则全 null：写入一律走 #190 的 manager 路由，与 finding_dismissals、assist_rule_gates 同口径。
  listRule: null,
  viewRule: null,
  createRule: null,
  updateRule: null,
  deleteRule: null,
  indexes: [ACTIVE_INDEX, JOB_INDEX],
  fields: [
    { autogeneratePattern: "[a-z0-9]{15}", hidden: false, id: "text3208210256", max: 15, min: 15, name: "id", pattern: "^[a-z0-9]+$", presentable: false, primaryKey: true, required: true, system: true, type: "text" },
    { cascadeDelete: true, collectionId: projectsId, hidden: false, id: "cvproject01", maxSelect: 1, minSelect: 0, name: "project", presentable: false, required: true, system: false, type: "relation" },
    { cascadeDelete: false, collectionId: usersId, hidden: false, id: "cvcreated01", maxSelect: 1, minSelect: 0, name: "created_by", presentable: false, required: false, system: false, type: "relation" },
    { hidden: false, id: "cvsource01", maxSelect: 1, name: "source_scheme", presentable: false, required: true, system: false, type: "text", min: 1, max: 200, pattern: "", autogeneratePattern: "", primaryKey: false },
    { hidden: false, id: "cvtarget01", maxSelect: 1, name: "canonical_scheme", presentable: false, required: true, system: false, type: "text", min: 1, max: 200, pattern: "", autogeneratePattern: "", primaryKey: false },
    { hidden: false, id: "cvrule0001", maxSelect: 1, name: "rule_version", presentable: false, required: true, system: false, type: "text", min: 1, max: 120, pattern: "", autogeneratePattern: "", primaryKey: false },
    { hidden: false, id: "cvstatus01", maxSelect: 1, name: "status", presentable: false, required: true, system: false, type: "select", values: JOB_STATUSES },
    { hidden: false, id: "cvtotals01", max: null, min: 0, name: "total_count", onlyInt: true, presentable: false, required: false, system: false, type: "number" },
    { hidden: false, id: "cvexact001", max: null, min: 0, name: "exact_count", onlyInt: true, presentable: false, required: false, system: false, type: "number" },
    { hidden: false, id: "cvreview01", max: null, min: 0, name: "reviewed_count", onlyInt: true, presentable: false, required: false, system: false, type: "number" },
    { hidden: false, id: "cvambig001", max: null, min: 0, name: "ambiguous_count", onlyInt: true, presentable: false, required: false, system: false, type: "number" },
    { hidden: false, id: "cvunsup001", max: null, min: 0, name: "unsupported_count", onlyInt: true, presentable: false, required: false, system: false, type: "number" },
    // skipped 与 failed 是两件事：前者是「这一条没有可转换的值 / 已经有人复核过」，
    // 不是失败；后者是写入出错。混成一个数会让四行汇总解释不了差额。
    { hidden: false, id: "cvskip0001", max: null, min: 0, name: "skipped_count", onlyInt: true, presentable: false, required: false, system: false, type: "number" },
    { hidden: false, id: "cvfail0001", max: null, min: 0, name: "failed_count", onlyInt: true, presentable: false, required: false, system: false, type: "number" },
    // cursor 记「已处理到的 page_number」。本仓既有的恢复语义是整件重跑，而转换重跑会
    // 让四行汇总翻倍，所以这个作业自带断点；重跑时从 cursor 续，不从头再数一遍。
    { hidden: false, id: "cvcursor01", max: null, min: 0, name: "cursor", onlyInt: true, presentable: false, required: false, system: false, type: "number" },
    { hidden: false, id: "cvstarted1", max: "", min: "", name: "started_at", presentable: false, required: false, system: false, type: "date" },
    { hidden: false, id: "cvfinish01", max: "", min: "", name: "finished_at", presentable: false, required: false, system: false, type: "date" },
    { hidden: false, id: "cverrcode1", max: 0, min: 0, name: "error_code", presentable: false, required: false, system: false, type: "text", pattern: "", autogeneratePattern: "", primaryKey: false },
    { hidden: false, id: "cverrmsg01", max: 0, min: 0, name: "error_message", presentable: false, required: false, system: false, type: "text", pattern: "", autogeneratePattern: "", primaryKey: false },
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
  let pagesChanged = false
  for (const field of pageFields) {
    if (pages.fields.getByName(field.remove)) continue // 幂等：既有库已加过就不重复加
    pages.fields.add(field.build())
    pagesChanged = true
  }
  for (const sql of [QUEUE_INDEX]) {
    const marker = sql.split(" ")[2]
    if (pages.indexes.some((existing) => existing.includes(marker))) continue
    pages.indexes = [...pages.indexes, sql]
    pagesChanged = true
  }
  if (pagesChanged) app.save(pages)

  if (!exists(app, "conversion_jobs")) {
    const projects = app.findCollectionByNameOrId("projects")
    const users = app.findCollectionByNameOrId("users")
    app.importCollections([jobsSpec(projects.id, users.id)], false)
  }
}, (app) => {
  if (exists(app, "conversion_jobs")) app.delete(app.findCollectionByNameOrId("conversion_jobs"))

  const pages = app.findCollectionByNameOrId("pages")
  for (const field of pageFields) {
    if (pages.fields.getByName(field.remove)) pages.fields.removeByName(field.remove)
  }
  pages.indexes = pages.indexes.filter((sql) => !sql.includes("idx_pages_normalization_"))
  app.save(pages)
})
