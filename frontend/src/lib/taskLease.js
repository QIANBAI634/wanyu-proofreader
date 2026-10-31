const leaseKeyPrefix = 'fangji:task-lease:v1'

export function taskLeaseKey(userId, pageId) {
  return `${leaseKeyPrefix}:${encodeURIComponent(userId || '')}:${encodeURIComponent(pageId || '')}`
}

export function saveTaskLease(storage, { userId, pageId, token, expiresAt }) {
  if (!storage || !userId || !pageId || !token) return null
  const lease = { token: String(token), expiresAt: String(expiresAt || '') }
  storage.setItem(taskLeaseKey(userId, pageId), JSON.stringify(lease))
  return lease
}

export function loadTaskLease(storage, { userId, pageId }) {
  if (!storage || !userId || !pageId) return null
  try {
    const lease = JSON.parse(storage.getItem(taskLeaseKey(userId, pageId)) || 'null')
    if (!lease || typeof lease.token !== 'string' || lease.token.length < 32) return null
    return { token: lease.token, expiresAt: String(lease.expiresAt || '') }
  } catch {
    return null
  }
}

export function clearTaskLease(storage, { userId, pageId }) {
  if (!storage || !userId || !pageId) return
  storage.removeItem(taskLeaseKey(userId, pageId))
}

export function leaseExpiresSoon(expiresAt, now = Date.now(), thresholdMs = 3 * 60 * 1000) {
  const expiry = new Date(expiresAt).getTime()
  return !Number.isFinite(expiry) || expiry - now <= thresholdMs
}

// 「缺字待登记」队列选择：从大厅点进缺字按钮后，续领要一直在缺字队列里，而不是
// 处理一条就退回混合队列。用 sessionStorage 按用户 + 项目记住这个选择。
const glyphQueueKeyPrefix = 'fangji:glyph-queue:v1'

export function glyphQueueKey(userId, projectId) {
  return `${glyphQueueKeyPrefix}:${encodeURIComponent(userId || '')}:${encodeURIComponent(projectId || '')}`
}

export function saveGlyphQueue(storage, { userId, projectId, glyph }) {
  if (!storage || !userId || !projectId) return
  if (glyph) storage.setItem(glyphQueueKey(userId, projectId), '1')
  else storage.removeItem(glyphQueueKey(userId, projectId))
}

export function loadGlyphQueue(storage, { userId, projectId }) {
  if (!storage || !userId || !projectId) return false
  return storage.getItem(glyphQueueKey(userId, projectId)) === '1'
}
