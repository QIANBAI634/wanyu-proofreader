// #190 拼音归一的纯呈现逻辑。
//
// 放在 lib/ 而不是 services/：这里全是可单测的纯函数，而 services 里的模块会 import
// pocketbase 客户端，用 node:test 直接跑时解析不了 Vite 的 @/ 别名。

export const NORMALIZATION_STATUS_LABELS = {
  EXACT: '自动确定',
  REVIEWED: '已复核',
  AMBIGUOUS: '需人工确认',
  UNSUPPORTED: '暂未支持'
}

export const CONVERSION_JOB_STATUS_LABELS = {
  queued: '排队中',
  processing: '转换中',
  completed: '已完成',
  completed_with_errors: '完成，部分条目写入失败',
  failed: '失败'
}

export function normalizationStatusLabel(value) {
  return NORMALIZATION_STATUS_LABELS[value] || value || '未转换'
}

// 只复用 style.css 里已有的 badge-* 修饰类，不为这四个状态新造配色。
export function normalizationBadgeClass(value) {
  if (value === 'EXACT') return 'badge badge-approved'
  if (value === 'REVIEWED') return 'badge badge-proofread'
  if (value === 'AMBIGUOUS') return 'badge badge-arbitration'
  if (value === 'UNSUPPORTED') return 'badge badge-rejected'
  return 'badge'
}

export function conversionJobStatusLabel(status) {
  return CONVERSION_JOB_STATUS_LABELS[status] || status || '未开始'
}

// conversionSummaryLines 产 #114 §8 的那几行。
//
// 「自动确定」= EXACT + REVIEWED：两条都是**不需要人看**的结论（REVIEWED 是例外表
// 已经给出过的结论），把它们分开列会让「跑了 10000 条、其中 9720 条自动确定」这句话
// 对不上——而那正是 #114 §8 用来判断这批数据要不要人工介入的数字。
//
// 「跳过」与「处理失败」都不属于那四行：前者是「这一次没有转换它」（没有可转换的值、
// 或已经有人复核过），后者是「试过但没写进去」。两条各自单列出来，四行之和与它们
// 加起来才等于共处理；混进去会让差额无从解释。
//
// 失败必须单列，不能像原来那样被丢掉：后端三个失败分支都是 failed++ **且** total++，
// 所以漏掉它时「完成，部分条目写入失败」的作业在界面上会呈现一个 共处理 比其余行
// 之和大出一截、且没有任何一行能解释的差额——而这一行的存在正是为了让差额可解释。
export function conversionSummaryLines(job) {
  const value = (key) => Number(job?.[`${key}_count`] || 0)
  const exact = value('exact')
  const reviewed = value('reviewed')
  return [
    { key: 'total', label: '共处理', count: value('total') },
    { key: 'auto', label: '自动确定', count: exact + reviewed },
    { key: 'ambiguous', label: '需人工确认', count: value('ambiguous') },
    { key: 'unsupported', label: '暂未支持', count: value('unsupported') },
    { key: 'skipped', label: '跳过', count: value('skipped') },
    { key: 'failed', label: '处理失败', count: value('failed') }
  ]
}

// hasAdapterNotice 判断「本实例还没有可用方案」这个状态要不要显示。
// 它必须与「跑完了但一条都没转」区分开：后者是结果，前者是配置还没做。
export function adapterNotice(adapters) {
  return String(adapters?.notice || '').trim()
}

// schemeOptionLabel 是方案选择器里的一行。rule_status 必须画出来：规则文件自己声明了
// 它能不能创建真实作业，而这件事要在点「生成统一拼音」之前就看得见——等一个 400 回来
// 才知道，管理员会以为是界面坏了。
//
// 判断写 `=== 'production'` 而不是 `!== 'test'`：将来多一个取值时，不认识的那个必须落在
// 「不能跑真实作业」这一侧，与后端 scheme.MayDriveRealJobs 同一口径。
export function schemeOptionLabel(item) {
  const base = `${item?.source_scheme_id || '（未命名）'} → ${item?.canonical_scheme_id || '（未命名）'}（${item?.rule_version || '未标注版本'}）`
  return item?.rule_status === 'production' ? base : `${base}· 仅测试`
}

// testOnlySchemeIds 挑出规则目录里声明为测试的那些方案 id，供选择器下面补一句说明。
// 一句话说清「可以选中、但服务端会拒绝」，比在选项里塞一整句更长的话更读得下去。
export function testOnlySchemeIds(schemes) {
  return (schemes || [])
    .filter((item) => item?.rule_status !== 'production')
    .map((item) => item?.source_scheme_id)
    .filter(Boolean)
}
