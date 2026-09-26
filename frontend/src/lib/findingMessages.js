// #176 疑点措辞。后端只下发 `message: { key, params }`，中文措辞集中在这一份文件里，
// 避免后端文案漂移，也保证 #161 拿到的 key 是唯一可枚举的措辞来源。
//
// 措辞里只允许出现**码位、计数、列名**这类结构信息，绝不出现单元格正文
// （判据同 scripts/corpus_probe/README.md：码位是结构信息，字形序列是内容）。
// key 集合与 scripts/corpus_probe/detectors.py 的 finding(...) 调用一一对应；
// 新增检测器时两边都要加，缺措辞会走 FALLBACK 而不是报错。

export const FALLBACK_PREFIX = '未登记的疑点类型'

// 0x303 / "0x303" / 771 都统一成 U+0303，防止措辞里出现字面字形。
export function codepointLabel(value) {
  let code = value
  if (typeof code === 'string') {
    const matched = /^u\+?([0-9a-f]{2,8})$/i.exec(code) || /^0x([0-9a-f]{1,8})$/i.exec(code)
    code = matched ? parseInt(matched[1], 16) : NaN
  }
  if (typeof code !== 'number' || !Number.isFinite(code) || code < 0 || code > 0x10ffff) {
    return '未知码位'
  }
  return `U+${code.toString(16).toUpperCase().padStart(4, '0')}`
}

function list(values) {
  return Array.isArray(values) ? values.map((item) => String(item)).filter(Boolean) : []
}

function codepointList(params, name) {
  const values = list(params?.[name])
  return values.map(codepointLabel).join('、')
}

function count(value, fallback = 0) {
  const number = Number(value)
  return Number.isFinite(number) ? number : fallback
}

// 每个措辞函数只读结构信息；params 缺字段时用可读的默认值，不抛错——
// 一个规则的参数写漏不该让整条校对界面白屏。
const MESSAGES = {
  long_digit_run: (params) => {
    const runs = list(params?.runs)
    const where = runs.length ? `（${runs.slice(0, 3).join('、')}${runs.length > 3 ? ' 等' : ''}）` : ''
    return `记音里出现 ${count(params?.run_count, runs.length)} 段三位以上连续数字${where}，疑似声调上标被压平`
  },
  tone_token_count_differs: (params) =>
    `拼音与 IPA 的声调个数不等（${count(params?.pinyin_count)} 对 ${count(params?.ipa_count)}），疑似漏字或多字`,
  missing_glyph_placeholder: (params) => {
    const marks = list(params?.marks)
    const where = marks.length ? `（${marks.slice(0, 3).join('、')}${marks.length > 3 ? ' 等' : ''}）` : ''
    return `该格含 ${count(params?.mark_count, marks.length)} 处缺字占位标记${where}，需查缺字登记表`
  },
  column_collapse: (params) => {
    const reasons = list(params?.reasons)
    return `本列疑似列合并${reasons.length ? `（${reasons.join('；')}）` : ''}，先确认列位置再看内容`
  },
  meaning_is_phonetic_fragment: () => '释义整格像是一段记音，疑似整列错位',
  phonetic_run_inside_meaning: () => '释义里混入了一段记音',
  mixed_normalization_forms: (params) => {
    const minority = String(params?.minority || '').toUpperCase()
    return `本列 NFC 与 NFD 两种编码形式并存（NFC ${count(params?.nfc)} 行、NFD ${count(params?.nfd)} 行），少数派为 ${minority || '未知'}`
  },
  combining_marks_present: (params) => `该格含组合附加符（${codepointList(params, 'marks') || '未列出'}）`,
  non_ipa_range_codepoints: (params) =>
    `出现启用键盘与放行区段之外的字符（${codepointList(params, 'codepoints') || '未列出'}）`,
  cjk_extension_present: (params) =>
    `出现 BMP 之外的汉字（${codepointList(params, 'codepoints') || '未列出'}），表示方式待 #123 决定`,
  row_width_differs: (params) =>
    `本行的单元格数与表头不符（${count(params?.cells)} 对 ${count(params?.headers)}），疑似列合并或错位`,

  // #177 规则引擎新增的措辞键。同样只出现码位与计数，不出现字形。
  confusable_ascii_in_reading: (params) => {
    const suggestions = Array.isArray(params?.suggestions) ? params.suggestions : []
    const detail = suggestions.slice(0, 3).map((item) => {
      const targets = Array.isArray(item?.suggested) ? item.suggested.join(' 或 ') : String(item?.suggested || '')
      return `${item?.found || '未知码位'}→${targets}`
    }).join('、')
    const where = Array.isArray(params?.positions) && params.positions.length
      ? `（第 ${params.positions.slice(0, 3).join('、')}${params.positions.length > 3 ? ' 等' : ''} 个字符）`
      : ''
    return `记音里出现易混 ASCII${where}${detail ? `，建议 ${detail}` : ''}`
  },
  punctuation_width_mixed_in_column: (params) => {
    const pairs = Array.isArray(params?.pairs) ? params.pairs : []
    const detail = pairs.slice(0, 3).map((pair) => `${pair?.full || '?'} / ${pair?.half || '?'}`).join('、')
    return `本列全角与半角标点混用${detail ? `（${detail}）` : ''}，共 ${count(params?.pair_count, pairs.length)} 组`
  },
  required_role_field_empty: (params) => {
    const roles = { headword: '词头', reading: '记音', meaning: '释义' }
    const role = roles[String(params?.role || '')] || '必填'
    return `${role}列为空`
  },
  pdf_page_backtrack: (params) =>
    `条目顺序与 PDF 页码不一致：从第 ${count(params?.from_page)} 页回退到第 ${count(params?.to_page)} 页（回退 ${count(params?.backtrack)} 页），疑似页码或条目顺序错乱`,
  page_entry_count_outlier: (params) =>
    `该 PDF 页挂了 ${count(params?.entries_on_page)} 条条目，明显高于项目中位数 ${count(params?.median_entries)} 条（阈值 ${count(params?.ceiling)}），疑似分页或拆行异常`,

  // #178 跨行检出的措辞键。词头与记音既不进措辞正文、也不进 payload：`identity-v1` 起 params
  // 只有 differs_on / partner_count / sources，evidence 只有条目 id 与偏移（契约见
  // review-findings.md §6 内容边界，按绝对解释连"本条目自己的原文"也不带）。措辞只说
  // "还有几处并列、差在哪些列"——判据本来就摆在读到它的校对员眼前，措辞不需要搬内容，
  // 也就没有可外泄的形状。
  same_identity_different_content: (params) => {
    const differs = Array.isArray(params?.differs_on) ? params.differs_on : []
    const partners = count(params?.partner_count)
    return `与其他 ${partners} 条同身份（词头 + 记音相同）但${differs.length ? `「${differs.slice(0, 3).join('、')}」` : '其他'}列不一致，需人工看一眼是否真是两个条目`
  },
  multiple_headwords_in_cell: (params) =>
    `该格疑似挤进 ${count(params?.segments)} 个词头，需先拆列再判内容`,
  reading_inside_meaning_row: (params) => {
    const bits = []
    if (params?.has_tone_digits) bits.push('数字调号')
    if (params?.has_ipa_marks) bits.push('IPA 记音符')
    return `释义里出现${bits.length ? bits.join('与') : '记音特征'}，疑似列错位`
  }
}

export function findingMessageKeys() {
  return Object.keys(MESSAGES).sort()
}

export function renderFindingMessage(message) {
  const key = String(message?.key || '')
  const params = message?.params && typeof message.params === 'object' ? message.params : {}
  const build = MESSAGES[key]
  if (!build) return `${FALLBACK_PREFIX}：${key || '缺少 message_key'}`
  return build(params)
}

export function renderHints(hints) {
  if (!Array.isArray(hints) || hints.length === 0) return []
  return hints.map((hint) => ({
    field: String(hint?.field || ''),
    kind: String(hint?.kind || ''),
    severity: String(hint?.severity || ''),
    highlight: Boolean(hint?.highlight),
    text: renderFindingMessage(hint?.message)
  }))
}
