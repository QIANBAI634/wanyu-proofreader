// #123 服务端导出产物：project_artifacts 集合。
//
// 回滚：本文件的 down() 会删掉整个 project_artifacts 集合及其文件产物。
// 产物文件本身保存在 storage，删除集合不会顺带清理已存文件（与其它 file 字段一致），
// 但记录一旦删除即不可再寻址。执行本迁移之前必须先备份 pb_data。
//
// 幂等：集合已存在时跳过，避免重复 import 换掉记录 id。

const ARTIFACT_INDEX = "CREATE INDEX idx_project_artifacts_project ON project_artifacts (project, created DESC)"

const MANAGER_RULE = '@request.auth.id != "" && (@request.auth.role = "platform_admin" || project.admin = @request.auth.id || project.acl.managers.id ?= @request.auth.id)'

const autoTimes = [
  { hidden: false, id: "autodate2990389176", name: "created", onCreate: true, onUpdate: false, presentable: false, system: false, type: "autodate" },
  { hidden: false, id: "autodate3332085495", name: "updated", onCreate: true, onUpdate: true, presentable: false, system: false, type: "autodate" }
]

const artifactsSpec = (projectsId, usersId) => ({
  name: "project_artifacts",
  type: "base",
  system: false,
  listRule: MANAGER_RULE,
  viewRule: MANAGER_RULE,
  createRule: null,
  updateRule: null,
  deleteRule: null,
  indexes: [ARTIFACT_INDEX],
  fields: [
    { autogeneratePattern: "[a-z0-9]{15}", hidden: false, id: "text3208210256", max: 15, min: 15, name: "id", pattern: "^[a-z0-9]+$", presentable: false, primaryKey: true, required: true, system: true, type: "text" },
    { cascadeDelete: true, collectionId: projectsId, hidden: false, id: "artproject1", maxSelect: 1, minSelect: 0, name: "project", presentable: false, required: true, system: false, type: "relation" },
    { hidden: false, id: "artkind0001", maxSelect: 1, name: "kind", presentable: false, required: true, system: false, type: "select", values: ["csv"] },
    { hidden: false, id: "artfile0001", maxSelect: 1, maxSize: 52428800, mimeTypes: [], name: "file", presentable: false, protected: true, required: true, system: false, thumbs: [], type: "file" },
    { autogeneratePattern: "", hidden: false, id: "artname0001", max: 500, min: 1, name: "file_name", pattern: "", presentable: false, primaryKey: false, required: true, system: false, type: "text" },
    { hidden: false, id: "artsize0001", max: null, min: 0, name: "file_size", onlyInt: true, presentable: false, required: false, system: false, type: "number" },
    { cascadeDelete: false, collectionId: usersId, hidden: false, id: "artby000001", maxSelect: 1, minSelect: 0, name: "created_by", presentable: false, required: false, system: false, type: "relation" },
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
  if (!exists(app, "project_artifacts")) {
    const projects = app.findCollectionByNameOrId("projects")
    const users = app.findCollectionByNameOrId("users")
    app.importCollections([artifactsSpec(projects.id, users.id)], false)
  }
}, (app) => {
  if (exists(app, "project_artifacts")) {
    app.delete(app.findCollectionByNameOrId("project_artifacts"))
  }
})
