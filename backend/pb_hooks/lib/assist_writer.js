// #177 的写入侧：把纯函数规则的输出落成 #176 的 review_findings 批次。
//
// 只追加，不改写：重算 = 插入新批次 + 把**同 producer 的**旧批次标 superseded_at。
// 只标同 producer 是有意的——规则重算不该把 OCR(#125) 或 bundle_import(#124) 的
// 疑点一起下线，三类生产者各有各的批次生命周期。
//
// 这里全部走 DAO（$app.save），不经过 API，因此 #176 的 onRecordUpdateRequest
// 只覆写守卫不会拦它；对应地，本文件只允许两种写：插入、以及把 superseded_at 从空改成非空。

// 依赖在函数内 require：仓内 lib 之间的互相引用一律发生在调用期，
// 顶层 require 在本机 JSVM 没有先例（.pb.js 的顶层绑定在回调里读不到）。

const PRODUCER = "rule"
// 条目游标：每次读 PAGE_SCAN_CHUNK 条，翻完为止——#177 与 #178 都要求 10k 行项目能全量跑通，
// 所以这里**不能有硬上限**：一个 PAGE_SCAN_CAP 常数会把超出部分静默丢掉，报告仍然写得像
// "算完了"，而按 project 全量下线会让第 5001 条往后的当前批次被标 superseded 却没有新批次
// 替换（#208 评审阻断 2）。现在只有两种结局：整批扫完，或在**任何写入之前**抛错拒算；
// 规模上限因此由耗时决定，代码里只留一条内存保险丝。
const PAGE_SCAN_CHUNK = 1000
// 通用分块读取的块大小。
const READ_CHUNK = 1000
// 内存保险丝，不是正确性上限：命中它就抛错，已落库的疑点一条都不动。
// 实测：10k 行项目端到端 6.1 s（backend/tests/measure_identity_scale.py）。
const PROJECT_SCAN_REFUSAL = 50000
// 下线旧批次时的读取块大小（见 retire）。
const RETIRE_CHUNK = 1000

// #177 与 #178 都用 producer = "rule"，但各自只该下线自己那批 kind。
// 不按 kind 收口的话，跑一次 #177 的全量重算会把 #178 的跨行疑点全部标 superseded，
// 反之亦然——两边各自看自己的表都"正常"，串起来才看得见。
const RULE_KINDS = [
  "char_out_of_repertoire", "confusable_substitution", "encoding_form_anomaly",
  "missing_field", "reading_format_invalid", "punctuation_mix", "page_outlier"
]
const IDENTITY_KINDS = ["duplicate_identity", "cross_source_conflict", "merged_columns"]

function kindClause(kinds) {
  return "(" + kinds.map((kind) => `kind = "${kind}"`).join(" || ") + ")"
}

function nowStamp() {
  return new Date().toISOString()
}

function parseRow(raw) {
  const text = String(raw || "")
  if (!text) return {}
  try {
    const parsed = JSON.parse(text)
    if (parsed && !Array.isArray(parsed) && typeof parsed === "object") return parsed
  } catch {
    return {}
  }
  return {}
}

// 校对员刚提交的内容优先；没有就退回导入原文。
// 不用 pages.proofread_row_json 之外的字段推断轮次，也不把他人结果算进上下文。
function rowForRules(page) {
  const canonical = parseRow(page.get("proofread_row_json"))
  if (Object.keys(canonical).length) return canonical
  return parseRow(page.get("ocr_row_json"))
}

function contextFor(dao, page) {
  const { makeContext } = require(`${__hooks}/lib/assist_rules.js`)
  const { projectConfig: proofProjectConfig } = require(`${__hooks}/lib/keyboards.js`)
  const projectId = page.getString("project")
  return makeContext({
    projectId,
    // 列角色(#170) 未落地前一律传 null：R5 会安全跳过，不会拿列名猜角色。
    roles: null,
    keyboards: projectId ? proofProjectConfig(dao, projectId).items : []
  })
}

function insertFinding(dao, collection, page, row, at, producerVersion) {
  const record = new Record(collection)
  record.set("project", page.getString("project"))
  record.set("page", page.id)
  record.set("field_name", row.field || "")
  record.set("kind", row.kind)
  record.set("severity", row.severity)
  record.set("message_key", row.message_key)
  record.set("params_json", JSON.stringify(row.params ?? {}))
  record.set("evidence_json", JSON.stringify(row.evidence ?? {}))
  record.set("producer", PRODUCER)
  record.set("producer_version", producerVersion)
  record.set("produced_at", at)
  dao.save(record)
  return record
}

// 逐块下线，读到空为止。
//
// 为什么不是"一次读 10 万条然后遍历"：那是 #208 评审阻断 2 的镜像形状。读满上限之后
// 剩下的行不会被下线，于是它们永远以「当前批次」的身份留在库里——校对端读到的是早该失效的
// 疑点。这个上限在本项目的口径下是**可及的**：扫描保险丝允许 5 万条目，而实测 10k 条目
// 产出 2.9 万条疑点（约 3.5 万条目就越过 10 万行）。
//
// offset 用「本轮决定保留的行数」而不是「已处理行数」：被下线的行会从结果集里消失，
// 只有留下的那些需要被再次越过；用错就会漏行或死循环。
// 这里不设熔断：每轮要么下线至少一行（结果集缩小）要么越过一行（有上界），一定终止；
// 中途抛错反而制造"下线了一半"的状态，而那正是这段代码要防的事。
function retire(dao, collection, clauses, shouldRetire, stamp, { chunk = RETIRE_CHUNK } = {}) {
  let retired = 0
  let skipped = 0
  for (;;) {
    const batch = dao.findRecordsByFilter(
      "review_findings",
      [...clauses, 'superseded_at = ""'].join(" && "),
      "created",
      chunk,
      skipped
    )
    if (!batch.length) return retired
    for (const record of batch) {
      if (!shouldRetire(record)) { skipped += 1; continue }
      record.set("superseded_at", stamp)
      dao.save(record)
      retired += 1
    }
    if (batch.length < chunk) return retired
  }
}

// 分块读完一个过滤条件下的全部行，读到空为止。
//
// 为什么全项目都用它而不是"一次读一个大 limit"：`limit N, offset 0` 的形状一旦
// 结果集超过 N 就会**静默少读**，而少读的那些行照样参与后面的判定，报告写得像算完了。
// #208 的评审阻断 2 与本轮在 recomputeIdentity/refreshDifficulty 里发现的两个
// 上限（5000 条人工结论 / 500 条单页疑点）都是同一个形状，所以收敛到这里一份实现。
// 只适用于"读期间不写"的场景（写会让结果集缩小，那种翻页见 retire）。
//
// `onBatch(rows)` 是给"必须边读边判上限"的调用方留的口子：在**读完每一批之后**回调，
// 从那里抛错就是"读到一半退出"，既不返回部分结果，也不会先把整个结果集吸进内存。
// 不需要上限的调用方（人工结论、单页疑点）不传，语义与之前完全一致。
function readAllInChunks(dao, collection, filter, sort, { chunk = READ_CHUNK, onBatch = null } = {}) {
  const rows = []
  for (let offset = 0; ; offset += chunk) {
    const batch = dao.findRecordsByFilter(collection, filter, sort, chunk, offset)
    for (const record of batch) rows.push(record)
    if (onBatch) onBatch(rows)
    if (batch.length < chunk) return rows
  }
}

// 分批下线作用域内的当前批次。见 retire 的注释：这里防的是"读满一块就停"——
// 剩下的行会以"当前批次"的身份永远留在库里，旧疑点再也下不了线。
function supersede(dao, collection, clauses, at, kinds) {
  return retire(dao, collection, [...clauses, kindClause(kinds)], () => true, at)
}

// 插入之后的收尾：只下线**严格更早**的批次。
//
// 为什么必须有这一步：JSVM 不保证重算请求之间不交错（DAO 调用点就会让出运行时），实测
// 同一页面 8 个并发重算会留下「A 下线 → B 下线 → A 插入 → B 插入」的形状。
// 2026-09-25 的记录：库里 52 行里出现过 produced_at=.771 的一批被 .784/.787 陆续标掉，
// 最后只剩 2 行当前批次——**残缺的一批比重复更难发现**，校对端看到的就是"疑点变少了"。
//
// 所以收尾的判据是"比我这一批早"，不是"不是我的"：
// - 较新的批次永远不会被较旧的收尾抹掉 ⇒ 不会归零、不会残缺，最多同毫秒的几批并存；
// - 同毫秒互不杀伤（`<` 排除相等），最坏是短暂重复 hint，任何一次后续重算都会清掉；
// - 全局最后一个开始的请求那一批一定完整在册。
// 比较用 stampKey 归一化后的字符串：DAO 写回的日期串是 "2026-09-25 13:52:21.771Z"
// （空格分隔），而 nowStamp() 给的是 ISO 的 "T" 形式，直接比字符串会永远判成"更新"，
// 让整步收尾静默失效。
function stampKey(value) {
  return String(value ?? "").replace("T", " ").replace(/Z$/, "").slice(0, 23)
}

function settleBatch(dao, collection, clauses, at, kinds) {
  const mine = stampKey(at)
  return retire(dao, collection, [...clauses, kindClause(kinds)], (record) =>
    stampKey(record.getString("produced_at")) < mine, at)
}

// 单条目重算的作用域：本条目 + 本生产者，**但要排除项目级 key（列级 + 页级）**。
// 这些疑点按挂靠口径也落在某条条目上，而单条重算只判定格级规则；不排除就会让
// "给某一条补算"顺手抹掉挂在它身上的项目级疑点，而那些只有项目重算会再产出。
function pageScope(pageId, projectOnlyKeys) {
  return [
    `page = "${pageId}"`,
    `producer = "${PRODUCER}"`,
    ...projectOnlyKeys.map((key) => `message_key != "${key}"`)
  ]
}

// rowOverride：提交路径传进来的「校对员刚打的那一行」。
// 不传就用库里的当前值——pages.proofread_row_json 只在凑够票数后才写，
// 第一遍提交时若不用 override，规则算的还是导入原文，等于没算刚提交的内容。
function recomputePage(dao, pageId, rowOverride = null) {
  const { runEntryRules, RULES_VERSION, PROJECT_ONLY_MESSAGE_KEYS } = require(`${__hooks}/lib/assist_rules.js`)
  const collection = dao.findCollectionByNameOrId("review_findings")
  const page = dao.findRecordById("pages", pageId)
  const at = nowStamp()
  const row = rowOverride && Object.keys(rowOverride).length ? rowOverride : rowForRules(page)
  const findings = runEntryRules(contextFor(dao, page), row, pageId)
  const scope = pageScope(pageId, PROJECT_ONLY_MESSAGE_KEYS)
  const superseded = supersede(dao, collection, scope, at, RULE_KINDS)
  for (const item of findings) insertFinding(dao, collection, page, item, at, RULES_VERSION)
  const settled = settleBatch(dao, collection, scope, at, RULE_KINDS)
  // 难度在收尾之后刷新：tier 由**当前批次**推导，收尾前读到的还是旧批次。
  const difficulty = refreshDifficulty(dao, page)
  return {
    page: pageId, findings: findings.length, superseded, settled,
    producer_version: RULES_VERSION,
    difficulty_tier: difficulty.tier, difficulty_version: difficulty.version
  }
}

// 分批读全项目的条目；游标翻到某一批不满额为止。超限抛错，调用方因此一条都不会写。
//
// 保险丝必须在读取**过程中**判，不能"读全再判"：这条线要防的就是把整项目的行吸进
// JSVM 内存，读完才判等于先付全额成本再拒算。上一版正是这个形状（#212 复审阻断）。
// 走 readAllInChunks 的 onBatch：命中即抛，最多只会比 refusal 多吸进一批（chunk）的行。
function loadAllPages(dao, projectId, { chunk = PAGE_SCAN_CHUNK, refusal = PROJECT_SCAN_REFUSAL } = {}) {
  return readAllInChunks(dao, "pages", `project = "${projectId}"`, "page_number,created", {
    chunk,
    onBatch: (rows) => {
      if (rows.length >= refusal) {
        throw new Error(`项目条目数 ${rows.length} 已达全量重算保险丝 ${refusal}，拒绝执行（未改动任何疑点）`)
      }
    }
  })
}

// 项目级：列级(R3/R4) 与页级(R7) 规则要看到全量才能判，所以只在批处理里跑。
// 返回耗时供 #177 的规模验收引用（10k 行项目的实测值写进 docs/plans/2026-09-25-assist-rules.md）。
function recomputeProject(dao, projectId) {
  const { runProjectRules, makeContext, RULES_VERSION } = require(`${__hooks}/lib/assist_rules.js`)
  const startedAt = new Date()
  const collection = dao.findCollectionByNameOrId("review_findings")
  const pages = loadAllPages(dao, projectId)
  // 条目与行内容一起传给规则：挂靠由规则侧决定（见 assist_rules.js 的挂靠口径注释）。
  const entries = pages.map((page, index) => ({
    pageId: page.id,
    order: index + 1,
    pdfPage: Number(page.get("pdf_page")) || 0,
    row: rowForRules(page)
  }))
  const ctx = pages.length
    ? contextFor(dao, pages[0])
    : makeContext({ projectId, keyboards: [], roles: null })
  const findings = runProjectRules(ctx, entries)
  const at = nowStamp()
  // 下线仍然按 project 收口：游标已经保证「要么整批扫完、要么写入前抛错」，
  // 被扫到的集合恒等于全项目，所以这里不需要再按条目列表拼 filter。
  const superseded = supersede(dao, collection,
    [`project = "${projectId}"`, `producer = "${PRODUCER}"`], at, RULE_KINDS)
  const byId = new Map(pages.map((page) => [page.id, page]))
  const projectScope = [`project = "${projectId}"`, `producer = "${PRODUCER}"`]
  let inserted = 0
  let unanchored = 0
  for (const item of findings) {
    const anchor = byId.get(item.page)
    if (!anchor) {
      // 挂靠解析不出来就跳过并计数，绝不退化成"挂到第一条"——那正是上一轮的缺陷形状。
      unanchored += 1
      continue
    }
    insertFinding(dao, collection, anchor, item, at, RULES_VERSION)
    inserted += 1
  }
  const settled = settleBatch(dao, collection, projectScope, at, RULE_KINDS)
  if (unanchored) console.warn("assist_recompute unanchored findings", projectId, unanchored)
  // 同样放在收尾之后：全项目的 tier 要按最终留在库里的当前批次推导。
  const stats = projectShapeStats(pages)
  const tiers = { A: 0, B: 0, C: 0, unknown: 0 }
  for (const page of pages) tiers[refreshDifficulty(dao, page, stats).tier] += 1
  return {
    project: projectId,
    pages: pages.length,
    difficulty_tiers: tiers,
    findings: inserted,
    unanchored,
    superseded,
    settled,
    duration_ms: new Date() - startedAt,
    producer_version: RULES_VERSION
  }
}

// ---------- #180 难度标签 ----------
// 疑点算完之后顺手刷新 tier：#180 只出数据与接口，不新造触发器，
// 复用 #177 的两条路径（单条重算 / 项目全量），tier 才不会出现"疑点是新的、难度是旧的"。
// 例外是 #178 的跨行路径：它一条 tier 都不刷，改由返回值里的 difficulty_stale 说明，
// 跑完要再跑一次项目重算才是新的（理由与代价见 docs/plans/2026-09-25-cross-row-conflicts.md）。
//
// 读的是**全部当前批次疑点，不按 gate 过滤**：信号要的是"机器认为这行有多少问题"，
// 与"校对员被打了几个标"是两件事；blocked_reason 依赖的 merged_columns 更是只有
// OCR(#125)/#178 才产，按 gate 过滤会永远看不到它。
//
// 不对称要写明：本函数取的是**库里那一行**（`rowForRules(page)`），而提交路径传给规则的
// 是校对员刚打的那一行 `rowOverride`。于是刚提交的那一瞬间，形状信号（字段数 / 值长）
// 量的还是旧内容。今天完全无害——单条路径 `projectStats = null`，`field_count_outlier` 与
// `row_shape_outlier` 两条判据都读不到中位数，不会因此给出错的 tier。但将来把 stats 传进
// 单条路径，这里就会静默拿到过期形状，届时要把它改成 (page, rowOverride) 两路取值。
function refreshDifficulty(dao, page, stats = null) {
  const { deriveDifficulty, blockedReasonFromFindings, BLOCKED_BUCKETS, DIFFICULTY_VERSION } =
    require(`${__hooks}/lib/assist_difficulty.js`)
  const findings = readAllInChunks(
    dao, "review_findings", `page = "${page.id}" && superseded_at = ""`, "kind"
  ).map((row) => ({
    kind: row.getString("kind"),
    severity: row.getString("severity"),
    field: row.getString("field_name")
  }))
  const row = rowForRules(page)
  const valueLengths = Object.values(row).map((value) => Array.from(String(value ?? "")).length)
  // `blocked_reason` 只由人写，机器算出的桶**不 stamp 回库**（见下面为什么）。
  // 这里读的到的值因此就是人的结论：空 = 没人说过（决策 4 的"没测过"必须与"看过但认不出"
  // 可分，两者在库里不再是同一个字符串）。
  const stored = page.getString("blocked_reason")
  const manual = BLOCKED_BUCKETS.includes(stored) ? stored : ""
  const signal = {
    findings,
    // #170 未落地：roles 为 null，涉及列角色的两条信号因此不产生（不是判成 A）。
    roles: null,
    pdfPage: Number(page.get("pdf_page")) || 0,
    // 人说过就用人的；没人说过才按本轮疑点现算。算出来的桶只进本轮 derivation
    // （体现为 difficulty_basis_json 里的 column_merge_blocked / glyph_table_blocked），
    // 不写回这一列——写回就会把 #211/#212 评审挡的那条链子接上：
    // `normalizeBlocked("")` 也返回 "unknown"，一旦机器 stamp，这一列从第一次刷新起永久非空，
    // `stored || auto` 从此短路，#188 读到的将"每条都非空、但全是 unknown"；而机器写进去的
    // 真实桶更糟，库里分不出它与人工选的同名值，疑点消失后无法降级，与 #180 第 59 行
    // 「只描述为什么**现在**做不下去」直接冲突。取舍写在 docs/plans/2026-09-25-task-difficulty.md §3。
    blockedReason: manual || blockedReasonFromFindings(findings),
    fieldCount: Object.keys(row).length,
    valueLengths,
    projectStats: stats,
    // #179 的分布今天不存在；传 null 而不是空对象，两者在 deriveDifficulty 里同义，
    // 但写成 null 让"还没测"这件事在调用点就可见。
    arbitrationRates: null
  }
  const derived = deriveDifficulty(signal)
  if (page.getString("difficulty_tier") !== derived.tier
    || page.getString("difficulty_version") !== derived.version
    || page.getString("difficulty_basis_json") !== JSON.stringify(derived.basis)) {
    page.set("difficulty_tier", derived.tier)
    page.set("difficulty_basis_json", JSON.stringify(derived.basis))
    page.set("difficulty_version", derived.version)
    dao.save(page)
  }
  return derived
}

// 项目级统计：整行形状离群要拿全项目比，单条路径拿不到，所以只在全量重算里算一次。
function projectShapeStats(pages) {
  const fieldCounts = []
  const lengths = []
  for (const page of pages) {
    const row = rowForRules(page)
    fieldCounts.push(Object.keys(row).length)
    for (const value of Object.values(row)) lengths.push(Array.from(String(value ?? "")).length)
  }
  const median = (list) => {
    const sorted = list.slice().sort((a, b) => a - b)
    return sorted.length ? sorted[Math.floor(sorted.length / 2)] : Number.NaN
  }
  const med = median(lengths)
  const deviations = lengths.map((value) => Math.abs(value - med)).sort((a, b) => a - b)
  return {
    medianFieldCount: median(fieldCounts),
    medianValueLength: med,
    madValueLength: deviations.length ? deviations[Math.floor(deviations.length / 2)] : Number.NaN
  }
}

// ---------- #178 跨行检出 ----------
// 只在批处理路径跑（跨行比较是 O(n) 起，绝不挂到提交路径上——#178 正文明确要求）。
// 条目读取复用 #177 那个 loadAllPages：两条批处理路径的扫描语义因此不会各自漂移
// （同名函数在这里定义第二遍会被提升覆盖，#177 那条的保险丝就会静默失效）。

function recomputeIdentity(dao, projectId) {
  const startedAt = new Date()
  const { findIdentityConflicts, findRowShapeAnomalies, entryIdentityKey, IDENTITY_VERSION } =
    require(`${__hooks}/lib/assist_identity.js`)
  const collection = dao.findCollectionByNameOrId("review_findings")
  const pages = loadAllPages(dao, projectId)

  const entries = []
  let backfilled = 0
  for (const page of pages) {
    const row = rowForRules(page)
    const key = entryIdentityKey(row) ?? ""
    if (page.getString("entry_identity_key") !== key) {
      page.set("entry_identity_key", key)
      dao.save(page) // 可重算的回填：键由列内容推导，不是原始证据
      backfilled += 1
    }
    entries.push({ id: page.id, project: projectId, row, page, source: page.getString("project_file") })
  }

  // 人工结论必须读全：少读的那些组会被重新报成冲突，等于静默推翻人的判断——
  // 而 #178 立这条收集合的理由就是"重算时保留人工结论，否则人就再也不信这个队列"。
  // 5000 的上限不是假想：本 issue 自己的 10k 压力 fixture 就有 2500 个身份分组。
  const dismissed = new Set(readAllInChunks(
    dao, "finding_dismissals", `project = "${projectId}" && status = "not_conflict"`, "group_key"
  ).map((row) => row.getString("group_key")))

  const findings = [...findIdentityConflicts(entries, dismissed).findings]
  for (const entry of entries) findings.push(...findRowShapeAnomalies(entry))

  const at = nowStamp()
  const superseded = supersede(dao, collection,
    [`project = "${projectId}"`, `producer = "${PRODUCER}"`], at, IDENTITY_KINDS)
  const byId = new Map(entries.map((entry) => [entry.id, entry.page]))
  let inserted = 0
  // 挂靠解析不出来就计数并跳过，绝不退化成"挂到第一条"；与 recomputeProject 同一形状，
  // 这样两条批处理路径在"规则产了但写入端没接住"这件事上都会留下痕迹。
  let unanchored = 0
  for (const item of findings) {
    const anchor = byId.get(item.evidence?.page) ?? null
    if (!anchor) {
      unanchored += 1
      continue
    }
    insertFinding(dao, collection, anchor, item, at, IDENTITY_VERSION)
    inserted += 1
  }
  const summary = {
    project: projectId,
    pages: pages.length,
    findings: inserted,
    unanchored,
    superseded,
    backfilled_keys: backfilled,
    dismissed_groups: dismissed.size,
    producer_version: IDENTITY_VERSION,
    // 本路径**不刷 tier**（每页刷一次的 N+1 代价见 docs §耗时那一节），而 duplicate_identity
    // 与 merged_columns 都是 strong、会进判定表。所以这一批之后每一页的 difficulty_tier 描述的是
    // 跨行检出之前的疑点集合。字段让调用方看得见这件事，runbook 是"再跑一次 findings/recompute"。
    difficulty_stale: inserted > 0 || superseded > 0,
    duration_ms: new Date() - startedAt
  }
  if (unanchored) console.warn("identity_recompute unanchored findings", projectId, unanchored)
  console.log("identity_recompute", JSON.stringify(summary))
  return summary
}

// 提交/仲裁路径用的安全包装：疑点生产失败绝不能把已落库的提交变成错误。
// 失败必须留下日志（不静默成「没有疑点」），管理端可用 findings/recompute 补算。
function safeRecomputePage(dao, pageId, row, label) {
  try {
    const startedAt = Date.now()
    const summary = recomputePage(dao, pageId, row)
    console.log(label, JSON.stringify({ ...summary, duration_ms: Date.now() - startedAt }))
    return summary
  } catch (error) {
    console.warn(label + " failed", pageId, String(error))
    return null
  }
}

module.exports = {
  safeRecomputePage,
  PRODUCER,
  RETIRE_CHUNK,
  READ_CHUNK,
  readAllInChunks,
  retire,
  PAGE_SCAN_CHUNK,
  PROJECT_SCAN_REFUSAL,
  loadAllPages,
  RULE_KINDS,
  IDENTITY_KINDS,
  rowForRules,
  recomputePage,
  recomputeProject,
  recomputeIdentity,
  refreshDifficulty,
  projectShapeStats
}
