// 退回队列：志愿者勾选「要退回 A 线」的条目，暂存到本地，审完一批后一键全部退回。
// 用 localStorage 持久化（刷新/浏览器崩溃后还在），并记住「队列模式」开关。

export const RETURN_REASONS = [
  { value: 'source_missing', label: '没登记来源' },
  { value: 'misplaced_content', label: '内容错位' },
  { value: 'rights_pending', label: '授权待定' },
  { value: 'text_mismatch', label: '和原书对不上' }
]

const QUEUE_KEY = 'fangji:return-queue:v1'
const MODE_KEY = 'fangji:return-queue-mode:v1'

export function loadReturnQueue(storage) {
  if (!storage) return []
  try {
    const parsed = JSON.parse(storage.getItem(QUEUE_KEY) || '[]')
    if (!Array.isArray(parsed)) return []
    return parsed.filter((item) => item && typeof item.pageId === 'string' && typeof item.reason === 'string')
  } catch {
    return []
  }
}

export function saveReturnQueue(storage, queue) {
  if (!storage) return
  storage.setItem(QUEUE_KEY, JSON.stringify(queue))
}

export function loadQueueMode(storage) {
  return Boolean(storage) && storage.getItem(MODE_KEY) === '1'
}

export function saveQueueMode(storage, enabled) {
  if (!storage) return
  if (enabled) storage.setItem(MODE_KEY, '1')
  else storage.removeItem(MODE_KEY)
}
