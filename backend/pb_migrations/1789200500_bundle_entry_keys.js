// #183 Review Bundle 导入幂等所需的键：条目级自然键落在 pages 上，包身份落在 import_jobs 上。
//
// 为什么自然键要带上 source_version，而不是只有 (source_system, source_id)：
// 本 issue 的验收要求「同 entry_id 新 source_version → 旧条目与新条目均可追溯」，
// 也就是版本变化必须产生**新条目**、不得静默覆盖旧条目。键里带上版本，这条规则就是
// 唯一索引的自然结果，不需要在业务代码里再写一遍「先查再比」——那种写法在并发下
// 本来也要靠索引兜底，多写的只是第二份判据。
//
// 为什么是部分唯一索引（WHERE source_entry_id != ''）：
// 存量 pages 没有来源键。建成无条件唯一索引时，它们会在空串上互相冲突，
// 而验收要求「迁移对既有 pages（无来源键）安全：这些行标 source:unknown 而不是被拒」。
// 空串表示「这一行没有来源登记」，与导入时 source_link 的 unknown 语义一致。
//
// 幂等重放的另一半在 Go 侧（backend/bundle_import.go）：同一
// (project, bundle_id) 且未失败的作业直接返回原结果，不新建作业；
// 作业中途重启后重新入队时，已经写进去的条目会被同一把唯一索引挡住——所以
// 「批次断点」不需要额外的游标表，自然键本身就是游标。
//
// down 只删这几列与两个索引：来源键一旦删掉就无法从条目本身恢复（它是外部系统的事实，
// 不是本库推导出来的），要撤掉更早的迁移，先备份 pb_data。

const PAGE_INDEX = "CREATE UNIQUE INDEX idx_pages_source_entry ON pages (project, source_system, source_id, source_version, source_entry_id) WHERE source_entry_id != ''"
// 部分唯一索引，谓词有两段，缺一不可：
// - `status != 'failed'`：「同一批只允许有一个未失败的作业」，但失败之后可以再建一个新的
//   （bundle_id 是来源侧身份，上游不能随意改，把 failed 也算进唯一性等于让瞬时失败的
//   批次永久无法重试）。
// - `bundle_id != ''`：**CSV / OCR 作业的 bundle_id 是空串**。少了这一段，同一项目里的
//   第二个 CSV 作业就会在 (project, '') 上与第一个撞唯一约束，整条 CSV 导入全线 400。
//   与 pages 那条部分唯一索引同一个理由：空值表示「这一行没有这个键」，不是「键都叫空」。
const JOB_INDEX = "CREATE UNIQUE INDEX idx_import_jobs_bundle ON import_jobs (project, bundle_id) WHERE status != 'failed' AND bundle_id != ''"

const pageFields = [
  { build: () => new TextField({ name: "source_system", required: false, max: 200 }), remove: "source_system" },
  { build: () => new TextField({ name: "source_id", required: false, max: 200 }), remove: "source_id" },
  { build: () => new TextField({ name: "source_version", required: false, max: 200 }), remove: "source_version" },
  { build: () => new TextField({ name: "source_entry_id", required: false, max: 200 }), remove: "source_entry_id" }
]

const jobFields = [
  { build: () => new TextField({ name: "bundle_id", required: false, max: 200 }), remove: "bundle_id" },
  { build: () => new TextField({ name: "bundle_schema_version", required: false, max: 80 }), remove: "bundle_schema_version" }
]

const addFields = (collection, fields) => {
  let changed = false
  for (const field of fields) {
    if (collection.fields.getByName(field.remove)) continue // 幂等：既有库已加过就不重复加
    collection.fields.add(field.build())
    changed = true
  }
  return changed
}

migrate((app) => {
  const pages = app.findCollectionByNameOrId("pages")
  let pagesChanged = addFields(pages, pageFields)
  if (!pages.indexes.some((sql) => sql.includes("idx_pages_source_entry"))) {
    pages.indexes = [...pages.indexes, PAGE_INDEX]
    pagesChanged = true
  }
  if (pagesChanged) app.save(pages)

  const jobs = app.findCollectionByNameOrId("import_jobs")
  let jobsChanged = addFields(jobs, jobFields)
  const modeField = jobs.fields.find((field) => field.name === "mode")
  if (modeField && !modeField.values.includes("bundle")) {
    modeField.values = [...modeField.values, "bundle"]
    jobsChanged = true
  }
  if (!jobs.indexes.some((sql) => sql.includes("idx_import_jobs_bundle"))) {
    jobs.indexes = [...jobs.indexes, JOB_INDEX]
    jobsChanged = true
  }
  if (jobsChanged) app.save(jobs)
}, (app) => {
  const pages = app.findCollectionByNameOrId("pages")
  for (const field of pageFields) {
    if (pages.fields.getByName(field.remove)) pages.fields.removeByName(field.remove)
  }
  pages.indexes = pages.indexes.filter((sql) => !sql.includes("idx_pages_source_entry"))
  app.save(pages)

  const jobs = app.findCollectionByNameOrId("import_jobs")
  for (const field of jobFields) {
    if (jobs.fields.getByName(field.remove)) jobs.fields.removeByName(field.remove)
  }
  const modeField = jobs.fields.find((field) => field.name === "mode")
  if (modeField) modeField.values = modeField.values.filter((value) => value !== "bundle")
  jobs.indexes = jobs.indexes.filter((sql) => !sql.includes("idx_import_jobs_bundle"))
  app.save(jobs)
})
