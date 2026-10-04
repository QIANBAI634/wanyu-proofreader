// #254：一条判据"能不能拿到精度"必须是**一处定义**。
//
// 门控只认 `suggestGate(n, p̂)`（gate_release.js），而这两个数唯一的产出者是
// `scripts/assist/score_rules.mjs`。所以"没进打分清单"和"进了清单但还在等证据"
// 在库里长得一模一样：两者的 gate 都是 off，管理端都念成"尚未放行"。
// 前者其实永远不会有档位——把它说成"放行在即"，等于让 manager 按一个不存在的通道排产。
//
// 这张表就是那两种 off 的分界。三个消费方共用它，谁都不许再抄一份：
//   - `scripts/assist/score_rules.mjs`：`defaultRuleSet` 必须与 SCORED 双向相等；
//   - `scripts/assist/gate_changeset.mjs`：变更集报告的「无打分通道」栏；
//   - `backend/pb_hooks/lib/findings.js`：管理端每条疑点带 `scoring_channel`，
//     界面据此把两种措辞分开（校对端不读它，档位与通道都不下发到 hintView）。
//
// 新增判据时漏归类不会静默过去：`assertCovered` 会把未归类的 key 列出来抛错，
// 打分器与变更集两侧都有用例守着（backend/tests/gate_release_integration.mjs）。

// 这张表两边都要读：Node 侧（scripts/assist/*.mjs）与 PocketBase 的 goja 侧
// （pb_hooks/lib/findings.js）。goja 里模块路径要用 `${__hooks}`，Node 里要用相对路径，
// 所以按运行环境挑一次——写死任何一边都会在另一边上炸成"模块找不到"。
const hooksRoot = typeof globalThis.__hooks === "string" ? globalThis.__hooks : ""
const loadLib = (name) => require(hooksRoot ? `${hooksRoot}/lib/${name}.js` : `./${name}.js`)

const rules = loadLib("assist_rules")
const identity = loadLib("assist_identity")

// 弱标注粒度是 `(提交, 字段)`：同一格两次提交比得出对错，就能算精度。
const SCORED = [
  { producer_version: rules.RULES_VERSION, kind: "char_out_of_repertoire", message_key: "non_ipa_range_codepoints", rule: "R1 char_out_of_repertoire" },
  { producer_version: rules.RULES_VERSION, kind: "confusable_substitution", message_key: "confusable_ascii_in_reading", rule: "R2 confusable_substitution" },
  { producer_version: rules.RULES_VERSION, kind: "encoding_form_anomaly", message_key: "combining_marks_present", rule: "R3 combining_marks" },
  { producer_version: rules.RULES_VERSION, kind: "reading_format_invalid", message_key: "long_digit_run", rule: "R6 long_digit_run" },
  { producer_version: rules.RULES_VERSION, kind: "reading_format_invalid", message_key: "tone_token_count_differs", rule: "R6 tone_token_count_differs" },
  // R5 只在项目标了列角色时才产：没有角色就没有"必填字段"这回事。
  { producer_version: rules.RULES_VERSION, kind: "missing_field", message_key: "required_role_field_empty", rule: "R5 missing_field", requires_roles: true }
]

// 有疑点在产、但现有通道量不到精度。理由必须逐条写：这一栏存在的意义就是
// "沉默会被读成没问题"，一句笼统的"不支持打分"等于没写。
const UNSCORED = [
  {
    producer_version: rules.RULES_VERSION, kind: "encoding_form_anomaly",
    message_key: "mixed_normalization_forms", rule: "R3 mixed_normalization_forms",
    reason: "列级判据：弱标注按 (提交, 字段) 对齐，看不见整列的形态分布"
  },
  {
    producer_version: rules.RULES_VERSION, kind: "punctuation_mix",
    message_key: "punctuation_width_mixed_in_column", rule: "R4 punctuation_mix",
    reason: "列级判据：同上，要看到整列才成立"
  },
  {
    producer_version: rules.RULES_VERSION, kind: "page_outlier",
    message_key: "pdf_page_backtrack", rule: "R7 page_outlier",
    reason: "页级/项目级判据：需要整批分布，单条提交里没有"
  },
  {
    producer_version: rules.RULES_VERSION, kind: "page_outlier",
    message_key: "page_entry_count_outlier", rule: "R7 row_shape_outlier",
    reason: "页级/项目级判据：需要整批分布，单条提交里没有"
  },
  {
    producer_version: identity.IDENTITY_VERSION, kind: "merged_columns",
    message_key: "multiple_headwords_in_cell", rule: "identity multiple_headwords_in_cell",
    reason: "跨行判据：一格挤进两个词头的对错，要把整列/相邻两条一起看，" +
      "而弱标注只在同一字段的两次提交之间比。出路见 cross-row-conflicts.md §7：把标注提到 (提交, 条目) 粒度"
  },
  {
    producer_version: identity.IDENTITY_VERSION, kind: "merged_columns",
    message_key: "reading_inside_meaning_row", rule: "identity reading_inside_meaning_row",
    reason: "跨行判据：释义里是否混进记音要连着记音列一起判，粒度同上"
  },
  {
    producer_version: identity.IDENTITY_VERSION, kind: "duplicate_identity",
    message_key: "same_identity_different_content", rule: "identity duplicate_identity",
    reason: "跨行判据：同身份两条谁对谁错，弱标注的 (提交, 字段) 粒度看不见另一条"
  },
  {
    producer_version: identity.IDENTITY_VERSION, kind: "cross_source_conflict",
    message_key: "same_identity_across_sources", rule: "identity cross_source_conflict",
    reason: "同 duplicate_identity；且该 kind 要等登记来源齐备才会产出，今天库里没有它"
  }
]

function keyOf(entry) {
  return [entry?.producer_version, entry?.kind, entry?.message_key].join("|")
}

const BY_KEY = new Map()
for (const entry of SCORED) BY_KEY.set(keyOf(entry), { ...entry, channel: "scored" })
for (const entry of UNSCORED) {
  if (BY_KEY.has(keyOf(entry))) {
    // 同一身份既"能打分"又"不能打分"是这张表唯一真正的自相矛盾，
    // 而它的症状是管理端措辞随机取决于谁先注册——所以在这里直接炸。
    throw new Error(`判据身份被重复归类：${keyOf(entry)}`)
  }
  BY_KEY.set(keyOf(entry), { ...entry, channel: "unscored" })
}

// `unknown` 不是"没查到"的中性值，而是一个必须让构建变红的信号：
// 库里出现了表上没有的身份，界面上就不该说"尚未放行"，因为连它有没有通道都不知道。
function channelOf(entry) {
  return BY_KEY.get(keyOf(entry))?.channel ?? "unknown"
}

function unclassified(entries) {
  return entries.filter((entry) => !BY_KEY.has(keyOf(entry))).map((entry) => keyOf(entry))
}

function assertCovered(entries, label) {
  const missing = unclassified(entries)
  if (missing.length) {
    throw new Error(`${label}有 ${missing.length} 条判据未归类到 SCORED/UNSCORED：${missing.join("、")}`)
  }
  return entries
}

function forVersion(producerVersion, channel) {
  return [...BY_KEY.values()].filter((entry) =>
    entry.producer_version === producerVersion && (!channel || entry.channel === channel))
}

module.exports = {
  SCORED,
  UNSCORED,
  assertCovered,
  channelOf,
  forVersion,
  keyOf,
  unclassified
}
