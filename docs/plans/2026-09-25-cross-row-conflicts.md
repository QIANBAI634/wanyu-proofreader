# 同身份跨行与跨来源冲突检出（#178）

> 实现：`backend/pb_hooks/lib/assist_identity.js`（纯函数）、
> `backend/pb_hooks/lib/assist_writer.js` 的 `recomputeIdentity`、
> 迁移 `1789113800_entry_identity.js`、验证 `backend/tests/identity_integration.mjs`。
> 疑点数据形状与门控见 [`2026-09-25-review-findings.md`](./2026-09-25-review-findings.md)；
> 规则引擎（#177）见 [`2026-09-25-assist-rules.md`](./2026-09-25-assist-rules.md)。

## 1. 前置约束：R-DEDUP（从 #171 移植，不可违背）

条目身份 = `(headword, pinyin)`，**同形词头绝不合并**。所以本 issue 不报「重复」，
只报「身份冲突」与「疑似结构损坏」。这不是措辞游戏：分组键就是 `(词头, 记音)`，
同词头不同拼音的两条**落进不同的桶**，因此"绝不误合"是结构性质，不是靠代码里
"记得判断一下"。测试 `R-DEDUP 反向用例` 断言的就是这一点（两条都保留、零 finding）。

## 2. 身份键

```
entry_identity_key = 归一化(词头) + " " + 归一化(记音)
归一化 = NFC → 全/半角折叠 → 删除所有空白
```

- **分隔符必须可打印**。第一版用 `\u0000`，结果是 `finding_dismissals.group_key`
  写入被 PocketBase 拒成 400，而且管理端根本没法肉眼读一个含 NUL 的分组键。
  归一化已经把两段里的空白全去掉了，所以空格分隔是无损、可反解的。
- 词头取 `词条`，记音取 `拼音`/`莆田IPA`/`仙游IPA` 里第一个非空的。
  **#170 落地后改成按列角色取**（与 #177 的 R5/R6 同一处债务），届时升 `IDENTITY_VERSION`。
- 两段任一缺失 ⇒ **不产生键**（`null`）。宁可少算，也不要拿不完整的键把别的条目误合进来。
  这类条目计入 `unkeyed`，在汇总里可见，不是静默丢弃。

## 3. 三条规则的现状

| kind | message_key | severity | 状态 |
| --- | --- | --- | --- |
| `duplicate_identity` | `same_identity_different_content` | strong | ✅ 已实现 |
| `merged_columns`（规则生产者） | `multiple_headwords_in_cell` / `reading_inside_meaning_row` | strong / warn | ✅ 已实现 |
| `cross_source_conflict` | — | — | ❌ **不实现，缺 #169** |

`cross_source_conflict` 必须经 #169 的 `sources` 登记来源才能判，而 #169 至今 OPEN、
`sources` 集合不存在。#178 正文自己要求「来源缺失时只报 `duplicate_identity` /
`merged_columns`，不报跨来源冲突，避免虚假结论」，所以这里缺的是**依赖**，不是遗漏。
实现里没有半成品的跨来源代码路径，测试则**显式断言这个 kind 一条都不出现**——
这样将来 #169 落地时必须是一次有意的改动，而不是某次"顺手就报了"。

`merged_columns` 与 #125 的**同名同语义、不同生产者**（`producer = rule` vs `ocr`）。
判据只有两条形状检查：一格内出现 ≥2 个词头片段、释义列含数字调号串或 IPA 记音符。
参考 `w4_blocked_queue.py` 的「列合并修复」分诊桶。

## 4. `producer = "rule"` 的批次必须按 kind 收口（本轮修掉的一个真实隐患）

#177 与 #178 都用 `producer = "rule"` 写 `review_findings`。如果两边的"重算 = 下线旧批次"
只按 `producer` 过滤，那么**跑一次 #177 的全量重算会把 #178 的跨行疑点全部标 superseded，
反之亦然**，而两边各自看自己的表都"正常"。

现在 `supersede(...)` 必须带一个 kind 集合：

```
RULE_KINDS     = char_out_of_repertoire, confusable_substitution, encoding_form_anomaly,
                 missing_field, reading_format_invalid, punctuation_mix, page_outlier
IDENTITY_KINDS = duplicate_identity, cross_source_conflict, merged_columns
```

`identity_integration.mjs` 有双向断言：跑完 #177 的重算后 #178 的批次数量不变，
反之亦然；并且先断言两边**都有**批次，否则这两条比较是空真。

## 5. 人工结论 `not_conflict`

新集合 `finding_dismissals`（`project` + `group_key` + `kind` 唯一索引，五个 API 规则全 null）：

| 路由 | 权限 | 语义 |
| --- | --- | --- |
| `POST /api/fangji/projects/{id}/dismissals` `{group_key, kind, note}` | manager | 把一组判成"不是冲突"，幂等（已存在返回原行 + `existed: true`） |
| `DELETE /api/fangji/projects/{id}/dismissals/{id}` | manager | 显式撤回（而不是悄悄覆盖，这是本 issue 唯一的人类写入） |

它在独立集合而不是给 finding 打标记，理由：机器批次会被下一次重算下线，
**人工结论不该跟着下线**。#178 正文说这是"本 issue 唯一允许人写的状态"，
`kind` 参数也被限制在三类冲突之内（写别的 kind 直接 400）。

已测：标 `not_conflict` → 重算后该组零 finding，而**其他 kind 照常出现**
（只跳过被标的那一组，不整批沉默）；撤回 → 重新报出。

## 6. 运行方式与规模

- **只在批处理路径跑**：跨行比较是 O(n) 起，绝不挂到提交路径（#178 正文明确要求）。
  入口是 `POST /api/fangji/projects/{id}/identity/recompute`（manager 专属，同步，返回
  `pages / findings / unanchored / superseded / backfilled_keys / dismissed_groups / duration_ms`）。
- `unanchored` 与 #177 的项目级重算同形状：挂靠解析不出来就跳过并计数＋`console.warn`，绝不
  退化成"挂到第一条"。今天这条分支结构上不可达（anchor 取自与 `byId` 同一份 `entries`），
  留它只为了让两条批处理路径在"规则产了但写入端没接住"这件事上都留得下痕迹；**因此它没有
  非零用例可测**，本节把它写成一致性项而不是证明项。
- 同一次调用顺手回填 `pages.entry_identity_key`。第二次跑 `backfilled_keys = 0` 且键值不变
  （幂等、可重跑，这是 #178 的验收项）。
- **10k 行端到端实测**（2026-09-25，`python3 backend/tests/measure_identity_scale.py 10000`，
  该脚本不进 CI——它测容量不测正确性，且在矩阵里会是最慢的一环）：

  | 指标 | 实测 |
  | --- | --- |
  | 行数 | 10,000（其中 1/4 共享身份，制造真实分组压力） |
  | 全量重算耗时 | **6123 ms**（含身份键回填与 17,840 条 finding 写库）；承接 #208 修复后重测为 **6708 ms / 第二次 6894 ms**，finding 数完全一致。两个数字都留着：前者是本节第一次写下时的实测（`86e69d1`），后者是当前 head 的实测，差异来自写入侧改动（批次收尾 + 与 #177 共用游标）而非数据变化 |
  | 每行均摊 | 0.61 ms（重测 0.67 ms） |
  | 产出 finding | 17,840 条 |
  | 第二次重算 | 6396 ms、finding 数完全一致（可复算） |
  | 300 行的同口径数字 | 164 ms / 0.55 ms 每行 |
  | 同一份 fixture 上 #177+#180 那一跑 | **10746 ms**（1.07 ms/行，产出 29,184 条 finding，`unanchored = 0`） |

  两条批处理路径现在由同一个脚本一次量完（`measure_identity_scale.py` 同时打
  `rules_run` 与 `first_run`），因为 #212 评审的非阻断项问的正是这个差：
  同一份 10k fixture 上，规则那一跑比跨行那一跑慢 4 s，差值就是
  「每页一次 `refreshDifficulty`（一次疑点查询 + 一次行解析）」的 N+1 成本。
  收它的正确姿势是把项目级的 tier 刷新改成**一次批量读**（按 page 分组当前批次），
  不是把上限调大；本 PR 暂不合并这段改动（它在 #180 的文件里），差距在 10k 量级
  是 1.6 倍，不到必须处理的程度，数字先记在这里。

  规模上限因此**不是一个截断用的常数**：扫描是固定游标分批翻页直到取完
  （`PAGE_SCAN_CHUNK = 1000`，与 #177 共用同一个 `loadAllPages`），所以 10k 不会被静默丢掉。
  游标里唯一的上限是 `PROJECT_SCAN_REFUSAL = 50000` 那条内存保险丝：它经 `readAllInChunks` 的
  `onBatch(rows)` 在**读完每一批之后**判，命中即抛，所以一次拒算最多吸进 `refusal + chunk` 行；
  抛错一定发生在第一次写之前——不存在"扫了一半下线了全项目"这种中间态。
  这一度是坏的：`fbcacbb` 为了消灭"上限截断"把 `loadAllPages` 改成走通用游标，同时把判据挪到了
  读全之后，"命中即抛"变成"读完即抛"，于是这条防线要防的那次分配恰好是它唯一没防住的。
  `assist_rules_integration.mjs` 现在直接数拒算之前 dao 交出了多少行（`chunk: 3 / refusal: 4`
  的 20 行数据集，断言 ≤ 7），并同一份 fake dao 在读全时恰好数到 20 行——两种实现可以分辨，
  计数器本身也不是恒零的。
  可接受的运营上限按实测写定为
  **单项目 2 万行以内一次重算控制在 ~15s 量级**；再往上应当拆分项目或改成分批作业，
  而不是把常数调大。`backend/tests/identity_integration.mjs` 里还有一条纯函数级的
  10k 分组断言（15ms、并断言 < 4s），用来在退化成两两全比时立刻报警。
- 两条批处理路径的**耗时**仍不对称，这是有意的：#177 的项目级重算会为每一页刷新难度标签
  （每页一次疑点查询），10k 页就是 10k 次查询；跨行检出只需要一次全量分组。
  扫描语义已经统一（同一个 `loadAllPages`），剩下的差距要靠把难度刷新改成批量读来收，
  而不是靠调大上限——上限只用于拒算，不用于截断。
- **不对称的另一半是新鲜度，而且它是有意选择**：`recomputeIdentity` 一次 `refreshDifficulty` 都不调，
  而它正是 `duplicate_identity`(strong) 与 `merged_columns`(strong) 的唯一生产者——这两类都能改 tier
  （两条同页 strong 就把 `strong_findings_ge_1` 抬到 `ge_2`），而 #162 是按 `difficulty_tier` 筛选排序的。
  于是跑完 `identity/recompute` 之后，管理端看到的排序描述的还是这次跨行检出**之前**的疑点集合。
  现在的收法是评审提的第 2 条：返回值带 `difficulty_stale`（本轮有产出或有下线时为 true），
  路由注释与本节都写明「之后要再跑一次 `POST /projects/{id}/findings/recompute`，tier 才是新的」，
  而不是把每页一次的 N+1 塞进本支（那条成本已量化：最坏 0.61 → 1.07 ms/行，见上面的实测）。
  疑点不会丢：下一次项目级重算读的是 `superseded_at = ""` 且不按 kind 过滤，会自己追平。
  #162 真按 tier 排序上线时，应当回来做第 1 条（identity 路径顺手刷 tier）。
- 分组结果按 key 排序后再产出，所以同一份数据的 finding 顺序稳定，diff 可复现。
- **撤回人工结论是物理删除、不留痕**：#178 只要求「人工结论在重算时保留」，没有要求撤销可审计，
  所以 `finding_dismissals.status` 只有 `not_conflict` 一个值。要留痕得先给该列加值
  （一次 select 迁移），那是本 issue 之外的决定。
- **`POST /dismissals` 的「先查再插」有一个理论窗口，但我没能复现它，因此没有为此改代码**：
  路由承诺同一组重复提交返回 `existed:true`，靠的是插入前的一次存在性检查；两个管理端同时
  确认同一组时，两条都可能通过检查，第二条会被唯一索引 `(project, group_key, kind)` 拒绝成 500。
  我试着复现：4 个并发从不碰撞；24 个并发的两次运行一次失败一次通过，而失败那次的报错我也
  没能定位到请求状态。既然不能稳定复现，就不写一个"测不出来的测试"、也不加没有证据的兜底。
  要收这条的话，判据很清楚：把索引冲突折回同一条 200 返回；并且**先证明并发量到多少才撞**，
  否则测试只是愿望。
- **未测的已知限制**：`decided_by` 是 `required: true` 且 `cascadeDelete: false` 的 users 关系。
  删除一个下过人工结论的管理端账号时，其结论行会留下悬空引用（或账号被拒删），今天没有
  测试覆盖这条路径。改 `cascadeDelete: true` 等于"删账号连带删人工结论"，也未必是想要的语义，
  因此写在这里而不是顺手改。

## 7. 门槛与精度

新批次入库时**没有登记行 ⇒ 按 `off` ⇒ 校对端一条都看不到**（#176 的门控语义）。
本 issue 的验收项「精度数字来自 #179 的尺子并回填」目前的状态：
#179 的打分粒度是 `(提交, 字段)`，而跨行疑点的对错要两条一起看才算，
因此 `duplicate_identity` / `cross_source_conflict` **今天无法度量精度**，
需要把标注提到 `(提交, 条目)` 或 `(提交, 列)` 粒度。已作为结论回填在 #178 的
#179 comment 里。在此之前保持 `off` 是正确的：那是"还没测"，不是"测出来不好"。

## 8. 不做（#178 非目标，逐条落到了断言上）

不合并、不删除（测试断言检出后 4 个条目都还在）、不做模糊匹配/编辑距离/向量相似度
（纯字符归一化，无相似度代码）、不跨项目（分组带 `project`）、不裁决谁对
（finding 只列出差在哪几列，不含建议值）、不写回任何值。
