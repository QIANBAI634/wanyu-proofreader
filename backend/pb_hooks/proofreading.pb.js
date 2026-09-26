/// <reference path="../pb_data/types.d.ts" />

const FANGJI_API = "/api/fangji"

// Claiming is serialized in a database transaction. An existing active task in
// the same project always wins; then prefer a verified completed task's PDF range
// before falling back to the original eligible queue order.
routerAdd("POST", `${FANGJI_API}/projects/{projectId}/claim`, (c) => {
  const { canProofread: proofCanProofread } = require(`${__hooks}/lib/project_access.js`)
  const {
    leaseForPage: proofLeaseForPage,
    queueStatusForPage: proofQueueStatusForPage,
    leaseExpired: proofLeaseExpired,
    issueLease: proofIssueLease,
    clearLease: proofClearLease
  } = require(`${__hooks}/lib/task_leases.js`)
  const {
    proofreadAttempts: proofAttempts,
    requiredProofreads: proofRequiredProofreads,
    evaluatePage: proofEvaluatePage
  } = require(`${__hooks}/lib/proofreading_workflow.js`)
  const auth = c.auth
  if (!auth) throw new ForbiddenError("无权执行此操作")
  if (auth.getBool("must_change_password")) throw new ForbiddenError("首次登录请先修改密码")
  const summarize = (page, issued) => ({
    id: page.id,
    project: page.getString("project"),
    project_file: page.getString("project_file"),
    page_number: page.getInt("page_number"),
    pdf_page: page.getInt("pdf_page"),
    status: page.getString("status"),
    proofreader: page.getString("proofreader"),
    leaseToken: issued.token,
    leaseExpiresAt: issued.expiresAt
  })
  const userId = auth.id
  const projectId = c.request.pathValue("projectId")
  let response = null
  const claimBody = new DynamicModel({ previousTaskId: "" })
  if (c.request.contentLength !== 0) c.bindBody(claimBody)
  const previousTaskId = String(claimBody.previousTaskId || "")

  $app.runInTransaction((txDao) => {
    try {
      txDao.findRecordById("projects", projectId)
    } catch {
      throw new NotFoundError("项目不存在")
    }
    if (!proofCanProofread(txDao, projectId, auth)) throw new ForbiddenError("你不是该项目的校对员")

    const active = txDao.findRecordsByFilter(
      "pages",
      `project = "${projectId}" && proofreader = "${userId}" && (status = "claimed" || status = "proofreading")`,
      "page_number",
      1,
      0
    )
    if (active.length) {
      const claimed = active[0]
      const existingLease = proofLeaseForPage(txDao, claimed.id)
      const queueStatus = proofQueueStatusForPage(claimed, existingLease)
      const issued = proofIssueLease(txDao, claimed, userId, queueStatus)
      claimed.set("status", "proofreading")
      claimed.set("proofreader", userId)
      txDao.save(claimed)
      response = summarize(claimed, issued)
      return
    }

    const queueFilter = `project = "${projectId}" && (status = "pending" || status = "proofread" || status = "claimed" || status = "proofreading")`
    const filters = []
    if (previousTaskId) {
      if (!/^[a-z0-9]{15}$/.test(previousTaskId)) throw new BadRequestError("上一任务标识无效")
      let previous = null
      try { previous = txDao.findRecordById("pages", previousTaskId) } catch { throw new BadRequestError("上一任务不存在") }
      if (previous.getString("project") !== projectId || !proofAttempts(txDao, previous).some(a => a.getString("proofreader") === userId)) {
        throw new ForbiddenError("上一任务尚未由你完成校对")
      }
      const primary = txDao.findRecordsByFilter("project_files", `project = "${projectId}" && status = "ready" && is_primary = true`, "-created", 1, 0)[0]
      const fileId = previous.getString("project_file") || primary?.id || ""
      const start = previous.getInt("pdf_page") || previous.getInt("page_number")
      if (fileId && start > 0) {
        let file = null
        try { file = txDao.findRecordById("project_files", fileId) } catch {}
        if (file && file.getString("project") === projectId && file.getString("status") === "ready") {
          const source = primary?.id === fileId ? `(project_file = "${fileId}" || project_file = "")` : `project_file = "${fileId}"`
          filters.push(`${queueFilter} && ${source} && ((pdf_page > 0 && pdf_page = ${start}) || (pdf_page <= 0 && page_number = ${start}))`)
        }
      }
    }
    filters.push(queueFilter)
    const seen = new Set()
    for (const filter of filters) {
      if (response) break
      const candidates = txDao.findRecordsByFilter("pages", filter, "page_number,id", 100000, 0)
      for (const page of candidates) {
        if (seen.has(page.id)) continue
        seen.add(page.id)
        const status = page.getString("status")
        let queueStatus = status
        if (status === "claimed" || status === "proofreading") {
          const existingLease = proofLeaseForPage(txDao, page.id)
          if (existingLease && !proofLeaseExpired(existingLease)) continue
          queueStatus = proofQueueStatusForPage(page, existingLease)
          if (!existingLease) proofClearLease(txDao, page)
        }
        const attempts = proofAttempts(txDao, page)
        if (attempts.some((attempt) => attempt.getString("proofreader") === userId)) continue
        if (attempts.length >= proofRequiredProofreads(txDao, projectId)) {
          proofEvaluatePage(txDao, page)
          continue
        }
        queueStatus = attempts.length ? "proofread" : "pending"
        const issued = proofIssueLease(txDao, page, userId, queueStatus)
        page.set("proofreader", userId)
        page.set("status", "proofreading")
        txDao.save(page)
        response = summarize(page, issued)
        break
      }
    }
  })

  return c.json(200, response)
}, $apis.requireAuth("users"))

routerAdd("GET", `${FANGJI_API}/pages/{pageId}/task`, (c) => {
  const { assertId: proofAssertId, canProofread: proofCanProofread } = require(`${__hooks}/lib/project_access.js`)
  const { ownProofreadAttempt: proofOwnAttempt } = require(`${__hooks}/lib/proofreading_workflow.js`)
  const auth = c.auth
  if (!auth) throw new ForbiddenError("无权执行此操作")
  if (auth.getBool("must_change_password")) throw new ForbiddenError("首次登录请先修改密码")
  const pageId = proofAssertId(c.request.pathValue("pageId"), "条目")
  const dao = $app
  let page = null
  try { page = dao.findRecordById("pages", pageId) } catch { throw new NotFoundError("条目不存在") }
  if (!proofCanProofread(dao, page.getString("project"), auth)) {
    throw new ForbiddenError("你不是该项目的校对员")
  }
  const active = page.getString("proofreader") === auth.id
    && ["claimed", "proofreading"].includes(page.getString("status"))
  const reviewMode = String(c.request.url.query().get("mode") || "") === "review"
  // Legacy GET /task stays 403 for submitted pages so the current editor does
  // not treat a 200 as an assigned task and reclaim another page. #118 should
  // call this with ?mode=review and skip restoreOrAcquireLease.
  if (!active && !reviewMode) throw new ForbiddenError("该任务当前未分配给你")
  const ownAttempt = active ? null : proofOwnAttempt(dao, page, auth.id)
  if (!active && !ownAttempt) throw new ForbiddenError("该任务当前未分配给你")

  const project = dao.findRecordById("projects", page.getString("project"))
  const payload = {
    id: page.id,
    project: page.getString("project"),
    project_file: page.getString("project_file"),
    page_number: page.getInt("page_number"),
    pdf_page: page.getInt("pdf_page"),
    status: page.getString("status"),
    ocr_text: page.getString("ocr_text"),
    ocr_row_json: page.getString("ocr_row_json"),
    row_headers_json: page.getString("row_headers_json"),
    expand: {
      project: { id: project.id, name: project.getString("name") }
    }
  }
  if (active) {
    payload.proofreader = page.getString("proofreader")
    return c.json(200, payload)
  }
  // Page status is a derived projection of quorum progress and of whether the
  // independent results agree, so a read-only review must not carry it.
  delete payload.status
  payload.readonly = true
  // Private attempt fields, not the page's canonical proofread_* after quorum.
  payload.proofread_row_json = ownAttempt.getString("row_json")
  payload.proofread_text = ownAttempt.getString("text")
  return c.json(200, payload)
}, $apis.requireAuth("users"))

routerAdd("GET", `${FANGJI_API}/projects/{projectId}/tasks/mine`, (c) => {
  const { assertId: proofAssertId, canProofread: proofCanProofread } = require(`${__hooks}/lib/project_access.js`)
  const auth = c.auth
  if (!auth) throw new ForbiddenError("无权执行此操作")
  if (auth.getBool("must_change_password")) throw new ForbiddenError("首次登录请先修改密码")
  const projectId = proofAssertId(c.request.pathValue("projectId"), "项目")
  const dao = $app
  try { dao.findRecordById("projects", projectId) } catch { throw new NotFoundError("项目不存在") }
  if (!proofCanProofread(dao, projectId, auth)) throw new ForbiddenError("你不是该项目的校对员")

  const pages = dao.findRecordsByFilter(
    "pages",
    `project = "${projectId}" && proofreader = "${auth.id}" && (status = "claimed" || status = "proofreading")`,
    "page_number",
    100000,
    0
  )
  return c.json(200, pages.map((page) => ({
    id: page.id,
    page_number: page.getInt("page_number")
  })))
}, $apis.requireAuth("users"))

routerAdd("GET", `${FANGJI_API}/projects/{projectId}/tasks/reviewed`, (c) => {
  const { assertId: proofAssertId, canProofread: proofCanProofread } = require(`${__hooks}/lib/project_access.js`)
  const { reviewedProofreads: proofReviewed } = require(`${__hooks}/lib/proofreading_workflow.js`)
  const auth = c.auth
  if (!auth) throw new ForbiddenError("无权执行此操作")
  if (auth.getBool("must_change_password")) throw new ForbiddenError("首次登录请先修改密码")
  const projectId = proofAssertId(c.request.pathValue("projectId"), "项目")
  const dao = $app
  try { dao.findRecordById("projects", projectId) } catch { throw new NotFoundError("项目不存在") }
  if (!proofCanProofread(dao, projectId, auth)) throw new ForbiddenError("你不是该项目的校对员")

  const cursorPageId = String(c.request.url.query().get("pageId") || "")
  if (cursorPageId) proofAssertId(cursorPageId, "条目")

  const items = proofReviewed(dao, projectId, auth.id).map(({ page, attempt }) => ({
    id: page.id,
    page_number: page.getInt("page_number"),
    submitted_at: String(attempt.get("submitted_at") || "")
  }))
  const index = cursorPageId ? items.findIndex((item) => item.id === cursorPageId) : -1
  return c.json(200, {
    items,
    position: index < 0 ? 0 : index + 1,
    total: items.length
  })
}, $apis.requireAuth("users"))

routerAdd("POST", `${FANGJI_API}/pages/{pageId}/lease/renew`, (c) => {
  const { canProofread: proofCanProofread } = require(`${__hooks}/lib/project_access.js`)
  const { renewLease: proofRenewLease } = require(`${__hooks}/lib/task_leases.js`)
  const auth = c.auth
  if (!auth) throw new ForbiddenError("无权执行此操作")
  const pageId = c.request.pathValue("pageId")
  const body = new DynamicModel({ leaseToken: "" })
  c.bindBody(body)
  let expiresAt = ""
  $app.runInTransaction((txDao) => {
    let page = null
    try { page = txDao.findRecordById("pages", pageId) } catch { throw new NotFoundError("条目不存在") }
    if (!proofCanProofread(txDao, page.getString("project"), auth)) throw new ForbiddenError("你不是该项目的校对员")
    expiresAt = proofRenewLease(txDao, page, auth.id, body.leaseToken)
  })
  return c.json(200, { pageId, leaseExpiresAt: expiresAt })
}, $apis.requireAuth("users"))

routerAdd("POST", `${FANGJI_API}/pages/{pageId}/release`, (c) => {
  const { canProofread: proofCanProofread } = require(`${__hooks}/lib/project_access.js`)
  const { releaseLease: proofReleaseLease } = require(`${__hooks}/lib/task_leases.js`)
  const {
    proofreadAttempts: proofAttempts,
    requiredProofreads: proofRequiredProofreads,
    evaluatePage: proofEvaluatePage
  } = require(`${__hooks}/lib/proofreading_workflow.js`)
  const auth = c.auth
  if (!auth) throw new ForbiddenError("无权执行此操作")
  const pageId = c.request.pathValue("pageId")
  const body = new DynamicModel({ leaseToken: "" })
  c.bindBody(body)
  $app.runInTransaction((txDao) => {
    let page = null
    try { page = txDao.findRecordById("pages", pageId) } catch { throw new NotFoundError("条目不存在") }
    if (!proofCanProofread(txDao, page.getString("project"), auth)) throw new ForbiddenError("你不是该项目的校对员")
    proofReleaseLease(txDao, page, auth.id, body.leaseToken)
    if (proofAttempts(txDao, page).length >= proofRequiredProofreads(txDao, page.getString("project"))) {
      proofEvaluatePage(txDao, page)
    }
  })
  return c.noContent(204)
}, $apis.requireAuth("users"))

// Reordering is a single server-side transaction. The request must contain
// each selected pending page exactly once. This supports paginated admin views
// while stale or cross-project selections are rejected in the transaction.
routerAdd("POST", `${FANGJI_API}/projects/{projectId}/pages/reorder`, (c) => {
  const { canManage: proofCanManage } = require(`${__hooks}/lib/project_access.js`)
  const auth = c.auth
  if (!auth) throw new ForbiddenError("无权执行此操作")
  const projectId = c.request.pathValue("projectId")
  const body = new DynamicModel({ orderedIds: [] })
  c.bindBody(body)
  if (!Array.isArray(body.orderedIds) || !body.orderedIds.length || body.orderedIds.length > 100000) {
    throw new BadRequestError("待校对条目顺序无效")
  }
  const orderedIds = body.orderedIds.map((id) => String(id))
  if (new Set(orderedIds).size !== orderedIds.length) throw new BadRequestError("待校对条目不能重复")

  $app.runInTransaction((txDao) => {
    let project = null
    try { project = txDao.findRecordById("projects", projectId) } catch { throw new NotFoundError("项目不存在") }
    if (!proofCanManage(txDao, project, auth)) throw new ForbiddenError("你没有管理该项目的权限")
    const pending = orderedIds.map((id) => {
      let page = null
      try { page = txDao.findRecordById("pages", id) } catch { throw new BadRequestError("待校对条目已变化，请刷新后重试") }
      if (page.getString("project") !== projectId || page.getString("status") !== "pending") {
        throw new BadRequestError("只能调整当前项目中仍待校对的条目")
      }
      return page
    })
    const pendingById = {}
    pending.forEach((page) => { pendingById[page.id] = page })

    const slots = pending.map((page) => page.getInt("page_number")).sort((a, b) => a - b)
    const all = txDao.findRecordsByFilter("pages", `project = "${projectId}"`, "-page_number", 100000, 0)
    const maxPageNumber = all.length ? all[0].getInt("page_number") : 0
    pending.forEach((page, index) => {
      page.set("page_number", maxPageNumber + index + 1)
      txDao.save(page)
    })
    orderedIds.forEach((id, index) => {
      const page = pendingById[id]
      page.set("page_number", slots[index])
      txDao.save(page)
    })
  })

  return c.json(200, { count: orderedIds.length })
}, $apis.requireAuth("users"))

// Delete and project-wide resequencing are atomic. Only pages that are still
// pending at transaction time may be deleted.
routerAdd("POST", `${FANGJI_API}/projects/{projectId}/pages/delete-pending`, (c) => {
  const { canManage: proofCanManage } = require(`${__hooks}/lib/project_access.js`)
  const auth = c.auth
  if (!auth) throw new ForbiddenError("无权执行此操作")
  const projectId = c.request.pathValue("projectId")
  const body = new DynamicModel({ ids: [] })
  c.bindBody(body)
  if (!Array.isArray(body.ids) || !body.ids.length || body.ids.length > 100000) {
    throw new BadRequestError("待删除条目无效")
  }
  const ids = body.ids.map((id) => String(id))
  if (new Set(ids).size !== ids.length) throw new BadRequestError("待删除条目不能重复")

  $app.runInTransaction((txDao) => {
    let project = null
    try { project = txDao.findRecordById("projects", projectId) } catch { throw new NotFoundError("项目不存在") }
    if (!proofCanManage(txDao, project, auth)) throw new ForbiddenError("你没有管理该项目的权限")
    const targets = ids.map((id) => {
      let page = null
      try { page = txDao.findRecordById("pages", id) } catch { throw new BadRequestError("待删除条目不存在") }
      if (page.getString("project") !== projectId || page.getString("status") !== "pending") {
        throw new BadRequestError("只能删除当前项目中仍待校对的条目")
      }
      return page
    })
    targets.forEach((page) => txDao.delete(page))

    const remaining = txDao.findRecordsByFilter(
      "pages",
      `project = "${projectId}"`,
      "page_number,created",
      100000,
      0
    )
    const maxPageNumber = remaining.reduce((max, page) => Math.max(max, page.getInt("page_number")), 0)
    remaining.forEach((page, index) => {
      page.set("page_number", maxPageNumber + index + 1)
      txDao.save(page)
    })
    remaining.forEach((page, index) => {
      page.set("page_number", index + 1)
      txDao.save(page)
    })
  })

  return c.json(200, { deleted_count: ids.length })
}, $apis.requireAuth("users"))

// The complete pass submission and comparison happens atomically on the
// server. First-pass content is persisted only in the private attempts table.
routerAdd("POST", `${FANGJI_API}/pages/{pageId}/submit`, (c) => {
  const { canProofread: proofCanProofread } = require(`${__hooks}/lib/project_access.js`)
  const { requireLease: proofRequireLease } = require(`${__hooks}/lib/task_leases.js`)
  const {
    proofreadAttempts: proofAttempts,
    evaluatePage: proofEvaluatePage
  } = require(`${__hooks}/lib/proofreading_workflow.js`)
  const auth = c.auth
  if (!auth) throw new ForbiddenError("无权执行此操作")
  if (auth.getBool("must_change_password")) throw new ForbiddenError("首次登录请先修改密码")
  const userId = auth.id
  const pageId = c.request.pathValue("pageId")
  const body = new DynamicModel({ rowJson: "", text: "", leaseToken: "" })
  c.bindBody(body)
  const parseRowObject = (raw) => {
    const value = String(raw || "")
    if (!value || value.length > 2 * 1024 * 1024) throw new BadRequestError("校对内容为空或过大")
    let parsed = null
    try { parsed = JSON.parse(value) } catch { throw new BadRequestError("校对内容格式无效") }
    if (!parsed || Array.isArray(parsed) || typeof parsed !== "object" || !Object.keys(parsed).length) {
      throw new BadRequestError("校对内容必须是非空字段对象")
    }
    return parsed
  }
  const validateSubmittedRow = (raw, page) => {
    const parsed = parseRowObject(raw)
    let source = { "内容": page.getString("ocr_text") }
    try {
      const candidate = JSON.parse(page.getString("ocr_row_json"))
      if (candidate && !Array.isArray(candidate) && typeof candidate === "object" && Object.keys(candidate).length) source = candidate
    } catch {}
    const sourceKeys = Object.keys(source)
    const expectedKeys = sourceKeys.slice().sort()
    const actualKeys = Object.keys(parsed).sort()
    if (expectedKeys.length !== actualKeys.length || expectedKeys.some((key, index) => key !== actualKeys[index])) {
      throw new BadRequestError(`校对字段必须与原始字段一致：${expectedKeys.join("、")}`)
    }
    for (const key of expectedKeys) {
      if (typeof parsed[key] !== "string") throw new BadRequestError(`字段“${key}”必须是文本`)
    }
    if (!expectedKeys.some((key) => parsed[key].trim() !== "")) throw new BadRequestError("校对内容不能全部为空")
    return { parsed, keys: sourceKeys }
  }
  const composeRowText = (keys, parsed) => keys.map((key) => parsed[key].trim()).filter(Boolean).join(" ")
  const now = new Date().toISOString()
  let response = null
  let assistSubmittedRow = null

  try {
    $app.runInTransaction((txDao) => {
    let page = null
    try {
      page = txDao.findRecordById("pages", pageId)
    } catch {
      throw new NotFoundError("条目不存在")
    }
    if (!proofCanProofread(txDao, page.getString("project"), auth)) {
      throw new ForbiddenError("你不是该项目的校对员")
    }

    const status = page.getString("status")
    if ((status !== "claimed" && status !== "proofreading") || page.getString("proofreader") !== userId) {
      throw new BadRequestError("该条目当前不属于你，请返回项目大厅刷新后重试")
    }
    proofRequireLease(txDao, page, userId, body.leaseToken)

    const validatedRow = validateSubmittedRow(body.rowJson, page)
    const parsedRow = validatedRow.parsed
    const rowJson = JSON.stringify(parsedRow)
    assistSubmittedRow = parsedRow
    const text = composeRowText(validatedRow.keys, parsedRow)

    const attemptsCollection = txDao.findCollectionByNameOrId("proofreading_attempts")
    const round = page.getInt("proofread_round") || 1
    const attempts = proofAttempts(txDao, page)
    if (attempts.some((attempt) => attempt.getString("proofreader") === userId)) {
      throw new BadRequestError("你已经提交过该条目的独立校对")
    }

    const attempt = new Record(attemptsCollection)
    attempt.set("page", pageId)
    attempt.set("project", page.getString("project"))
    attempt.set("proofreader", userId)
    attempt.set("round", round)
    attempt.set("pass_no", attempts.length + 1)
    attempt.set("kind", "proofread")
    attempt.set("row_json", rowJson)
    attempt.set("text", text)
    attempt.set("outcome", "waiting")
    attempt.set("submitted_at", now)
    txDao.save(attempt)

    if (attempts.length === 0) {
      page.set("first_proofreader", userId)
      page.set("first_proofread_at", now)
    } else if (attempts.length === 1) {
      page.set("second_proofreader", userId)
      page.set("second_proofread_at", now)
    }
    page.set("proofread_at", now)
    const evaluation = proofEvaluatePage(txDao, page)
    response = {
      id: pageId,
      status: evaluation.status,
      outcome: evaluation.outcome,
      message: evaluation.status === "approved"
        ? "校对结果已提交，该条目已完成。"
        : evaluation.status === "arbitration"
          ? "校对结果已提交，该条目将由管理员继续处理。"
          : "校对结果已提交。"
    }
    })
  } catch (error) {
    console.warn("Proofread submission failed:", pageId, error)
    throw error
  }

  // #177：提交成功后对刚提交的那一行重算疑点；疑点生产失败不影响已落库的提交。
  // require 也在 try 内：lib 载入失败同样不许把已经落库的提交变成错误。
  try {
    const { safeRecomputePage: assistSafeRecompute } = require(`${__hooks}/lib/assist_writer.js`)
    assistSafeRecompute($app, pageId, assistSubmittedRow, "assist_recompute_after_submit")
  } catch (error) {
    console.warn("assist_recompute_after_submit failed", pageId, String(error))
  }
  return c.json(200, response)
}, $apis.requireAuth("users"))

routerAdd("GET", `${FANGJI_API}/pages/{pageId}/arbitration`, (c) => {
  const { canManage: proofCanManage } = require(`${__hooks}/lib/project_access.js`)
  const auth = c.auth
  if (!auth) throw new ForbiddenError("无权执行此操作")
  const summarizeAttempt = (dao, attempt) => {
    let displayName = attempt.getString("proofreader")
    try {
      const user = dao.findRecordById("users", attempt.getString("proofreader"))
      displayName = user.getString("name") || user.getString("email") || displayName
    } catch {}
    return {
      id: attempt.id,
      proofreader: attempt.getString("proofreader"),
      proofreader_name: displayName,
      round: attempt.getInt("round"),
      pass_no: attempt.getInt("pass_no"),
      kind: attempt.getString("kind"),
      row_json: attempt.getString("row_json"),
      text: attempt.getString("text"),
      outcome: attempt.getString("outcome"),
      submitted_at: String(attempt.get("submitted_at") || "")
    }
  }
  const pageId = c.request.pathValue("pageId")
  const dao = $app

  let page = null
  try {
    page = dao.findRecordById("pages", pageId)
  } catch {
    throw new NotFoundError("条目不存在")
  }
  const project = dao.findRecordById("projects", page.getString("project"))
  if (!proofCanManage(dao, project, auth)) throw new ForbiddenError("你没有管理该项目的权限")
  if (page.getString("status") !== "arbitration") {
    throw new BadRequestError("该条目当前不需要仲裁")
  }

  const round = page.getInt("proofread_round") || 1
  const attempts = dao.findRecordsByFilter(
    "proofreading_attempts",
    `page = "${pageId}" && round = ${round}`,
    "pass_no",
    1001,
    0
  )

  return c.json(200, {
    page: {
      id: page.id,
      project: page.getString("project"),
      project_file: page.getString("project_file"),
      page_number: page.getInt("page_number"),
      pdf_page: page.getInt("pdf_page"),
      status: page.getString("status"),
      proofreader: page.getString("proofreader"),
      first_proofreader: page.getString("first_proofreader"),
      second_proofreader: page.getString("second_proofreader"),
      proofread_round: page.getInt("proofread_round") || 1,
      mismatch_count: page.getInt("mismatch_count") || 0,
      ocr_row_json: page.getString("ocr_row_json"),
    row_headers_json: page.getString("row_headers_json"),
      ocr_text: page.getString("ocr_text")
    },
    attempts: attempts.map((attempt) => summarizeAttempt(dao, attempt))
  })
}, $apis.requireAuth("users"))

routerAdd("POST", `${FANGJI_API}/pages/{pageId}/arbitrate`, (c) => {
  const { canManage: proofCanManage } = require(`${__hooks}/lib/project_access.js`)
  const auth = c.auth
  if (!auth) throw new ForbiddenError("无权执行此操作")
  const pageId = c.request.pathValue("pageId")
  const body = new DynamicModel({ rowJson: "", text: "", note: "" })
  c.bindBody(body)
  const validateSubmittedRow = (raw, page) => {
    const value = String(raw || "")
    if (!value || value.length > 2 * 1024 * 1024) throw new BadRequestError("校对内容为空或过大")
    let parsed = null
    try { parsed = JSON.parse(value) } catch { throw new BadRequestError("校对内容格式无效") }
    if (!parsed || Array.isArray(parsed) || typeof parsed !== "object" || !Object.keys(parsed).length) {
      throw new BadRequestError("校对内容必须是非空字段对象")
    }
    let source = { "内容": page.getString("ocr_text") }
    try {
      const candidate = JSON.parse(page.getString("ocr_row_json"))
      if (candidate && !Array.isArray(candidate) && typeof candidate === "object" && Object.keys(candidate).length) source = candidate
    } catch {}
    const sourceKeys = Object.keys(source)
    const expectedKeys = sourceKeys.slice().sort()
    const actualKeys = Object.keys(parsed).sort()
    if (expectedKeys.length !== actualKeys.length || expectedKeys.some((key, index) => key !== actualKeys[index])) {
      throw new BadRequestError(`校对字段必须与原始字段一致：${expectedKeys.join("、")}`)
    }
    for (const key of expectedKeys) {
      if (typeof parsed[key] !== "string") throw new BadRequestError(`字段“${key}”必须是文本`)
    }
    if (!expectedKeys.some((key) => parsed[key].trim() !== "")) throw new BadRequestError("校对内容不能全部为空")
    return { parsed, keys: sourceKeys }
  }
  const composeRowText = (keys, parsed) => keys.map((key) => parsed[key].trim()).filter(Boolean).join(" ")
  const note = Array.from(String(body.note || "")).slice(0, 4000).join("")
  const now = new Date().toISOString()
  let response = null
  let assistArbitratedRow = null

  $app.runInTransaction((txDao) => {
    let page = null
    try {
      page = txDao.findRecordById("pages", pageId)
    } catch {
      throw new NotFoundError("条目不存在")
    }
    const project = txDao.findRecordById("projects", page.getString("project"))
    if (!proofCanManage(txDao, project, auth)) throw new ForbiddenError("你没有管理该项目的权限")
    if (page.getString("status") !== "arbitration") {
      throw new BadRequestError("该条目当前不需要仲裁")
    }

    const validatedRow = validateSubmittedRow(body.rowJson, page)
    const parsedRow = validatedRow.parsed
    const rowJson = JSON.stringify(parsedRow)
    assistArbitratedRow = parsedRow
    const text = composeRowText(validatedRow.keys, parsedRow)

    const round = page.getInt("proofread_round") || 1
    const existing = txDao.findRecordsByFilter(
      "proofreading_attempts",
      `page = "${pageId}" && round = ${round} && kind = "arbitration"`,
      "",
      1,
      0
    )
    if (existing.length) {
      throw new BadRequestError("该条目已经完成仲裁")
    }

    const attempt = new Record(txDao.findCollectionByNameOrId("proofreading_attempts"))
    const proofreadAttempts = txDao.findRecordsByFilter(
      "proofreading_attempts",
      `page = "${pageId}" && round = ${round} && kind = "proofread"`,
      "pass_no",
      1000,
      0
    )
    attempt.set("page", pageId)
    attempt.set("project", page.getString("project"))
    attempt.set("proofreader", auth.id)
    attempt.set("round", round)
    attempt.set("pass_no", proofreadAttempts.length + 1)
    attempt.set("kind", "arbitration")
    attempt.set("row_json", rowJson)
    attempt.set("text", text)
    attempt.set("outcome", "arbitrated")
    attempt.set("submitted_at", now)
    txDao.save(attempt)

    page.set("proofread_row_json", rowJson)
    page.set("proofread_text", text)
    page.set("proofread_at", now)
    page.set("arbitrated_by", auth.id)
    page.set("arbitrated_at", now)
    page.set("arbitration_note", note)
    page.set("status", "approved")
    page.set("proofreader", null)
    txDao.save(page)

    response = {
      id: pageId,
      status: "approved",
      message: "仲裁结果已保存，条目已完成。"
    }
  })

  // #177：仲裁落定的是这一条的最终行，同样要重算，否则下一轮读到的还是仲裁前的疑点。
  try {
    const { safeRecomputePage: assistSafeArb } = require(`${__hooks}/lib/assist_writer.js`)
    assistSafeArb($app, pageId, assistArbitratedRow, "assist_recompute_after_arbitration")
  } catch (error) {
    console.warn("assist_recompute_after_arbitration failed", pageId, String(error))
  }
  return c.json(200, response)
}, $apis.requireAuth("users"))

routerAdd("GET", `${FANGJI_API}/proofreader-stats`, (c) => {
  const auth = c.auth
  if (!auth) throw new ForbiddenError("无权执行此操作")
  const dao = $app
  const aggregated = arrayOf(new DynamicModel({
    user_id: "",
    project_count: 0,
    proofread_count: 0,
    evaluated_count: 0,
    matched_count: 0
  }))
  dao.db()
    .select(
      "proofreader AS user_id",
      "COUNT(DISTINCT project) AS project_count",
      "COUNT(*) AS proofread_count",
      "SUM(CASE WHEN outcome = 'matched' OR outcome = 'mismatched' THEN 1 ELSE 0 END) AS evaluated_count",
      "SUM(CASE WHEN outcome = 'matched' THEN 1 ELSE 0 END) AS matched_count"
    )
    .from("proofreading_attempts")
    .where($dbx.exp("proofreader != '' AND kind = 'proofread'"))
    .groupBy("proofreader")
    .all(aggregated)

  if (!aggregated.some((item) => item.user_id === auth.id)) {
    aggregated.push(new DynamicModel({
      user_id: auth.id,
      project_count: 0,
      proofread_count: 0,
      evaluated_count: 0,
      matched_count: 0
    }))
  }

  const profiles = aggregated.map((item) => {
    return {
      userId: item.user_id,
      projectCount: item.project_count,
      proofreadCount: item.proofread_count,
      evaluatedCount: item.evaluated_count,
      correctCount: item.matched_count,
      accuracy: item.evaluated_count
        ? Math.round(item.matched_count / item.evaluated_count * 1000) / 10
        : 0
    }
  })

  function rank(sorted, userId, valueKey) {
    const index = sorted.findIndex((item) => item.userId === userId)
    if (index < 0) return null
    let result = 1
    for (let i = 1; i <= index; i += 1) {
      if (sorted[i - 1][valueKey] !== sorted[i][valueKey]) result = i + 1
    }
    return result
  }

  const accuracySorted = profiles.filter((item) => item.evaluatedCount > 0).sort((a, b) =>
    (b.accuracy - a.accuracy) ||
    (b.evaluatedCount - a.evaluatedCount) ||
    a.userId.localeCompare(b.userId)
  )
  const countSorted = profiles.filter((item) => item.proofreadCount > 0).sort((a, b) =>
    (b.proofreadCount - a.proofreadCount) ||
    (b.accuracy - a.accuracy) ||
    a.userId.localeCompare(b.userId)
  )
  const current = profiles.find((item) => item.userId === auth.id)

  return c.json(200, {
    ...current,
    accuracyRank: rank(accuracySorted, auth.id, "accuracy"),
    proofreadRank: rank(countSorted, auth.id, "proofreadCount"),
    rankedProofreaderCount: countSorted.length
  })
}, $apis.requireAuth("users"))
