// #178 同身份跨行检出所需的两件事：可索引的条目身份键，与人工结论的存放处。
//
// entry_identity_key 为什么物化在 pages 上：分组要按它筛（同键多行才可能冲突），
// 而键是「归一化(词头) + 归一化(记音)」——归一化（NFC + 去空白 + 全半角折叠）在 SQL 里
// 表达不出来。#178 正文给的两条路里选了这条（追加可重算的键列），
// 因为它不把本 issue 绑死在 #170 上：键今天由已知列名推导，#170 落地后换成按角色推导，
// 重算一次即可全部回填。
//
// finding_dismissals 是本 issue 唯一允许人写的状态：管理端把某一组标成 not_conflict，
// 重算时必须保留（否则人工结论会被下一次批处理冲掉，人就再也不信这个队列）。
// 集合规则全 null，写只能通过 #178 的 manager 路由。

const IDENTITY_INDEX = "CREATE INDEX idx_pages_project_identity ON pages (project, entry_identity_key)"
const DISMISSAL_INDEX = "CREATE UNIQUE INDEX idx_dismissal_group ON finding_dismissals (project, group_key, kind)"

const dismissalSpec = (projectsId, usersId) => ({
  name: "finding_dismissals",
  type: "base",
  system: false,
  listRule: null,
  viewRule: null,
  createRule: null,
  updateRule: null,
  deleteRule: null,
  indexes: [DISMISSAL_INDEX],
  fields: [
    { autogeneratePattern: "[a-z0-9]{15}", hidden: false, id: "text3208210256", max: 15, min: 15, name: "id", pattern: "^[a-z0-9]+$", presentable: false, primaryKey: true, required: true, system: true, type: "text" },
    { cascadeDelete: true, collectionId: projectsId, hidden: false, id: "dsproject01", maxSelect: 1, minSelect: 0, name: "project", presentable: false, required: true, system: false, type: "relation" },
    { autogeneratePattern: "", hidden: false, id: "dsgroupkey01", max: 0, min: 1, name: "group_key", pattern: "", presentable: false, primaryKey: false, required: true, system: false, type: "text" },
    { hidden: false, id: "dskind0001", maxSelect: 1, name: "kind", presentable: false, required: true, system: false, type: "select", values: ["duplicate_identity", "cross_source_conflict", "merged_columns"] },
    { hidden: false, id: "dsstatus01", maxSelect: 1, name: "status", presentable: false, required: true, system: false, type: "select", values: ["not_conflict"] },
    { cascadeDelete: false, collectionId: usersId, hidden: false, id: "dsdecidedby1", maxSelect: 1, minSelect: 0, name: "decided_by", presentable: false, required: true, system: false, type: "relation" },
    { autogeneratePattern: "", hidden: false, id: "dsnote00001", max: 0, min: 0, name: "note", pattern: "", presentable: false, primaryKey: false, required: false, system: false, type: "text" },
    { hidden: false, id: "autodate2990389176", name: "created", onCreate: true, onUpdate: false, presentable: false, system: false, type: "autodate" },
    { hidden: false, id: "autodate3332085495", name: "updated", onCreate: true, onUpdate: true, presentable: false, system: false, type: "autodate" }
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
  if (!pages.fields.getByName("entry_identity_key")) {
    pages.fields.add(new TextField({ name: "entry_identity_key", required: false }))
  }
  if (!pages.indexes.some((sql) => sql.includes("idx_pages_project_identity"))) {
    pages.indexes = [...pages.indexes, IDENTITY_INDEX]
  }
  app.save(pages)

  if (!exists(app, "finding_dismissals")) {
    const projects = app.findCollectionByNameOrId("projects")
    const users = app.findCollectionByNameOrId("users")
    app.importCollections([dismissalSpec(projects.id, users.id)], false)
  }
}, (app) => {
  if (exists(app, "finding_dismissals")) {
    app.delete(app.findCollectionByNameOrId("finding_dismissals"))
  }
  const pages = app.findCollectionByNameOrId("pages")
  if (pages.fields.getByName("entry_identity_key")) pages.fields.removeByName("entry_identity_key")
  pages.indexes = pages.indexes.filter((sql) => !sql.includes("idx_pages_project_identity"))
  app.save(pages)
})
