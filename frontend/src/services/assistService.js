import pb from '@/lib/pocketbase'

// #234 管理端机器疑点区块的读取与批处理触发口。
// 四个动作都对应一条已经在 main 上的 manager 路由：本文件只是把它们接到前端，
// 不在前端做任何"判定"——判据都留在后端，避免出现第二份口径。

function query(extra = {}) {
  const parts = []
  for (const [key, value] of Object.entries(extra)) {
    if (value === undefined || value === null || value === '') continue
    parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
  }
  return parts.join('&')
}

export async function listProjectFindings(projectId, { kind = '', producer = '', page = 1, per = 50 } = {}) {
  const search = query({ kind, producer, page, per })
  return pb.send(`/api/fangji/projects/${encodeURIComponent(projectId)}/findings${search ? `?${search}` : ''}`, {
    requestKey: null
  })
}

// 两个重算都是同步执行的长任务（10k 行实测秒级），所以调用方必须自己守住"进行中"，
// 重复点击不会并发跑第二遍 —— 见 ProjectDetailView 的 assistBusy。
export async function recomputeProjectFindings(projectId) {
  return pb.send(`/api/fangji/projects/${encodeURIComponent(projectId)}/findings/recompute`, {
    method: 'POST', body: {}, requestKey: null
  })
}

export async function recomputeProjectIdentity(projectId) {
  return pb.send(`/api/fangji/projects/${encodeURIComponent(projectId)}/identity/recompute`, {
    method: 'POST', body: {}, requestKey: null
  })
}

export async function listProjectDismissals(projectId) {
  return pb.send(`/api/fangji/projects/${encodeURIComponent(projectId)}/dismissals`, { requestKey: null })
}

export async function revokeGroupDismissal(projectId, dismissalId) {
  return pb.send(`/api/fangji/projects/${encodeURIComponent(projectId)}/dismissals/${encodeURIComponent(dismissalId)}`, {
    method: 'DELETE', requestKey: null
  })
}
