// #172 条目质量状态 v0：pages 追加与 status 正交的 quality_state，以及最小的审计三列。
//
// 为什么落 pages 而不是走 finding 机制：本 issue 的验收要求管理端能按
// candidate / validated / withheld 筛出条目，并要求 #184 的导出与 #96 的 bundle
// 默认排除 withheld。那是一个 SQL 谓词加一个导出列，必须可索引、必须能被 Go 侧的
// 流式导出直接读到；走 findings 现算既建不了索引，也会让导出在流式路径里回查第二张表。
//
// 三列审计只保留**最近一次**变更，不是历史链：
// 完整的字段级审计（原值→新值、决定取自哪份结果）是 #185 的独立范围。本 v0 只要求
// 「不能只改一个裸枚举而没有理由」，所以记 who / when / basis 三列。后来者若需要
// 追历史，应当去 #185，而不是把这三列当成审计流水。
//
// 缺省语义：字段 required=false，空值一律当 candidate。理由不是「懒得回填」，而是
// 既有的导入与校对创建路径有多处直接 app.save 建 pages，把列设成必填会让它们全部在
// 校验期失败——那等于把一个数据质量问题变成一次导入中断。存量行由本迁移显式回填，
// 新行由 Go 侧 OnRecordCreate 归一（backend/quality_state.go），因此库里不会留空值，
// 汇总的 GROUP BY 不需要 COALESCE。

const STATES = ["candidate", "validated", "withheld"]
const INDEX_SQL = "CREATE INDEX idx_pages_project_quality ON pages (project, quality_state)"

// 审计列用 TextField 存用户 id（15 码），与 #228 的 approved_by / applied_by 同一做法：
// relation 字段会跟着 users 级联语义走，而审计列的价值恰恰在于「人删了，改动痕迹还在」。
const added = [
  { build: () => new SelectField({ name: "quality_state", maxSelect: 1, values: STATES, required: false }),
    remove: "quality_state" },
  { build: () => new TextField({ name: "quality_state_by", required: false, max: 40 }),
    remove: "quality_state_by" },
  { build: () => new DateField({ name: "quality_state_at", required: false }),
    remove: "quality_state_at" },
  { build: () => new TextField({ name: "quality_state_basis", required: false, max: 500 }),
    remove: "quality_state_basis" }
]

const hasField = (pages, name) => Boolean(pages.fields.getByName(name))

migrate((app) => {
  const pages = app.findCollectionByNameOrId("pages")
  let changed = false
  for (const field of added) {
    if (hasField(pages, field.remove)) continue // 幂等：既有库已加过就不重复加
    pages.fields.add(field.build())
    changed = true
  }
  if (!pages.indexes.some((sql) => sql.includes("idx_pages_project_quality"))) {
    pages.indexes = [...pages.indexes, INDEX_SQL]
    changed = true
  }
  if (changed) app.save(pages)

  // 回填存量行。WHERE 只命中空值，所以重复执行不会覆盖任何人工设过的状态。
  // 本迁移出现在 #172 之前的所有库上都不应报错：列刚由上面的 save 建出来。
  app.db().newQuery("UPDATE pages SET quality_state = 'candidate' WHERE quality_state IS NULL OR quality_state = ''").execute()
}, (app) => {
  const pages = app.findCollectionByNameOrId("pages")
  let changed = false
  for (const field of added) {
    if (!hasField(pages, field.remove)) continue
    // down 会连同这四列的数据一起丢掉（迁移回滚即放弃质量状态标注），
    // 与 #228 的审计列 down 同一口径：只删列，不试图把标注搬到别处。
    pages.fields.removeByName(field.remove)
    changed = true
  }
  pages.indexes = pages.indexes.filter((sql) => !sql.includes("idx_pages_project_quality"))
  app.save(pages)
})
