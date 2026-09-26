/// <reference path="../pb_data/types.d.ts" />

// #177 确定性规则引擎的触发口。
//
// 本文件刻意不在顶层声明任何 const：PocketBase 的 JSVM 把所有 .pb.js 拼进同一个作用域，
// 顶层同名声明会在启动时直接 panic（本轮踩过：Identifier 'FANGJI_API' has already been declared），
// 而顶层 const 在回调实际执行时也读不到（本轮踩过：ReferenceError → 400）。

// POST /api/fangji/projects/{projectId}/findings/recompute
// manager 专属的项目级全量重算：列级(R3 编码形式 / R4 全半角)与页级(R7 离群)规则
// 必须看到整批数据才判得出来，所以只能挂在这个口，不能挂在单条提交上。
// 同步执行并返回耗时——#177 的规模与耗时验收要靠这个数字，不靠估计。
routerAdd("POST", "/api/fangji/projects/{projectId}/findings/recompute", (c) => {
  const { assertId: proofAssertId, requireManager: proofRequireManager } = require(`${__hooks}/lib/project_access.js`)
  const { recomputeProject: assistRecomputeProject } = require(`${__hooks}/lib/assist_writer.js`)

  const auth = c.auth
  if (auth.getBool("must_change_password")) throw new ForbiddenError("首次登录请先修改密码")
  const projectId = proofAssertId(c.request.pathValue("projectId"), "项目")
  proofRequireManager($app, projectId, auth)

  const summary = assistRecomputeProject($app, projectId)
  console.log("assist_recompute", JSON.stringify({ project: projectId, ...summary }))
  return c.json(200, summary)
}, $apis.requireAuth("users"))

// POST /api/fangji/pages/{pageId}/findings/recompute
// 单条重算，鉴权与疑点读取同构（manager 或该条在手者）。
// 存在的理由有两个：#124 的预览要能只对一条补算；以及 #177 验收里
// 「单条重算 p95 < 50 ms」必须有一个可以直接计时、不被认领/事务耗时混进去的口子。
routerAdd("POST", "/api/fangji/pages/{pageId}/findings/recompute", (c) => {
  const { assertId: proofAssertId, canManage: proofCanManage, canProofread: proofCanProofread, project: proofProject } =
    require(`${__hooks}/lib/project_access.js`)
  const { recomputePage: assistRecomputePage } = require(`${__hooks}/lib/assist_writer.js`)

  const auth = c.auth
  if (auth.getBool("must_change_password")) throw new ForbiddenError("首次登录请先修改密码")
  const pageId = proofAssertId(c.request.pathValue("pageId"), "条目")
  let page = null
  try {
    page = $app.findRecordById("pages", pageId)
  } catch {
    throw new NotFoundError("条目不存在")
  }
  const projectId = page.getString("project")
  const manager = proofCanManage($app, proofProject($app, projectId), auth)
  if (!manager && !proofCanProofread($app, projectId, auth)) {
    throw new ForbiddenError("你不是该项目的成员")
  }
  if (!manager) {
    const active = page.getString("proofreader") === auth.id
      && ["claimed", "proofreading"].includes(page.getString("status"))
    if (!active) throw new ForbiddenError("该条目当前不在你手上")
  }

  const startedAt = Date.now()
  const summary = assistRecomputePage($app, pageId)
  return c.json(200, { ...summary, duration_ms: Date.now() - startedAt })
}, $apis.requireAuth("users"))

// POST /api/fangji/projects/{projectId}/identity/recompute
// #178 的跨行批处理：分组比较要看到全量，所以只能是 manager 显式调的作业口，
// 绝不挂到提交路径上（#178 正文明确要求）。同时回填 entry_identity_key。
// 注意它**不刷 difficulty_tier**：本路径产的 duplicate_identity / merged_columns 都是 strong、
// 会改 tier，但要等下一次 `POST /projects/{id}/findings/recompute` 才落库。返回值里的
// `difficulty_stale` 就是给调用方看这个窗口的（#162 按 tier 筛选排序，窗口期排序是旧的）。
routerAdd("POST", "/api/fangji/projects/{projectId}/identity/recompute", (c) => {
  const { assertId: proofAssertId, requireManager: proofRequireManager } = require(`${__hooks}/lib/project_access.js`)
  const { recomputeIdentity: assistRecomputeIdentity } = require(`${__hooks}/lib/assist_writer.js`)
  const auth = c.auth
  if (auth.getBool("must_change_password")) throw new ForbiddenError("首次登录请先修改密码")
  const projectId = proofAssertId(c.request.pathValue("projectId"), "项目")
  proofRequireManager($app, projectId, auth)
  return c.json(200, assistRecomputeIdentity($app, projectId))
}, $apis.requireAuth("users"))

// POST /api/fangji/projects/{projectId}/dismissals   { group_key, kind, note }
// #178 唯一允许人写的状态：把某一组同身份条目判成「不是冲突」。重算时整组跳过。
// 这是人工结论，不是机器疑点，所以它存在 finding_dismissals 而不是给 finding 打标记——
// 机器批次会被下线，人工结论不该跟着下线。
routerAdd("POST", "/api/fangji/projects/{projectId}/dismissals", (c) => {
  const { assertId: proofAssertId, requireManager: proofRequireManager } = require(`${__hooks}/lib/project_access.js`)
  const auth = c.auth
  if (auth.getBool("must_change_password")) throw new ForbiddenError("首次登录请先修改密码")
  const projectId = proofAssertId(c.request.pathValue("projectId"), "项目")
  proofRequireManager($app, projectId, auth)

  const body = new DynamicModel({ group_key: "", kind: "", note: "" })
  c.bindBody(body)
  const groupKey = String(body.group_key || "")
  const kind = String(body.kind || "")
  const allowed = ["duplicate_identity", "cross_source_conflict", "merged_columns"]
  if (!groupKey || groupKey.length > 500) throw new BadRequestError("分组标识无效")
  // 分组键随后会被拼进过滤表达式，所以先按字符集挡一道：
  // 它本来就是「归一化(词头) 空格 归一化(记音)」，正常值不含引号、括号或反斜杠。
  if (!/^[^"\\()]*$/.test(groupKey)) throw new BadRequestError("分组标识含非法字符")
  if (!allowed.includes(kind)) throw new BadRequestError("只能对身份冲突/跨来源冲突/列合并三类下人工结论")

  const collection = $app.findCollectionByNameOrId("finding_dismissals")
  const existing = $app.findRecordsByFilter(
    "finding_dismissals",
    `project = "${projectId}" && group_key = "${groupKey}" && kind = "${kind}"`,
    "", 1, 0
  )
  if (existing.length) return c.json(200, { id: existing[0].id, existed: true })

  const record = new Record(collection)
  record.set("project", projectId)
  record.set("group_key", groupKey)
  record.set("kind", kind)
  record.set("status", "not_conflict")
  record.set("decided_by", auth.id)
  record.set("note", String(body.note || "").slice(0, 500))
  $app.save(record)
  return c.json(200, { id: record.id, existed: false })
}, $apis.requireAuth("users"))

// DELETE /api/fangji/projects/{projectId}/dismissals/{dismissalId}
// 撤回人工结论要显式做（而不是悄悄覆盖）。撤回是**物理删除、不留痕**：#178 只要求
// 「人工结论在重算时保留」，没有规定撤销要可审计，`status` 因此只有 not_conflict 一个值。
// 想留痕得先给那列加值（一次 select 迁移），那是 #178 之外的决定——注释不该承诺代码没做的事。
routerAdd("DELETE", "/api/fangji/projects/{projectId}/dismissals/{dismissalId}", (c) => {
  const { assertId: proofAssertId, requireManager: proofRequireManager } = require(`${__hooks}/lib/project_access.js`)
  const auth = c.auth
  if (auth.getBool("must_change_password")) throw new ForbiddenError("首次登录请先修改密码")
  const projectId = proofAssertId(c.request.pathValue("projectId"), "项目")
  proofRequireManager($app, projectId, auth)
  const dismissalId = proofAssertId(c.request.pathValue("dismissalId"), "结论")
  let record = null
  try {
    record = $app.findRecordById("finding_dismissals", dismissalId)
  } catch {
    throw new NotFoundError("结论不存在")
  }
  if (record.getString("project") !== projectId) throw new ForbiddenError("该结论不属于此项目")
  $app.delete(record)
  return c.json(204, {})
}, $apis.requireAuth("users"))
