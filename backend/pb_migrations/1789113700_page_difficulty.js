// #180 难度标签落库：pages 追加可索引的 tier 字段，外加与 tier 正交的 blocked_reason。
//
// 为什么落在 pages 而不是走 finding 机制（#180 正文也是这个倾向）：
// #162 要按 tier 筛选/排序大厅任务，那是一个 SQL 谓词；如果 tier 只能从 findings 现算，
// 大厅每次翻页都要重算一遍，且无法建索引。
//
// 三个字段都可重算、可空：
// - difficulty_tier 为空 = 从没算过；算过但没有任何信号命中时是 "unknown"（两者不同，
//   #162 对 unknown 必须原样退回「下一条」行为，所以它必须能被区分出来）；
// - difficulty_basis_json 记下命中了判定表的哪几行，让 tier 可追溯；
// - difficulty_version 记下用的是哪一版判定表，便于对比升版前后的差异。
const TIERS = ["A", "B", "C", "unknown"]
const BLOCKED_BUCKETS = ["glyph_table", "scanned_read", "column_merge", "rights_gate", "unknown"]
const INDEX_SQL = "CREATE INDEX idx_pages_project_tier ON pages (project, difficulty_tier)"

const added = [
  { build: () => new SelectField({ name: "difficulty_tier", maxSelect: 1, values: TIERS, required: false }),
    remove: "difficulty_tier" },
  { build: () => new TextField({ name: "difficulty_basis_json", required: false }),
    remove: "difficulty_basis_json" },
  { build: () => new TextField({ name: "difficulty_version", required: false }),
    remove: "difficulty_version" },
  { build: () => new SelectField({ name: "blocked_reason", maxSelect: 1, values: BLOCKED_BUCKETS, required: false }),
    remove: "blocked_reason" }
]

function hasField(pages, name) {
  return Boolean(pages.fields.getByName(name))
}

migrate((app) => {
  const pages = app.findCollectionByNameOrId("pages")
  for (const field of added) {
    if (hasField(pages, field.remove)) continue // 幂等：既有库已加过就不重复加
    pages.fields.add(field.build())
  }
  if (!pages.indexes.some((sql) => sql.includes("idx_pages_project_tier"))) {
    pages.indexes = [...pages.indexes, INDEX_SQL]
  }
  app.save(pages)
}, (app) => {
  const pages = app.findCollectionByNameOrId("pages")
  for (const field of added) {
    if (hasField(pages, field.remove)) pages.fields.removeByName(field.remove)
  }
  pages.indexes = pages.indexes.filter((sql) => !sql.includes("idx_pages_project_tier"))
  app.save(pages)
})
