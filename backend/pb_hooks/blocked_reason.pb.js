// #240：`pages.blocked_reason` 的人工写入口。
//
// 权限口径由维护者在 #240 上定为 (B)：**只有平台管理员能写**。理由不是"manager 不够格"，
// 而是这几个桶（授权未决 / 扫描页识读 / 缺字表查表）本来就是**跨项目的资料级结论**，
// 项目成员各自标一遍会让同一条资料在不同项目里带着不同的阻塞原因。
//
// 机器路径继续**只读不 stamp**（#211/#212 的结论）：`assist_writer.js` 里
// `blockedReason: manual || blockedReasonFromFindings(findings)` 只把机器认出的桶
// 用作判档输入，从不写回这一列。所以库里读到的值就是人的结论。
// 路径与方法都写在各次 routerAdd 里：`.pb.js` 的顶层 const 在回调真正执行时读不到
// （JSVM 只在文件求值时保留顶层绑定），而 routerAdd 的第二个参数必须是路径字符串——
// 把 "GET /api/…" 整串当方法传进去，PocketBase 会把第三个参数当 handler，
// 症状是启动即 panic：[routerAdd] failed to wrap handler: unsupported goja handler type。

routerAdd("PUT", "/api/fangji/pages/{pageId}/blocked-reason", (c) => {
  const { isPlatformAdmin: blockedIsPlatformAdmin } = require(`${__hooks}/lib/project_access.js`)
  const { BLOCKED_BUCKETS } = require(`${__hooks}/lib/assist_difficulty.js`)
  const { refreshDifficulty: blockedRefresh } = require(`${__hooks}/lib/assist_writer.js`)
  const auth = c.auth
  if (!blockedIsPlatformAdmin(auth)) throw new ForbiddenError("只有平台管理员能登记条目的阻塞原因")
  const pageId = c.request.pathValue("pageId")
  const body = c.requestInfo().body || {}
  const reason = String(body.reason ?? "").trim()
  const basis = String(body.basis ?? "").trim()
  // 值域必须是白名单：这一串会被写进 SelectField，非法值在 PocketBase 那边
  // 是"保存报错"还是"静默清空"取决于版本，两种都不是可审计的行为。
  if (!BLOCKED_BUCKETS.includes(reason)) {
    throw new BadRequestError(`阻塞原因只能是 ${BLOCKED_BUCKETS.join("/")} 之一`)
  }
  if (!basis) throw new BadRequestError("必须写明依据（basis）：没有出处的阻塞结论读回来就是一句猜")
  if (basis.length > 500) throw new BadRequestError("依据过长（上限 500 字）")
  let page = null
  try { page = $app.findRecordById("pages", pageId) } catch { throw new NotFoundError("条目不存在") }
  const at = new Date().toISOString()
  page.set("blocked_reason", reason)
  page.set("blocked_reason_by", auth.id)
  page.set("blocked_reason_at", at)
  page.set("blocked_reason_note", basis)
  $app.save(page)
  // 写完不重算也不会分叉：登记与刷档在同一次请求里完成（#240 验收第 4 条的两个选项里
  // 选这个——让调用方"记得再刷一次"迟早会有人忘，而忘了的症状是 tier 与库里结论不一致）。
  const derived = blockedRefresh($app, page)
  return c.json(200, {
    page: pageId, blocked_reason: reason, blocked_reason_by: auth.id,
    blocked_reason_by_name: auth.getString("name"),
    blocked_reason_at: at, blocked_reason_note: basis,
    difficulty_tier: derived.tier, difficulty_basis: derived.basis,
    difficulty_version: derived.version
  })
}, $apis.requireAuth("users"))

routerAdd("GET", "/api/fangji/pages/{pageId}/blocked-reason", (c) => {
  const { isPlatformAdmin: blockedIsPlatformAdmin } = require(`${__hooks}/lib/project_access.js`)
  if (!blockedIsPlatformAdmin(c.auth)) throw new ForbiddenError("只有平台管理员能读阻塞结论")
  let page = null
  try { page = $app.findRecordById("pages", c.request.pathValue("pageId")) } catch { throw new NotFoundError("条目不存在") }
  const by = page.getString("blocked_reason_by")
  let byName = ""
  try {
    byName = $app.findRecordById("users", by).getString("name")
  } catch {
    // 登记人被删掉时结论仍然有效（它是人工判断，不跟着人一起消失），只是没有署名。
    byName = ""
  }
  return c.json(200, {
    page: page.id,
    blocked_reason: page.getString("blocked_reason"),
    blocked_reason_by: by,
    blocked_reason_by_name: byName,
    blocked_reason_at: page.getString("blocked_reason_at"),
    blocked_reason_note: page.getString("blocked_reason_note")
  })
}, $apis.requireAuth("users"))

// 清除 = 回到"没人说过"，库里必须是空串而不是 "unknown"：
// 后者是一个**结论**（看过但认不出），拿它当缺省值会把"没看过"洗成"看过且认不出"。
routerAdd("DELETE", "/api/fangji/pages/{pageId}/blocked-reason", (c) => {
  const { isPlatformAdmin: blockedIsPlatformAdmin } = require(`${__hooks}/lib/project_access.js`)
  const { refreshDifficulty: blockedRefresh } = require(`${__hooks}/lib/assist_writer.js`)
  if (!blockedIsPlatformAdmin(c.auth)) throw new ForbiddenError("只有平台管理员能撤销阻塞结论")
  let page = null
  try { page = $app.findRecordById("pages", c.request.pathValue("pageId")) } catch { throw new NotFoundError("条目不存在") }
  page.set("blocked_reason", "")
  page.set("blocked_reason_by", "")
  page.set("blocked_reason_at", "")
  page.set("blocked_reason_note", "")
  $app.save(page)
  const derived = blockedRefresh($app, page)
  return c.json(200, {
    page: page.id, blocked_reason: "", difficulty_tier: derived.tier,
    difficulty_basis: derived.basis, difficulty_version: derived.version
  })
}, $apis.requireAuth("users"))
