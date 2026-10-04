import pb from '@/lib/pocketbase'

// #240：条目阻塞结论的三个接口。权限口径由维护者定为 (B)——只有平台管理员能读写，
// 所以这里不做"前端判断完再决定要不要发请求"那套：接口自己会 403，界面按 403 显示。

export function getBlockedReason(pageId) {
  return pb.send(`/api/fangji/pages/${encodeURIComponent(pageId)}/blocked-reason`, { requestKey: null })
}

export function setBlockedReason(pageId, payload) {
  return pb.send(`/api/fangji/pages/${encodeURIComponent(pageId)}/blocked-reason`, {
    method: 'PUT', body: payload, requestKey: null
  })
}

export function clearBlockedReason(pageId) {
  return pb.send(`/api/fangji/pages/${encodeURIComponent(pageId)}/blocked-reason`, {
    method: 'DELETE', requestKey: null
  })
}
