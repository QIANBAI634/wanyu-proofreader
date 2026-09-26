/// <reference path="../pb_data/types.d.ts" />

// #176 — 机器疑点的只读接口。集合 API 不给 list/view/create/update/delete 规则，
// 校对端与管理端都只能走这两个路由，门控与盲校过滤才有唯一的落点。

onRecordUpdateRequest((e) => {
  const { IMMUTABLE_FINDING_FIELDS: FINDING_IMMUTABLE_FIELDS } = require(`${__hooks}/lib/findings.js`)
  // 只允许把旧批次标成 superseded_at，其余字段一律不可改。
  // 这里用 Request 版钩子并回读库里的当前行——与 main.pb.js 的 users/pages 守卫同一套写法；
  // 模型级 onRecordUpdate 里回读会在同一次保存的事务中失败（表现为 400 Failed to update record）。
  // 覆盖范围：所有走 API 的写入（含 superuser）。特权代码路径必须自己遵守只追加约定。
  let original = null
  try {
    original = $app.findRecordById("review_findings", e.record.id)
  } catch {
    throw new BadRequestError("疑点记录不存在或已被删除")
  }
  for (const name of FINDING_IMMUTABLE_FIELDS) {
    if (e.record.getString(name) !== original.getString(name)) {
      throw new ForbiddenError("疑点记录不可覆写，只能标 superseded_at 后写新批次")
    }
  }
  return e.next()
}, "review_findings")

// GET /api/fangji/pages/{pageId}/findings
// 校对端形状：{ hints: [{field, kind, severity, message:{key,params}, highlight, evidence}] }
// 已按 gate 与 severity 过滤：off 档一条不给，info 永不给。响应里不含 round / 轮次线索。
routerAdd("GET", "/api/fangji/pages/{pageId}/findings", (c) => {
  const { assertId: proofAssertId, canManage: proofCanManage, canProofread: proofCanProofread, project: proofProject } =
    require(`${__hooks}/lib/project_access.js`)
  const { ownProofreadAttempt: proofOwnAttempt } = require(`${__hooks}/lib/proofreading_workflow.js`)
  const { hintsForPage: proofHintsForPage } = require(`${__hooks}/lib/findings.js`)

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
  // 校对员只能拿到自己当前轮真正在手的条目：与 GET /task 同一套判定，
  // 否则任何人只要猜到 pageId 就能读到别人条目的疑点。
  if (!manager) {
    const active = page.getString("proofreader") === auth.id
      && ["claimed", "proofreading"].includes(page.getString("status"))
    if (!active && !proofOwnAttempt($app, page, auth.id)) {
      throw new ForbiddenError("该条目当前不在你手上")
    }
  }

  // hintsForPage 一并返回 truncated：条目上一旦超过上限，
  // 校对端必须知道自己看到的是被截断的，而不是"这条真没问题"。
  return c.json(200, { page: pageId, ...proofHintsForPage($app, pageId) })
}, $apis.requireAuth("users"))

// GET /api/fangji/projects/{projectId}/findings
// 管理端统计口：不做门控过滤，info 与 off 档照样可见（门槛文件 §2 的
// 「仍计算、仍写库、只在管理端统计」靠这个读取口才成立）。manager 专属。
routerAdd("GET", "/api/fangji/projects/{projectId}/findings", (c) => {
  const { assertId: proofAssertId, requireManager: proofRequireManager } = require(`${__hooks}/lib/project_access.js`)
  const { listForProject: proofListForProject } = require(`${__hooks}/lib/findings.js`)

  const auth = c.auth
  if (auth.getBool("must_change_password")) throw new ForbiddenError("首次登录请先修改密码")

  const projectId = proofAssertId(c.request.pathValue("projectId"), "项目")
  proofRequireManager($app, projectId, auth)

  const query = c.request.url.query()
  return c.json(200, proofListForProject($app, projectId, {
    page: query.get("page"),
    per: query.get("per"),
    kind: query.get("kind"),
    producer: query.get("producer")
  }))
}, $apis.requireAuth("users"))
