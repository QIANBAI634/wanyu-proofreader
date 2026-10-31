/// <reference path="../pb_data/types.d.ts" />

// A9 返工与回流：下游（校对/仲裁/采用/对账）发现问题后，把条目退回 A 线（资料接入）。
//
// 两个端点：
//  - return-to-source：校对员（自己正在校对的）或经理（项目内任意非终态条目）发起退回，
//    置 status='rework'、清租约与 proofreader，并留痕 returned_to_source。
//  - resolve-return：经理处理退回（processed=已处理回待校对；ignored=看到了但忽略，
//    同样回待校对、只留痕），留痕 return_acknowledged。有 acknowledged 事件 = 已看到，
//    没有 = 还没看到——这就是 A9.2 要的「看到了并忽略」与「没看到」可区分。
//
// 退回理由/可退回状态不在本文件顶层声明（PocketBase 会把所有 .pb.js 拼进同一作用域），
// 直接在回调里内联，避免跨文件命名冲突。

routerAdd("POST", "/api/fangji/pages/{pageId}/return-to-source", (c) => {
  const api = require(`${__hooks}/lib/source_fidelity_access.js`)
  const fidelity = require(`${__hooks}/lib/source_fidelity.js`)
  const leases = require(`${__hooks}/lib/task_leases.js`)
  const RETURN_REASONS = ["source_missing", "misplaced_content", "rights_pending", "text_mismatch"]
  const RETURNABLE = ["pending", "claimed", "proofreading", "proofread", "reviewing", "arbitration"]
  const body = c.requestInfo().body || {}
  $app.runInTransaction((dao) => {
    const { page } = api.pageAccess(dao, c.request.pathValue("pageId"), c.auth)
    if (!RETURNABLE.includes(page.getString("status"))) throw new BadRequestError("该条目当前状态不能退回")
    const reason = String(body.reason || "").trim()
    if (!RETURN_REASONS.includes(reason)) throw new BadRequestError("退回理由无效")
    const basis = String(body.basis || "").trim()
    if (!basis) throw new BadRequestError("请填写退回依据（一句话说明哪里对不上）")
    const context = fidelity.contextFor(dao, page)
    fidelity.appendEvent(dao, { project: context.project, page: page.id, kind: "returned_to_source", actor: c.auth.id, context, payload: { reason, basis: basis.slice(0, 2000), from_status: page.getString("status") } })
    leases.clearLease(dao, page)
    page.set("proofreader", null)
    page.set("status", "rework")
    dao.save(page)
  })
  return c.json(200, { saved: true })
}, $apis.requireAuth("users"))

routerAdd("POST", "/api/fangji/pages/{pageId}/resolve-return", (c) => {
  const api = require(`${__hooks}/lib/source_fidelity_access.js`)
  const fidelity = require(`${__hooks}/lib/source_fidelity.js`)
  const body = c.requestInfo().body || {}
  $app.runInTransaction((dao) => {
    const { page, manager } = api.pageAccess(dao, c.request.pathValue("pageId"), c.auth)
    if (!manager) throw new ForbiddenError("只有管理员可以处理退回")
    if (page.getString("status") !== "rework") throw new BadRequestError("该条目不在待返工状态")
    const disposition = body.disposition === "ignored" ? "ignored" : "processed"
    const context = fidelity.contextFor(dao, page)
    fidelity.appendEvent(dao, { project: context.project, page: page.id, kind: "return_acknowledged", actor: c.auth.id, context, payload: { disposition, note: String(body.note || "").slice(0, 2000) } })
    page.set("status", "pending")
    dao.save(page)
  })
  return c.json(200, { saved: true })
}, $apis.requireAuth("users"))
