import pb from '@/lib/pocketbase'
import {
  PAGE_STATUS,
  PROOFREADER_ACTIVE_STATUSES,
  statusFilter
} from '@/constants/pageStatus'

function relationFilter(field, id) {
  return `${field}="${id}"`
}

function compactOptions(options) {
  return Object.fromEntries(
    Object.entries(options).filter(([, value]) => value !== undefined && value !== '')
  )
}

export async function listPagesWithFallback({ page = 1, perPage = 50, filter, sort, expand, fields }) {
  const baseOptions = compactOptions({
    filter,
    sort,
    fields,
    requestKey: null
  })
  try {
    return await pb.collection('pages').getList(page, perPage, {
      ...baseOptions,
      expand
    })
  } catch (firstError) {
    if (!expand) throw firstError
    try {
      return await pb.collection('pages').getList(page, perPage, baseOptions)
    } catch (secondError) {
      throw secondError || firstError
    }
  }
}

export async function countPages(filter) {
  const result = await pb.collection('pages').getList(1, 1, {
    filter,
    fields: 'id',
    requestKey: null
  })
  return Number(result.totalItems || 0)
}

export async function listPendingProofreadTasks(page, perPage) {
  return listPagesWithFallback({
    page,
    perPage,
    filter: `status="${PAGE_STATUS.PENDING}"`,
    sort: 'page_number',
    expand: 'project',
    fields: 'id,page_number,pdf_page,project,status,expand.project.id,expand.project.name'
  })
}

export async function listProjectQueueSummaries(page = 1, perPage = 12) {
  return pb.send('/api/fangji/proofreading-queues', { query: { page, perPage }, requestKey: null })
}

export async function listAdminProjectPages(projectId, query) {
  return pb.send(`/api/fangji/projects/${encodeURIComponent(projectId)}/pages`, { query, requestKey: null })
}

export async function listProofreaderTasks(userId, page, perPage) {
  return listPagesWithFallback({
    page,
    perPage,
    filter: relationFilter('proofreader', userId),
    sort: '-updated',
    expand: 'project',
    fields: 'id,page_number,pdf_page,project,status,expand.project.id,expand.project.name'
  })
}

export async function countActiveProofreaderTasks(userId) {
  return countPages(`${relationFilter('proofreader', userId)} && (${statusFilter(PROOFREADER_ACTIVE_STATUSES)})`)
}

export async function getPage(pageId, options = {}) {
  return pb.collection('pages').getOne(pageId, {
    requestKey: null,
    ...options
  })
}

export async function getProofreaderTask(pageId) {
  return pb.send(`/api/fangji/pages/${encodeURIComponent(pageId)}/task`, {
    requestKey: null
  })
}

export async function reorderPendingPages(projectId, orderedIds) {
  return pb.send(`/api/fangji/projects/${encodeURIComponent(projectId)}/pages/reorder`, {
    method: 'POST',
    body: { orderedIds },
    requestKey: null
  })
}

export async function deletePendingPages(projectId, ids) {
  return pb.send(`/api/fangji/projects/${encodeURIComponent(projectId)}/pages/delete-pending`, {
    method: 'POST',
    body: { ids },
    requestKey: null
  })
}

// #124：管理员修正「识别产出」（导入原文）内容。
// expectedUpdated 用于乐观锁，服务端比对不符返回 409。
export async function updatePageContent(projectId, pageId, { rowJson, text, headersJson, expectedUpdated }) {
  return pb.send(`/api/fangji/projects/${encodeURIComponent(projectId)}/pages/${encodeURIComponent(pageId)}/content`, {
    method: 'POST',
    body: { rowJson, text, headersJson, expectedUpdated },
    requestKey: null
  })
}

export async function listAllProjectPages(projectId, options = {}) {
  return pb.collection('pages').getFullList({
    filter: `project="${projectId}"`,
    sort: 'page_number',
    requestKey: null,
    ...options
  })
}

export async function listAllPages(options = {}) {
  return pb.collection('pages').getFullList({
    requestKey: null,
    ...options
  })
}

export async function getPagedProjectPages(projectId, page, perPage, options = {}) {
  return pb.collection('pages').getList(page, perPage, {
    filter: `project="${projectId}"`,
    sort: 'page_number',
    requestKey: null,
    ...options
  })
}

export async function listProofreaderNeighborTasks(projectId, userId) {
  if (!projectId || !userId) return []
  return pb.send(`/api/fangji/projects/${encodeURIComponent(projectId)}/tasks/mine`, {
    requestKey: null
  })
}

export async function claimNextProjectPage(projectId, userId, previousTaskId = '', tier = '') {
  if (!projectId || !userId) throw new Error('缺少项目或校对员身份')
  return pb.send(`/api/fangji/projects/${encodeURIComponent(projectId)}/claim`, {
    method: 'POST',
    // tier 为空串 = 交给服务端按"默认优先 A、没有标签数据则退回原顺序"处理；
    // 传 A/B/C = 只在该层级里领。前端不自己排序，也不猜层级。
    body: { previousTaskId, tier },
    requestKey: null
  })
}

export async function renewTaskLease(pageId, leaseToken) {
  return pb.send(`/api/fangji/pages/${encodeURIComponent(pageId)}/lease/renew`, {
    method: 'POST',
    body: { leaseToken },
    requestKey: null
  })
}

export async function releaseTaskLease(pageId, leaseToken) {
  return pb.send(`/api/fangji/pages/${encodeURIComponent(pageId)}/release`, {
    method: 'POST',
    body: { leaseToken },
    requestKey: null
  })
}

export async function submitTwoPassProofread(pageId, userId, { rowJson, text, leaseToken }) {
  if (!pageId || !userId) throw new Error('缺少任务或校对员身份')
  return pb.send(`/api/fangji/pages/${encodeURIComponent(pageId)}/submit`, {
    method: 'POST',
    body: { rowJson, text, leaseToken },
    requestKey: null
  })
}

// #161 — 疑点只读接口（契约见 docs/plans/2026-09-25-review-findings.md §3.1）。
// 任何失败都退化成空 hints：疑点标注是渐进增强，读不到绝不影响校对本身。
export async function getPageFindings(pageId) {
  if (!pageId) return { page: '', hints: [], truncated: false, suppressedByGate: 0, gateRowsTruncated: false }
  try {
    const result = await pb.send(`/api/fangji/pages/${encodeURIComponent(pageId)}/findings`, {
      requestKey: null
    })
    return {
      page: String(result?.page || pageId),
      hints: Array.isArray(result?.hints) ? result.hints : [],
      truncated: Boolean(result?.truncated),
      // #228 的字段级区分能力：没下发 ≠ 没疑点。缺字段按 0 处理，让老后端不至于报错。
      suppressedByGate: Number.isFinite(Number(result?.suppressed_by_gate))
        ? Math.max(0, Math.floor(Number(result.suppressed_by_gate))) : 0,
      gateRowsTruncated: Boolean(result?.gate_rows_truncated)
    }
  } catch {
    return { page: String(pageId), hints: [], truncated: false, suppressedByGate: 0, gateRowsTruncated: false }
  }
}
