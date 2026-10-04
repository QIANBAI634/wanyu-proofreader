// #162 大厅的层级呈现。
//
// 只有一件事需要判准：**没有 A/B/C 可领时这块 UI 必须整个不出现**（issue 的硬要求 4）。
// 因此"从没算过"（tiers.unlabeled）与"算过但信号不足"（tiers.other，值就是 unknown）
// 都不进可筛选项，而一档都没得筛时返回 null——渲染端据此整块不渲染，
// 而不是显示三个 0 让人以为"这个项目没有简单任务"。
export const TIER_KEYS = ['A', 'B', 'C']

export const TIER_LABELS = {
  A: 'A 类 · 照抄型',
  B: 'B 类 · 需判断',
  C: 'C 类 · 需专业知识'
}

export function tierBreakdown(queue) {
  const tiers = queue?.tiers
  if (!tiers || typeof tiers !== 'object') return null
  // 这块 UI 只做一件事：按层级领任务。所以判据是"有没有 A/B/C 可以领"，
  // 而不是"有没有算过 tier"——一水儿的 unknown 撑起一个空筛选器，比不显示更误导人。
  const options = TIER_KEYS
    .map((key) => ({ key, label: TIER_LABELS[key], count: count(tiers[key]) }))
    .filter((option) => option.count > 0)
  if (!options.length) return null
  const unknownCount = count(tiers.other)
  const unlabeledCount = count(tiers.unlabeled)
  const claimable = count(queue.claimable)
  // #247：对不上账不许静默。可筛 + unknown + 未评估 应当等于 claimable，
  // 少的那部分意味着有条目既没进任何一档、也没进"没算过"——正是分层数字虚高的形态。
  // 多出来（负数）同样是异常（同一页被数了两次），所以原样给出去，由渲染端说成一句话。
  const residual = claimable - options.reduce((total, option) => total + option.count, 0)
    - unknownCount - unlabeledCount
  return {
    options,
    // "other" 就是算过但落 unknown 的那些；它与 unlabeled 都不进可筛选项，
    // 但要在概况里出现，否则用户会发现分层数字加起来对不上。
    unknownCount,
    unlabeledCount,
    claimable,
    residual
  }
}

function count(value) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : 0
}
