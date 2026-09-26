// #177 确定性规则引擎 v1（L0）。
//
// 分工：本文件是**纯函数**——不碰 DAO、不 require 别的 lib、不读全局。
// 需要键盘/角色的上下文由调用方（backend/pb_hooks/assist.pb.js）构造后传进来。
// 好处是每条规则都能在 node 里直接跑单测，不必起服务器。
//
// 移植基准是 #201 入仓的 scripts/corpus_probe/detectors.py（不是 W2 的本机缓存脚本）；
// severity 沿用其 README:59-68 那张「检测函数 → kind → 默认严重度」表的口径。
//
// 边界：本文件只定 finding 的 severity（疑点自身属性）。规则能不能进校对端由
// assist_rule_gates 的 gate 决定，见 docs/plans/2026-09-25-assist-rule-thresholds.md §2；
// 两者不可互相推导，所以这里不出现 gate 字样。

const RULES_VERSION = "l0-v1"

// 莆仙三套方案里合法的三位以上调值只有这两个（detectors.py:28 的 shipped 行为）。
// 原型 anomaly_probe.py 的 13 值 LEGAL 集合在 #201 移植时被刻意删除；
// 引进来会把「≥3 位且非 533/453」放宽，与已入仓且有正反用例的行为不一致。
const LEGAL_LONG_TONES = ["533", "453"]
const PLACEHOLDER = /@[0-9a-fA-F]{4,6}/g
const READING_FIELDS = ["拼音", "莆田IPA", "仙游IPA"]
const IPA_FIELDS = ["莆田IPA", "仙游IPA"]
const MEANING_FIELDS = ["释义"]
const REQUIRED_ROLES = ["headword", "reading", "meaning"]

// R1 的放行区段 = detectors.py 的 ALLOWED_NON_REPERTOIRE_RANGES 同义：
// 记音列出现汉字属结构问题（merged_columns），不是「校对员打出了打不出的字符」；
// 非 BMP 汉字已有自己的 kind（outside_unicode_set），不在这里二次报。
const ALLOWED_RANGES = [
  [0x0020, 0x007e], // ASCII 可见
  [0x00a0, 0x02af], // 拉丁扩展 + IPA
  [0x0300, 0x036f], // 组合附加符
  [0x2000, 0x206f], // 通用标点
  [0x3000, 0x303f], // CJK 符号与标点（含 〔〕）
  [0x3400, 0x4dbf], // 扩展 A
  [0x4e00, 0x9fff], // 统一表意
  [0xf900, 0xfaff], // 兼容表意
  [0x20000, 0x2fa1f] // 全部非 BMP 汉字块
]

// R7 的两个判据阈值必须先写定再实现（#177 正文的前置要求；改动要走新 PR，
// 并在 docs/plans/2026-09-25-assist-rules.md 的 R7 节同步）：
//   · 单调性：pdf_page 相比条目顺序回退超过容差 → 一条异常；
//   · 密度：某页条目数 > max(中位数 + 最小增量, 中位数 × 倍数) → 离群；
//     中位数至少要有 MIN_PAGES 页样本，样本不足直接跳过（不给假数字）。
const PAGE_ORDER_BACKTRACK_TOLERANCE = 1
const PAGE_DENSITY_MEDIAN_MULTIPLIER = 3
const PAGE_DENSITY_MIN_EXTRA = 8
const PAGE_DENSITY_MIN_PAGES = 20

function inAllowed(code) {
  return ALLOWED_RANGES.some(([low, high]) => code >= low && code <= high)
}

function codepointLabel(code) {
  return `U+${Number(code).toString(16).toUpperCase().padStart(4, "0")}`
}

function isEmpty(value) {
  return String(value ?? "").trim() === ""
}

// 键盘字符并集：只取码位。组合符序列（如 ã = a+U+0303）拆成逐个码位收进集合，
// 否则记音里合法的鼻化标记会被 R1 报成集外字符。
function repertoireOf(keyboards) {
  const allowed = new Set()
  for (const item of keyboards ?? []) {
    for (const section of item?.definition?.sections ?? []) {
      for (const key of section?.keys ?? []) {
        for (const ch of Array.from(String(key?.value ?? ""))) allowed.add(ch.codePointAt(0))
      }
    }
  }
  return allowed
}

// R2 的混淆表编译自键盘 hint（#175 想法 1）。hint 文本同时给出目标码位和
// 「长得像的那个 ASCII」，例如「插入 ɑ（音标，区别于普通 a；U+0251）」。
// 解析不出来就不收：宁可少一条规则，也不凭猜测造表。
function confusablesOf(keyboards) {
  const byLookalike = new Map()
  for (const item of keyboards ?? []) {
    for (const section of item?.definition?.sections ?? []) {
      for (const key of section?.keys ?? []) {
        const value = String(key?.value ?? "")
        const hint = String(key?.hint ?? "")
        const chars = Array.from(value)
        if (!hint || chars.length !== 1) continue
        const target = chars[0].codePointAt(0)
        if (target <= 0x7e) continue
        if (!hint.includes("区别于")) continue
        // hint 里的码位写法是补零的（U+0251 而不是 U+251），所以要按数值比对，
        // 不能拿 target.toString(16) 去匹配字符串——那样每个补零的键都会被跳过。
        const declared = [...hint.matchAll(/U\+([0-9a-fA-F]{1,6})/g)].map((m) => parseInt(m[1], 16))
        if (!declared.includes(target)) continue
        const inside = (hint.match(/[（(]([^）)]*)[）)]/)?.[1] ?? "")
          // hint 里自带 U+0251 这样的码位写法，不先摘掉会把 U、+、0、2、5、1
          // 当成"长得像的 ASCII"收进表里。
          .replace(/U\+[0-9a-fA-F]{4,6}/g, "")
        const lookalikes = new Set()
        for (const ch of inside) {
          const code = ch.codePointAt(0)
          if (code >= 0x21 && code <= 0x7e) lookalikes.add(ch)
        }
        for (const ascii of lookalikes) {
          const bucket = byLookalike.get(ascii) ?? []
          if (!bucket.includes(codepointLabel(target))) bucket.push(codepointLabel(target))
          byLookalike.set(ascii, bucket)
        }
      }
    }
  }
  return byLookalike
}

function makeContext({ projectId = "", keyboards = [], roles = null, readingFields = READING_FIELDS,
  meaningFields = MEANING_FIELDS, ipaFields = IPA_FIELDS } = {}) {
  return {
    projectId,
    producerVersion: RULES_VERSION,
    repertoire: repertoireOf(keyboards),
    confusables: confusablesOf(keyboards),
    readingFields: [...readingFields],
    meaningFields: [...meaningFields],
    ipaFields: [...ipaFields],
    roles
  }
}

const finding = (kind, severity, field, message_key, params = {}, evidence = {}) =>
  ({ kind, severity, field, message_key, params, evidence })

// ---- R1 char_out_of_repertoire ----
function ruleCharOutOfRepertoire(ctx, row) {
  const out = []
  for (const [field, value] of Object.entries(row ?? {})) {
    if (isEmpty(value)) continue
    const seen = new Set()
    for (const ch of Array.from(String(value))) {
      const code = ch.codePointAt(0)
      if (!inAllowed(code) && !ctx.repertoire.has(code)) seen.add(code)
    }
    if (!seen.size) continue
    out.push(finding("char_out_of_repertoire", "warn", field, "non_ipa_range_codepoints",
      { codepoints: [...seen].sort((a, b) => a - b).map(codepointLabel) }))
  }
  return out
}

// ---- R2 confusable_substitution ----
function ruleConfusables(ctx, row) {
  const out = []
  if (!ctx.confusables.size) return out
  for (const [field, value] of Object.entries(row ?? {})) {
    // 只查 IPA 列：`拼音` 用拉丁字母是方案本身规定的，把 a 当 ɑ 的误报会淹没真信号。
    if (isEmpty(value) || !ctx.ipaFields.includes(field)) continue
    const hits = []
    let position = 0
    for (const ch of Array.from(String(value))) {
      position += 1
      const suggested = ctx.confusables.get(ch)
      if (suggested) hits.push({ found: codepointLabel(ch.codePointAt(0)), position, suggested })
    }
    if (!hits.length) continue
    // 同一格只报一条并列出所有位置：一格里三个 a 不该产出三条 finding。
    out.push(finding("confusable_substitution", "warn", field, "confusable_ascii_in_reading", {
      suggestions: hits.map((hit) => ({ found: hit.found, suggested: hit.suggested })),
      positions: hits.map((hit) => hit.position),
      hit_count: hits.length
    }))
  }
  return out
}

// Mn（非间距组合标记）——对齐 detectors.py 的 unicodedata.category(c) == "Mn"。
// 只覆盖记音实际用到的组合符区段，为的是零新依赖（不引 Unicode 属性库）。
function isCombining(ch) {
  const code = ch.codePointAt(0)
  return code >= 0x300 && code <= 0x36f
}

// ---- R3 encoding_form_anomaly（格级；列级见 ruleColumnForms）----
function ruleCombiningMarks(ctx, row) {
  const out = []
  for (const [field, value] of Object.entries(row ?? {})) {
    if (isEmpty(value) || !ctx.readingFields.includes(field)) continue
    const marks = new Set()
    for (const ch of Array.from(String(value))) {
      if (isCombining(ch)) marks.add(ch.codePointAt(0))
    }
    if (!marks.size) continue
    out.push(finding("encoding_form_anomaly", "info", field, "combining_marks_present",
      { marks: [...marks].sort((a, b) => a - b).map(codepointLabel) }))
  }
  return out
}

// 列级：同一列 NFC 与 NFD 并存时报少数派。需要整列，所以只在批处理路径跑。
// 只提示，**不改写任何值**（#177 非目标）。
function ruleColumnForms(columns) {
  const out = []
  for (const [field, values] of Object.entries(columns ?? {})) {
    let nfc = 0
    let nfd = 0
    for (const value of values ?? []) {
      if (isEmpty(value)) continue
      const text = String(value)
      const inNfc = text === text.normalize("NFC")
      const inNfd = text === text.normalize("NFD")
      if (inNfc && !inNfd) nfc += 1
      else if (inNfd && !inNfc) nfd += 1
    }
    if (!nfc || !nfd) continue
    out.push(finding("encoding_form_anomaly", "warn", field, "mixed_normalization_forms",
      { minority: nfc >= nfd ? "nfd" : "nfc", nfc, nfd }))
  }
  return out
}

// ---- R4 punctuation_mix（列级：同列全/半角混用）----
const PUNCT_PAIRS = [["（", "("], ["）", ")"], ["；", ";"], ["［", "["], ["］", "]"],
  ["【", "["], ["】", "]"], ["，", ","]]

function rulePunctuationMix(columns) {
  const out = []
  for (const [field, values] of Object.entries(columns ?? {})) {
    const used = new Set()
    for (const value of values ?? []) {
      for (const ch of Array.from(String(value ?? ""))) used.add(ch)
    }
    const pairs = PUNCT_PAIRS
      .filter(([full, half]) => used.has(full) && used.has(half))
      .map(([full, half]) => ({ full: codepointLabel(full.codePointAt(0)),
        half: codepointLabel(half.codePointAt(0)) }))
    if (!pairs.length) continue
    out.push(finding("punctuation_mix", "warn", field, "punctuation_width_mixed_in_column",
      { pairs, pair_count: pairs.length }))
  }
  return out
}

// ---- R5 missing_field（依赖 #170 的列角色；无角色时安全跳过）----
function ruleMissingField(ctx, row) {
  const out = []
  const roles = ctx.roles
  if (!roles || !Object.keys(roles).length) return out
  for (const [field, role] of Object.entries(roles)) {
    if (!REQUIRED_ROLES.includes(role)) continue
    if (isEmpty(row?.[field])) out.push(finding("missing_field", "strong", field,
      "required_role_field_empty", { role }))
  }
  return out
}

// ---- R6 reading_format_invalid ----
function toneDigits(text) {
  return (String(text ?? "").match(/[1-7]/g) ?? []).length
}

function ruleReadingFormat(ctx, row) {
  const out = []
  const counts = {}
  for (const [field, value] of Object.entries(row ?? {})) {
    if (!ctx.readingFields.includes(field) || isEmpty(value)) continue
    const stripped = String(value).replace(PLACEHOLDER, "")
    // 占位符里的十六进制先剔除：@20000 带五位数字串，那是缺字登记序号不是压平声调，
    // 两条都报会让同一格挂上两个 strong。
    const runs = (stripped.match(/\d{3,}/g) ?? []).filter((run) => !LEGAL_LONG_TONES.includes(run))
    if (runs.length) {
      out.push(finding("reading_format_invalid", "strong", field, "long_digit_run",
        { runs, run_count: runs.length }))
    }
    counts[field] = toneDigits(value)
  }
  const left = counts["拼音"]
  const right = counts["莆田IPA"]
  // 两列都在本行出现过才比，缺列不猜（与入仓版一致，只比这两列）。
  if (left !== undefined && right !== undefined && left !== right) {
    out.push(finding("reading_format_invalid", "warn", "莆田IPA", "tone_token_count_differs",
      { pinyin_count: left, ipa_count: right }))
  }
  return out
}

// ---- R7 page_outlier（项目级）----
function rulePageOrderBacktrack(entries) {
  const out = []
  let highest = null
  for (const entry of entries.slice().sort((a, b) => a.order - b.order)) {
    const page = Number(entry.pdfPage) || 0
    if (highest !== null && page > 0 && page < highest - PAGE_ORDER_BACKTRACK_TOLERANCE) {
      out.push(finding("page_outlier", "warn", "", "pdf_page_backtrack", {
        from_page: highest, to_page: page, backtrack: highest - page
      }, { page }))
    }
    if (page > (highest ?? 0)) highest = page
  }
  return out
}

function rulePageDensityOutliers(entries) {
  const perPage = new Map()
  for (const entry of entries ?? []) {
    const page = Number(entry.pdfPage) || 0
    if (page > 0) perPage.set(page, (perPage.get(page) ?? 0) + 1)
  }
  if (perPage.size < PAGE_DENSITY_MIN_PAGES) return []
  const counts = [...perPage.values()].sort((a, b) => a - b)
  const median = counts[Math.floor(counts.length / 2)]
  const ceiling = Math.max(median * PAGE_DENSITY_MEDIAN_MULTIPLIER, median + PAGE_DENSITY_MIN_EXTRA)
  const out = []
  for (const [page, count] of [...perPage].sort((a, b) => a[0] - b[0])) {
    if (count <= ceiling) continue
    out.push(finding("page_outlier", "warn", "", "page_entry_count_outlier",
      { entries_on_page: count, median_entries: median, ceiling }, { page }))
  }
  return out
}

// 单条目格级规则：导入与提交路径都只跑这一组，必须便宜。
function runPageRules(ctx, row) {
  // 因果抑制（同格结构损坏时不再重复报集外字符）留到 #178：
  // merged_columns 由 #178/#125 产出，本文件的规则一条都不产它，
  // 现在写抑制逻辑是一段没有触发路径的死代码。
  return [
    ...ruleCharOutOfRepertoire(ctx, row),
    ...ruleConfusables(ctx, row),
    ...ruleCombiningMarks(ctx, row),
    ...ruleReadingFormat(ctx, row),
    ...ruleMissingField(ctx, row)
  ]
}

// 单条目路径用的入口：格级规则 + 挂靠标记。挂哪一条目由调用方给，本函数不猜。
function runEntryRules(ctx, row, pageId) {
  return runPageRules(ctx, row).map((item) => anchored(item, pageId, ANCHOR_ENTRY))
}

// 项目级批处理：列级(R3/R4) 与页级(R7) 规则加上逐条格级规则。
//
// entries = [{ pageId, order, pdfPage, row }]：条目归属与行内容**必须一起来**。
// 上一版把 rows / columns / entries 分三个参数传，摊平后 finding 里没有任何条目
// 标识，写入端只能猜挂靠——结果是除 R7 以外的全部疑点都落到项目第一条条目上，
// 别人的原样内容片段就发到了这一条的在手校对员手上（#208 评审阻断 1）。
// 现在本函数负责决定挂靠，返回值每条都带 page(条目 id)，写入端只认这个字段。
// 列由条目现攒，避免「第 i 行对不上第 i 个条目」这类错位还有存在的空间。
//
// 挂靠口径（#176 规定 review_findings.page 必填，所以列级疑点也必须落在某一条上）：
// - 格级/行级(R1/R2/R3格级/R5/R6) → 它所属的条目，scope=entry；
// - 列级(R3列级/R4) → 扫描顺序第一条，scope=column_first_entry。列级 params 只有
//   计数与码位标签、不含任何原样内容片段（assist_rules_integration.mjs 钉住了这一点），
//   真正的消费方是管理端项目级读口；这条取舍写进 docs/plans/2026-09-25-assist-rules.md；
// - 页级(R7) → 该 PDF 页扫描顺序里的第一个条目，scope=pdf_page_first_entry；
//   解析不出条目就返回 page=""，由写入端跳过并计数，绝不退化成"挂到第一条"。
const ANCHOR_ENTRY = "entry"
const ANCHOR_COLUMN = "column_first_entry"
const ANCHOR_PDF_PAGE = "pdf_page_first_entry"
// 只有**项目级**规则才会产出的 message_key：列级(R3 列级 / R4) 与页级(R7 两个判据)。
// 单条目重算只能重新判定格级规则，所以下线旧批次时必须把这两类一起排除——否则
// "给某一条补算"会顺手抹掉挂在它身上的项目级疑点，而那些只有项目级重算才会重新产出。
// 上一轮我只排除了列级两条、漏了 R7：同一件事在页级上照样成立（#212 的评审抓到这条，
// 并据此判定链上先不许合入）。现在的划分是"格级 / 项目级"两类，
// assist_rules_integration.mjs 断言两者恰好覆盖引擎产出的全部 key 且互不相交，
// 所以新增规则时必须归类，漏归类会在 runProjectRules 里直接抛错。
const CELL_MESSAGE_KEYS = [
  "non_ipa_range_codepoints", "confusable_ascii_in_reading", "combining_marks_present",
  "long_digit_run", "tone_token_count_differs", "required_role_field_empty"
]
const PROJECT_ONLY_MESSAGE_KEYS = [
  "mixed_normalization_forms", "punctuation_width_mixed_in_column",
  "pdf_page_backtrack", "page_entry_count_outlier"
]

function anchored(item, pageId, scope) {
  return {
    ...item,
    page: pageId ?? "",
    evidence: { ...(item.evidence ?? {}), anchor: scope }
  }
}

function columnsOf(entries) {
  const columns = {}
  for (const entry of entries) {
    for (const [field, value] of Object.entries(entry.row ?? {})) {
      if (!columns[field]) columns[field] = []
      columns[field].push(value)
    }
  }
  return columns
}

function runProjectRules(ctx, entries) {
  const list = entries ?? []
  const columns = columnsOf(list)
  const out = []
  for (const entry of list) {
    for (const item of runPageRules(ctx, entry.row)) {
      if (!CELL_MESSAGE_KEYS.includes(item.message_key)) {
        // 新增格级规则却没登记进 CELL_MESSAGE_KEYS：不挡就会静默漏掉，而且症状出现在
        // 别处（项目级疑点被单条重算吃掉），所以在这里直接抛错。
        throw new Error(`规则产出 ${item.message_key} 未归类到 CELL/PROJECT_ONLY key 清单`)
      }
      out.push(anchored(item, entry.pageId, ANCHOR_ENTRY))
    }
  }
  const columnAnchor = list.length ? list[0].pageId : ""
  for (const item of [...ruleColumnForms(columns), ...rulePunctuationMix(columns)]) {
    out.push(anchored(item, columnAnchor, ANCHOR_COLUMN))
  }
  for (const item of [...rulePageOrderBacktrack(list), ...rulePageDensityOutliers(list)]) {
    const owner = list.find((entry) => (Number(entry.pdfPage) || 0) === item.evidence?.page)
    out.push(anchored(item, owner?.pageId, ANCHOR_PDF_PAGE))
  }
  return out
}

module.exports = {
  RULES_VERSION,
  ANCHOR_ENTRY,
  ANCHOR_COLUMN,
  ANCHOR_PDF_PAGE,
  CELL_MESSAGE_KEYS,
  PROJECT_ONLY_MESSAGE_KEYS,
  LEGAL_LONG_TONES,
  READING_FIELDS,
  IPA_FIELDS,
  MEANING_FIELDS,
  REQUIRED_ROLES,
  ALLOWED_RANGES,
  PUNCT_PAIRS,
  PAGE_ORDER_BACKTRACK_TOLERANCE,
  PAGE_DENSITY_MEDIAN_MULTIPLIER,
  PAGE_DENSITY_MIN_EXTRA,
  PAGE_DENSITY_MIN_PAGES,
  codepointLabel,
  isEmpty,
  inAllowed,
  isCombining,
  repertoireOf,
  confusablesOf,
  makeContext,
  ruleCharOutOfRepertoire,
  ruleConfusables,
  ruleColumnForms,
  rulePunctuationMix,
  ruleMissingField,
  ruleReadingFormat,
  rulePageOrderBacktrack,
  rulePageDensityOutliers,
  ruleCombiningMarks,
  runPageRules,
  runEntryRules,
  runProjectRules
}
