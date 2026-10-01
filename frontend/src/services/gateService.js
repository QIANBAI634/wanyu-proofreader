import pb from '@/lib/pocketbase'

// #228 门控登记表的三个管理端接口。都只对平台管理员开放（规则身份跨项目共用，
// 项目 manager 能重算自己项目的疑点，但不能决定某条规则全网放不放行）。

export function listGates({ limit = 200, offset = 0 } = {}) {
  const size = Math.max(1, Math.min(1000, Number(limit) || 200))
  const start = Math.max(0, Number(offset) || 0)
  return pb.send(`/api/fangji/gates?limit=${size}&offset=${start}`, { method: 'GET', requestKey: null })
}

export function applyGateChangeset(payload) {
  return pb.send('/api/fangji/gates/changeset', { method: 'POST', body: payload, requestKey: null })
}

export function revokeGate(body) {
  return pb.send('/api/fangji/gates/revoke', { method: 'POST', body, requestKey: null })
}
