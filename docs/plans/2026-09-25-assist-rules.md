# 确定性规则引擎 v1（L0）——规则清单、判定与阈值

> 本文件是 **#177** 的交付物之一（验收项「规则清单与判定写入 `docs/plans/`，与 #176 契约同址」）。
> 数据形状、门控与批次语义见 [`2026-09-25-review-findings.md`](./2026-09-25-review-findings.md)；
> 档位判据（哪条规则能进校对端）见 [`2026-09-25-assist-rule-thresholds.md`](./2026-09-25-assist-rule-thresholds.md)。
> **三份文件分工不重叠**：本文件只写「规则怎么判、判出来是什么 severity、阈值是多少」。

规则清单版本：`l0-v1`（`backend/pb_hooks/lib/assist_rules.js` 的 `RULES_VERSION`）。
**任何判定口径变化都必须升这个版本号**——`producer_version` 就是它，登记表按它置档，
旧批次的数字不会串到新规则上。移植基准是 #201 入仓的 `scripts/corpus_probe/detectors.py`，
不是 W2 工作区的本机缓存脚本。

## 1. 规则表

| # | kind | message_key | severity | 判定 | 作用域 | 入仓参考实现 |
| --- | --- | --- | --- | --- | --- | --- |
| R1 | `char_out_of_repertoire` | `non_ipa_range_codepoints` | warn | 值含码位 ∉（项目启用键盘字符并集 ∪ §2 放行区段） | 逐格 | ✅ `detect_non_repertoire_chars` |
| R2 | `confusable_substitution` | `confusable_ascii_in_reading` | warn | **仅 IPA 列**出现「键盘 hint 点明的易混 ASCII」 | 逐格 | ❌ 新建（表编译自 `keyboards/hinghwa-dialect.json` 的 `hint`） |
| R3 | `encoding_form_anomaly` | `combining_marks_present` | info | 该格含 Mn 组合附加符，列出码位 | 逐格 | ✅ `detect_combining_marks` |
| R3 | `encoding_form_anomaly` | `mixed_normalization_forms` | warn | 同一列 NFC 与 NFD 真并存，报少数派 | **整列** | ✅ `detect_inconsistent_forms` |
| R4 | `punctuation_mix` | `punctuation_width_mixed_in_column` | warn | 同一列里某对全/半角标点都出现过 | **整列** | ❌ 新建 |
| R5 | `missing_field` | `required_role_field_empty` | strong | 角色 ∈ {headword, reading, meaning} 的列为空 | 逐格 | ❌ 新建，**依赖 #170** |
| R6 | `reading_format_invalid` | `long_digit_run` | strong | 记音列 ≥3 位连续数字，除 `533`/`453` 外视为上标压平 | 逐格 | ✅ `detect_illegal_tone_runs` |
| R6 | `reading_format_invalid` | `tone_token_count_differs` | warn | `拼音` 与 `莆田IPA` 的数字调号个数不等 | 整行 | ✅ `detect_tone_count_mismatch` |
| R7 | `page_outlier` | `pdf_page_backtrack` | warn | 条目顺序前进时 `pdf_page` 回退超过容差 | 全项目 | ❌ 新建 |
| R7 | `page_outlier` | `page_entry_count_outlier` | warn | 某页条目数 > max(中位数×3, 中位数+8) | 全项目 | ❌ 新建 |

`merged_columns` 不在本表：它由 #125（识别）与 #178（跨行规则）产出。同理
`duplicate_identity` / `cross_source_conflict` 归 #178。

## 2. 阈值与常量（开工前写定，改它要走新 PR）

```
LEGAL_LONG_TONES          = {533, 453}      // 原型 13 值 LEGAL 集合在 #201 移植时被刻意删除
PLACEHOLDER               = /@[0-9a-fA-F]{4,6}/   // 缺字登记序号，不是 Unicode 码位
READING_FIELDS            = {拼音, 莆田IPA, 仙游IPA}
IPA_FIELDS                = {莆田IPA, 仙游IPA}    // R2 只看这两列，见 §3.2
ALLOWED_RANGES            = 见 assist_rules.js 的 ALLOWED_RANGES（ASCII / IPA 扩展 /
                            组合符 / 通用标点 / CJK 符号标点 / 扩展A / 统一表意 /
                            兼容表意 / 非 BMP 汉字）
PAGE_ORDER_BACKTRACK_TOLERANCE = 1 页
PAGE_DENSITY_MEDIAN_MULTIPLIER = 3
PAGE_DENSITY_MIN_EXTRA         = 8 条
PAGE_DENSITY_MIN_PAGES         = 20 页  // 样本不足时密度判据必须沉默
PAGE_SCAN_CHUNK                = 1000 条 // 全量重算读条目的游标大小，翻完为止（无静默上限）
PROJECT_SCAN_REFUSAL           = 50000 条 // 内存保险丝；命中就抛错拒算，且发生在任何写入之前
```

R7 的两个阈值是 #177 正文点名的「必须先定阈值并写定」那一项。定在 3×/中位数+8 是因为
20 页样本下 6 条/页的项目要出现 18 条才报，而真实拆分错误通常是整页几十条量级；
这个数字没有真实数据支撑过，所以它属于「先写定、等 #179 的尺子来推翻」的那类常数，
改它的正确姿势是新 PR + 实测依据，不是实现时顺手改。

## 3. 逐条口径与取舍

### 3.1 R1 放行集合的两处已知缺口（今天不咬人，但必须写下来）

R1 的放行集合是「启用键盘字符 ∪ 固定区段」。实测发现两类字符**都不在其中**：

1. **IPA 调号字母 `˥ ˦ ˧ ˨ ˩`（U+02E5..U+02E9）**：莆仙三套方案用数字标调，所以今天
   报它们是对的；一旦项目改用调号字母记音，R1 会把每一条都报成集外字符。
   届时改的是 `ALLOWED_RANGES`（并升 `RULES_VERSION`），不是关掉规则。
2. **全角标点 U+FF00..U+FFEF 整段**（如 `（）`）：`assist_rules_integration.mjs` 里
   释义写「第一（个）测试」就会被 R1 报出 `U+FF08/U+FF09`。2026-09-25 在 15,022 行正本上
   实测 `char_out_of_repertoire` 命中 0 条，所以今天不咬人；但这说明放行集合的覆盖面
   是按那份语料的写法校准的，不是按 IPA 全集校准的。

`assist_rules_integration.mjs` 把第 1 条**当成断言写死了**（调号字母必须被报出），
这样将来有人放宽区段时会立刻看到这条测试变了。

### 3.2 R2 只查 IPA 列，不查 `拼音`

混淆表编译自键盘 hint，实测编出 3 组：`a→U+0251(ɑ)`、`g→U+0261(ɡ)`、`|→U+2223(∣)`。
`拼音` 列用拉丁字母是方案本身规定的——在里面报「你打的 a 应该是 ɑ」是纯粹的噪声，
所以 R2 的作用域是 `IPA_FIELDS`。hint 的解析要求同时满足「含区别于」与
「hint 里声明的码位等于目标字符」，解析不出来就不收（宁可少一条规则也不猜表）。

### 3.3 R5/R6 与 #170 的关系

`pages` 今天没有列角色信息（#170 未落地）。R5 的做法是：**上下文里没有 roles 就整条规则沉默**，
不拿列名猜角色。集成测试同时断言了「无 roles 返回空数组」与「有 roles 时精确报出空的必填列」，
所以这条规则的启用与否是可见的，不是静默失效。

R6 的两个判据沿用入仓版的硬编码列名（`拼音`/`莆田IPA`/`仙游IPA`）——这正是 #170 要消灭的东西，
`detectors.py` 的 README 也把它列为已知债务。#170 落地后应改成按角色查询，
届时 `RULES_VERSION` 升版。

### 3.4 占位符为什么要在 R6 里先摘掉

`@20000` 带五位数字串。它是源库缺字登记的**序号**，不是 Unicode 码位，也不是压平的声调。
不摘掉就会同一格挂上两条 strong（占位符 + 压平声调），与「一格一条 strong 独占」相冲。
`a@20000` 在测试里被断言为**不报** `long_digit_run`。

### 3.5 因果抑制不在本 PR

门槛文件 P1 推论（同格结构损坏时不再重复报集外字符）需要 `merged_columns` 与
`char_out_of_repertoire` 同时在场。`merged_columns` 的产出方是 #125/#178，
所以抑制逻辑落在 **#178**（那里两个 kind 真的会同格共存）。
本 PR 不写一段没有触发路径的抑制代码。

### 3.6 疑点挂在哪个条目上（#208 评审要求写定的决策）

`review_findings.page` 在 #176 里是**必填**关系字段，所以连"整列""整页"级别的疑点也必须
挂某一条条目。挂错条目不是统计难看，而是把 A 条目的原样内容片段发给 B 条目的在手校对员
（#175 红线 1）。口径由 `runProjectRules` 决定并写进 `evidence.anchor`，写入端只认它、
不再自己猜：

| 规则 | 挂哪一条 | `evidence.anchor` |
| --- | --- | --- |
| R1、R2、R3 格级、R5、R6 | 产生它的那一条 | `entry` |
| R3 列级、R4 | 扫描顺序第一条 | `column_first_entry` |
| R7（两个判据） | 该 PDF 页上的第一个条目 | `pdf_page_first_entry` |
| 解析不出条目 | 不写入，返回体 `unanchored` 计数并打日志 | — |

- **列级为什么可以挂第一条**：这两条的 `params_json` 只有计数与码位标签（`nfc/nfd/minority`、
  `pairs`/`pair_count`），不含任何原样内容片段，测试 `assist_rules_integration.mjs` 直接钉住了
  "params 里不得出现非 ASCII 内容、不得出现任何一行的单元格原文"。真正的消费方是管理端的
  项目级读口（#176 的 `GET /api/fangji/projects/{id}/findings`）；挂在校对端可见的条目上只是
  #176 契约「page 必填」的连带结果。若以后要让列级疑点脱离条目，需要先放开 #176 的 schema，
  那是 #176 的决策，不在本 PR 顺手改。
- **单条重算不得抹掉任何项目级疑点**：列级与页级疑点也挂在某一条条目上，但单条重算只判定格级
  规则，所以下线范围用 `PROJECT_ONLY_MESSAGE_KEYS` 把这两类一起排除（`assist_writer.js:pageScope`）。
  不排除的话，"给某一条补算"会顺手把挂在那一条上的项目级疑点标下线，而只有项目重算会再产出——
  那是静默永久丢失。上一版只排除了列级两条、漏了 R7（`pdf_page_backtrack`、
  `page_entry_count_outlier`），#212 的评审据此判定链上先不许合入；现在的划分是**格级 / 项目级**
  两份清单，`runProjectRules` 里未归类的格级 key 直接抛错。一致性两头都钉住：
  · 纯函数段从源码抽出引擎实际产出的全部 key，断言两份清单**恰好划分**它（漏归类、清单里残留
    已废弃的 key、两份重叠都会红），并临时摘掉 CELL 里的一项验证那条抛错确实会抛；
  · API 段加了一条 `pdf_page` 回退到第 1 页的第 4 条目，做出真实的 R7 疑点，断言它挂在本项目的
    第一个条目上、并且**在一次单条目重算之后仍然存在**。把排除表改回只有列级，这一条会红
    （已做变异验证）。
  · **这条排除换来的代价要认下来：项目级疑点会陈旧**。单条重算不碰它们，所以某一次编辑如果
    正好让 R7 的回退不再成立（或让整列不再混用两种写法），那条疑点会一直留在当前批次里，
    直到有人跑一次项目级重算才会下线。方向上仍然选这一边——陈旧但可见 > 静默永久丢失，
    而且这两类都是 warn 级、管理端的项目视图本来就要跑批才刷新。
- **`unanchored` 是防御性的**：按现在的实现它恒为 0（挂靠全在规则侧解析）。留着是因为
  上一版的缺陷形状正是"解析不出来就退化成第一条"；宁可它计数并打日志，也不要那条退化路径
  被将来新增的规则重新写出来。它没有独立的测试用例——构造不出来，也不该构造出来。

## 4. 触发与运行

| 路径 | 实现 | 跑哪些规则 |
| --- | --- | --- |
| 提交 | `proofreading.pb.js` 的 submit 成功后调用 `safeRecomputePage`，**传入刚提交的那一行** | R1、R2、R3 格级、R5、R6 |
| 仲裁 | 同上，仲裁落定的最终行 | 同上 |
| 项目全量 | `POST /api/fangji/projects/{id}/findings/recompute`（manager 专属，同步执行，返回 `duration_ms`） | 全部，含整列(R3/R4)与全项目(R7) |
| 单条补算 | `POST /api/fangji/pages/{id}/findings/recompute`（manager 或该条在手者） | R1、R2、R3 格级、R5、R6 |

设计约束与遗留：

- **单条与全量分开**是必须的：整列与全项目判据要看到全部数据才成立，不能挂在提交路径上。
- **规则失败不影响提交**：`safeRecomputePage` 吞掉异常并打日志（`assist_recompute_after_submit`），
  已落库的校对结果不会因为疑点生产挂掉而回滚；管理端可用补算路由重试。
  失败不静默成「没有疑点」——日志里必须有它。
- **重算只下线同 `producer` 的旧批次**：规则重算不得把 OCR(#125) 或 bundle_import(#124)
  的疑点一起标 `superseded`，测试 `assist_rules_integration.mjs` 专门断言了这一点。
- **全量重算没有静默上限**：条目按 `PAGE_SCAN_CHUNK` 游标读到读完为止。上一版是
  `PAGE_SCAN_CAP = 5000` 的一次性读取 + 按 `project` 全量下线，于是第 5001 条往后的当前批次
  被标 `superseded` 却没有新批次替换，那些条目从此永久读不到疑点（#208 评审阻断 2）。
  现在只有两种结局：整批扫完，或命中 `PROJECT_SCAN_REFUSAL` 抛错拒算——而抛错一定发生在
  第一次写之前，所以不存在"部分重算"。这个顺序由测试读 `recomputeProject` 源码钉住
  （把 supersede 挪到扫描之前，黑盒断言要造 5 万条目才看得见）。
  规模上限因此是 5 万条（保险丝），不是 5000；10k 行实测见 §5。
- **并发下的批次收敛**：JSVM 不保证两个重算请求之间不交错（DAO 调用点就会让出运行时）。
  实测同页面 8 个并发重算会留下「较新的一份被后跑的下线」的**残缺**批次——某次记录里当前
  批次只剩 `long_digit_run` + `tone_token_count_differs` 两行，本该有五行。校对端看到的就是
  疑点变少，这比重复更难发现。收尾(`settleBatch`)因此按「只下线**严格更早**的批次」：
  新批次永远不会被旧批次的收尾抹掉，丢信号这条路被堵死。
  代价是同毫秒开始的几批互不杀伤，会并存成重复 hint。重复量由测试每次打印、不断言，
  2026-09-25 三次实测：
  `ASSIST_CONCURRENCY {"requests":8,"current_rows":8,"distinct_keys":4,"distinct_batches":2,"largest_batch":5,"repeat_factor":2}`
  另两次是 `repeat_factor: 1.5`（6 行 / 2 批）与 `6.25`（25 行同一毫秒，等于 5 批并存）。
  要把重复也收敛掉，判据得换成「只留我自己这一批」——按插入返回的记录 id 分组是可行的
  （实测 `dao.save` 之后 JS 侧能读到 15 位 id），但同毫秒的两批会互相杀伤，中途读到就可能
  归零，风险方向正好是上面那种更难发现的残缺。本 PR 因此选了「宁重复勿残缺」；
  那条路本 PR 没有实测数据，留给维护者定：
  (a) 按 id 收敛（本 PR 内可做，需要先有稳定的并发回归）；
  (b) 给 `review_findings` 加一个 batch id 字段，让「同毫秒的两批」在数据上可区分
      （那是 #176 的 schema 决策，#177 不单方面改）。
  比较两个日期串前先 `stampKey` 归一化：DAO 写回的 `produced_at` 是
  `"2026-09-25 13:52:21.771Z"`（空格分隔），而 `nowStamp()` 给 ISO 的 `T` 形式，
  直接比字符串会把每一批都判成「更新」，让整步收尾静默失效。
  测试钉住的是这个交错下唯一稳定成立的不变量：**校对端可见的疑点集合不缺也不多**，
  并且库里至少留着一份完整批次。
- **未接自动触发（本 PR 的已知缺口）**：`import_service.go` 用 `app.Save()`（DAO 层）落
  `import_jobs`/`pages`，而 PocketBase 的 JS 模型钩子只经由 RecordService 触发，
  所以 JS 侧看不到「导入完成」这个事件。本 PR 因此**不改 Go 导入工作器**，
  全量重算目前由 manager 路由显式调用（#124 的导入预览是天然调用方）。
  要自动化，两条路：把工作器里的 `app.Save` 换成 `services.NewRecordService(app).Save`
  （改动面覆盖导入热路径与它的测试），或在 Go 侧起一个作业调用同一套逻辑。
  两者都不适合塞进本 PR，已作为 #177 的遗留项单独说明。
- **规则是 JS 纯函数，这条选择有一个连带后果要维护者确认（#208 评审决策 1）**：
  #177「触发与运行」里剩下的「导入完成后由后台作业全量算一次」在 Go 侧
  （`import_service.go` 的导入收尾），而 R1–R7 的判定住在本 PR 的 JS lib 里，
  Go 作业没法直接复用这些纯函数。届时要么让作业回调本 PR 的 manager 路由（需要先有一条
  服务身份路径，目前是 `$apis.requireAuth("users")`），要么把规则在 Go 里再实现一遍
  （两套实现的漂移面）。本 PR 选 JS 的理由写在提交说明里：提交/仲裁本来就是 JS 钩子路由，
  纯函数 + 表驱动单测 + 零新依赖三条都满足，而且能不起服务器直接在 node 里跑。
  这个取舍属于 #177 的遗留范围，不由本 PR 单方面定案。

## 5. 实测数字（2026-09-25，`assist_rules_integration.mjs` 输出）

```
ASSIST_FP_RATE {"normal_rows":8,"r1_r2_findings":0,"keys":[]}
ASSIST_P95 {"case":"silent_row","findings":0,"samples":30,"p50":2,"p95":3,"max":4}
ASSIST_P95 {"case":"one_finding","findings":2,"samples":30,"p50":3,"p95":4,"max":5}
ASSIST_P95 {"case":"many_findings","findings":5,"samples":30,"p50":4,"p95":5,"max":6}
```

- **反向用例**：8 条含 `ɒ̃ Ǿ ʔ`、数字调号与合法占位符的正常莆仙条目，R1/R2 命中 **0** 条。
- **单条重算 p95 = 3–5 ms**（30 次采样，走 HTTP 计时，含读页、读项目键盘配置、下线旧批次、
  插入新批次、收尾的全部开销），满足 #177 的提交路径预算 50 ms。三种形状分开量：
  静默行、单疑点行、多疑点行——只量静默行等于没量提交路径（上一轮的非阻断项）。
- **50 ms 不当 CI 门禁**，这是 2026-09-25 由一次真实红测出来的：同一份代码在 GitHub runner 上
  `many_findings` 两次分别跑出 `p95 = 11 ms / max = 107` 与 `p95 = 52 ms / max = 296`
  （后者直接把 `p95 < 50` 的断言判红，`silent_row` 同期也从 p95 7 ms 涨到 11 ms）。计时含 HTTP
  往返与调度，Shared 型 runner 的抖动就有 5 倍，写成断言等于装一支随时会误报的旗。
  #177 验收第 70 行的原话是"p95 < 50 ms，**日志或测试记录**为证"，所以现在的口径是：
  `ASSIST_P95` 照常打印（含 `acceptance_budget_ms: 50`），CI 只守一条 500 ms 的灾难线
  （提交路径被改成整项目扫描/N+1/两两全比时会落到秒级），50 ms 由人对着日志核。
- 上面的数字来自 2026-09-25 的同一台机器（darwin/arm64），同一测试连跑 5 次全绿，
  并发那一节每次都能量到 52 行历史批次与 8 份交错批次。
- **10k 行项目全量**：本 PR 单独口径仍未测（本 PR 的测试项目只有 4 条），但**链顶口径**有数：
  同一份 #178 合成压力 fixture（10k 行、1/4 共享身份）上，
  `POST /projects/{id}/findings/recompute` = **10746 ms（1.07 ms/行，29,184 条 finding，
  `unanchored = 0`）**，同 fixture 的跨行那一跑是 6708 ms。
  差的那 4 s 是 #180 挂在同一次重算尾部的每页 tier 刷新（N+1），
  所以这 10.7 s **不能替 #208 单独报验收**——等 #209/#211/#212 依序合入后用
  `measure_identity_scale.py` 重跑一次才是本 PR 自己的数字。
  游标已经保证「扫不完就在写入前整批拒算」，因此这个数字将来只影响耗时、不影响正确性。

## 6. 每条规则的验证矩阵

`assist_rules_integration.mjs` 的纯函数部分逐规则覆盖「命中 / 不命中 / 边界」：

| 规则 | 命中 | 不命中 | 边界 |
| --- | --- | --- | --- |
| R1 | `→`(U+2192) 在释义里 | IPA 里的 `ã ɒ̃ ʔ Ǿ` | 键盘内的 `∣`(U+2223) 虽在放行区段外但**不报**；调号字母**报**（§3.1） |
| R2 | IPA 列的 `a` | 拼音列的 `a`；IPA 列真正的 `ɑ` | 一格两个 `a` 只报 1 条但列 2 个位置 |
| R3 格级 | NFD 的 `a+U+0303` | 预合成 `ã`(U+00E3)；纯 `ka` | 非记音列不查 |
| R3 列级 | NFC 与 NFD 并存 | 全列同形 | 形式中性值(`ka`)不得被当成一种形式 |
| R4 | 同列 `（` 与 `(` 并存 | 全列只用全角 | — |
| R5 | roles 下必填列为空 | 无 roles（#170 未落地）；region 空 | roles 为空对象也算无角色 |
| R6 | `ua5333` | `ua533`、`oa453`、`a2` | `a@20000` 不报；两列调号数不等才报第二条；缺列不猜 |
| R7 顺序 | 40→12 页 | 单调序列 | 回退 1 页在容差内不报 |
| R7 密度 | 30 条 vs 中位数 6 | 均匀 6 条/页 | 样本 < 20 页时沉默 |

写入路径（`assist_rules_integration.mjs` 的服务端段）另外覆盖三件事：

| 面 | 正例 | 反例 | 边界 |
| --- | --- | --- | --- |
| 挂靠(§3.6) | 第 1 与第 3 条各自产疑点、各归各条目 | 干净的第 2 条零条（含 info 与列级） | 列级两条只挂第一条；params 里不得出现任何一行的原文 |
| 条目游标 | chunk=1 / 3 / 整批都能读完整批 | — | 命中保险丝抛错；supersede 必须在扫描之后（读源码钉） |
| 并发批次 | 同页面 8 个并发重算后可见疑点集合不缺 | 同集合不多出规则不产的东西 | 同毫秒可短暂重复批次，但库里必须留一份完整批次 |

## 7. 与 #179 门槛的关系

本文件定的是**规则会报什么**，不是**该不该给校对员看**。后者由 `assist_rule_gates` 决定，
新规则入库时一律没有登记行 ⇒ 按 `off` 处理 ⇒ 校对端一条都看不到。
#179 的弱标注集跑出每条规则的 `n` 与 `p̂` 之后，按门槛文件 §2 的判据置档。
本 PR 的集成测试特意在「一条 gate 行都没有」时断言在手校对员拿到 `hints: []`，
并在只给一条规则置 `strong` 后断言只有那一条可见——这条联动是 #176/#177 之间
最容易各自实现一套过滤而后失配的地方。
