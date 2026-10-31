// 退回队列：志愿者勾选「要退回 A 线」的条目，暂存到本地，审完一批后一键全部退回。
// 用 localStorage 持久化（刷新/浏览器崩溃后还在），并记住「队列模式」开关。
// 键名按 userId 作用域隔离，避免同一浏览器切换账号后读到上一账号攒的条目。

export const RETURN_REASONS = [
  { value: 'source_missing', label: '没登记来源' },
  { value: 'misplaced_content', label: '内容错位' },
  { value: 'rights_pending', label: '授权待定' },
  { value: 'text_mismatch', label: '和原书对不上' }
]

const QUEUE_KEY_PREFIX = 'fangji:return-queue:v1'
const MODE_KEY_PREFIX = 'fangji:return-queue-mode:v1'

export function returnQueueKey(userId) {
  return `${QUEUE_KEY_PREFIX}:${encodeURIComponent(userId || '')}`
}

export function returnQueueModeKey(userId) {
  return `${MODE_KEY_PREFIX}:${encodeURIComponent(userId || '')}`
}

export function loadReturnQueue(storage, userId) {
  if (!storage || !userId) return []
  try {
    const parsed = JSON.parse(storage.getItem(returnQueueKey(userId)) || '[]')
    if (!Array.isArray(parsed)) return []
    return parsed.filter((item) => item && typeof item.pageId === 'string' && typeof item.reason === 'string')
  } catch {
    return []
  }
}

export function saveReturnQueue(storage, queue, userId) {
  if (!storage || !userId) return
  storage.setItem(returnQueueKey(userId), JSON.stringify(queue))
}

export function loadQueueMode(storage, userId) {
  return Boolean(storage && userId) && storage.getItem(returnQueueModeKey(userId)) === '1'
}

export function saveQueueMode(storage, enabled, userId) {
  if (!storage || !userId) return
  if (enabled) storage.setItem(returnQueueModeKey(userId), '1')
  else storage.removeItem(returnQueueModeKey(userId))
}
