// 结构化行的纯函数层——与 Vue 无关，可被前端组件与集成测试共用。
//
// 从 useStructuredRow.js 拆出，解决「测试手抄副本 vs 生产实现」双份漂移问题：
// 前端 useStructuredRow 从这里再导出，集成测试也直接从本文件 import，
// 一份实现，两处消费。

export function safeParseRowJson(raw) {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw)
    if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') return null
    return parsed
  } catch {
    return null
  }
}

// JSON object enumeration reorders integer-like keys; keep CSV order explicitly.
export function orderedRowHeaders(page, row) {
  let saved = []
  try { saved = JSON.parse(page?.row_headers_json || '[]') } catch { /* corrupt saved order must not block rendering; fall back to key order */ }
  const keys = Object.keys(row || {})
  return [...new Set([...(Array.isArray(saved) ? saved.filter((key) => typeof key === 'string' && keys.includes(key)) : []), ...keys])]
}
