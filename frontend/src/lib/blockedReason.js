// #240：条目「阻塞结论」的纯逻辑。
//
// 这里只放"怎么把库里存的东西说清楚"。值域的唯一权威出处是后端
// `pb_hooks/lib/assist_difficulty.js` 的 `BLOCKED_BUCKETS`，下面这份标签表是它的抄本，
// 所以 `frontend/tests/blockedReason.test.js` 里有一条读后端源文件比对键集的防漂测试。
// 就算这份抄本漂了，提交仍然会被后端的白名单挡成 400——错的是下拉，不是库。

// 空串 = 没人说过；'unknown' = 看过但认不出。
// 这两态在库里只差一个值，在决策上差很远：前者是"还没人看"，后者是"看了也定不了"。
export function conclusionState(record) {
  const reason = String(record?.blocked_reason ?? '')
  if (!reason) return 'unset'
  if (reason === 'unknown') return 'unrecognized'
  return 'settled'
}

export const BUCKET_LABELS = {
  glyph_table: '缺字表待查',
  scanned_read: '扫描页需识读',
  column_merge: '列结构待修',
  rights_gate: '授权未决',
  unknown: '看过，认不出卡在哪'
}

export function bucketLabel(reason) {
  const key = String(reason ?? '')
  if (!key) return '（无人登记）'
  return BUCKET_LABELS[key] ?? key
}

// 回读串里必须带 who/when/basis 三件；缺任何一件，这个结论就不可复核。
export function conclusionSummary(record) {
  const state = conclusionState(record)
  if (state === 'unset') return '这条还没有人登记过阻塞原因。'
  const when = String(record?.blocked_reason_at ?? '').slice(0, 16).replace('T', ' ')
  const by = String(record?.blocked_reason_by_name ?? '') || String(record?.blocked_reason_by ?? '') || '（无记录）'
  const basis = String(record?.blocked_reason_note ?? '') || '（无依据）'
  return `${bucketLabel(record?.blocked_reason)}｜登记于 ${when || '（无时间）'}｜依据：${basis}｜登记者：${by}`
}

// 前端只是"少让人白写一次"，真正的口径在后端：basis 必填、值域白名单。
// 这里放开不等于后端会放过，所以文案不许写成"这样就可以提交"。
export function canSubmit({ reason, basis }) {
  return Boolean(String(reason ?? '').trim()) && String(basis ?? '').trim().length > 0
}
