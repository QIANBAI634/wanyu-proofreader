# `scripts/assist` — 弱标注集与规则打分（#179 spike）

这条目录交付的是**尺子**，不是产品代码：从平台已经在免费生产的「两份独立结果 + 一个人工确认
的最终值」里按字段对齐产出弱标注，然后给每条规则算命中数/精度/召回/分组误报，
最后产出一份分合成与真实两栏的基线报告。门槛数字本身不在这里定，
见 [`docs/plans/2026-09-25-assist-rule-thresholds.md`](../../docs/plans/2026-09-25-assist-rule-thresholds.md)。

```
lib/labeling.mjs   纯逻辑：字段对齐、伪分歧标记、打分、Wilson、门槛判据、报告渲染
weak_labels.mjs    只读加载器 → JSONL 弱标注（默认脱敏）
score_rules.mjs    加载器 + 规则清单 → 打分结果与 Markdown 报告
```

## 1. 用法

```bash
# 对着一个只读的 PocketBase 数据文件
node scripts/assist/weak_labels.mjs --db backend/pb_data/data.db --out /tmp/labels.jsonl
node scripts/assist/score_rules.mjs --db backend/pb_data/data.db --json /tmp/score.json \
  --report /tmp/baseline.md

# 或者对着一个 JSON 导出（{pages:[{id,project,final_row_json}], attempts:[...]}）
node scripts/assist/score_rules.mjs --records backend/tests/fixtures/assist_traps.json
```

全程只读；不需要服务器；不加 `--report` 时报告打到 stdout。
`--keyboard` 可覆盖键盘口径（默认用仓库内的 `backend/keyboards/hinghwa-dialect.json`）。

`--db` 会自己读 `projects.column_roles_json`，报告头因此必须说清列角色的来源
（`--roles` / 库内 / 导出文件自带 / 没有 / 多项目不一致）。这件事值得写进文档是因为
它曾经的失败模式是**静默少评一条规则**：R5（必填角色列为空）的判定作用域由列角色决定，
读不到就整条不评，而旧报告只写一句「未提供」，读者会把它当成「这条规则精度为 0」。
一张库里有多个项目且列角色不同时**不挑一个用**，直接降到不评并点名原因。

## 2. 脱敏（不可协商）

默认输出**不含任何单元格正文**，只含 id、字段名、长度、码位集合与摘要。
判据同 `scripts/corpus_probe`：**码位是结构信息，字形序列是内容**。
`--show-values N` 是显式逃生口，它会在 stderr 上警告自己输出了正文。
`backend/tests/assist_baseline_integration.mjs` 对默认输出做了字符串级排除断言，
所以"忘了脱敏"会变成测试失败而不是悄悄泄漏。

## 3. 一条必须写下来的方法论结论：precision 有定义，recall 没有

仲裁差量给出的是「这个字段被人工改掉了」，**不是**「本该由哪条规则发现它」。
空释义是 R5 的靶子，R1 抓不到它不算漏检。所以：

- **precision 定义良好**：一条规则命中了 N 个 (提交, 字段)，其中有多少确实被人工改过。
  这是门槛文件 §2 唯一使用的量，打分器与升档判据都以它为准。
- **recall 只在规则自己的字段作用域内报**（`all` / `reading` / `ipa` / `role_required`），
  并且它是**下界意义上的覆盖率而非真召回**——同一个负例可能因规则表达不了的原因被改。
  超出作用域的负例不计入 FN。
- 报告里 recall 一律带这个限定；如果有人拿它当"规则抓全了没有"，那是误用。

## 4. 未覆盖，不是 0 分

R3 列级（`mixed_normalization_forms`）、R4（`punctuation_mix`）、R7 的两个判据**不参与打分**：
它们要看整列/全项目才成立，而弱标注的粒度是 `(提交, 字段)`。
它们出现在报告里会被读成「精度 0」，所以打分器根本不列它们
（`score_rules.mjs` 的 `defaultRuleSet` 上有注释说明）。
跨行三类（`duplicate_identity` / `cross_source_conflict` / `merged_columns`）**同样不参与打分**，
理由不同但后果一样：`ruleFlagsRow` 只能重跑 `runPageRules`，跨行判据要全量分组才成立，
而 `defaultRuleSet` 没有列它们——`gate_changeset.mjs` 的 `NOT_SCOREABLE` 只点名了前四条，
所以这四条会在变更集里以「不参与打分」出现，跨行三条则**连点名都没有**。
要度量它们，需要先把标注粒度提到 `(提交, 列/页)` 或 `(提交, 分组)`——那是 #185 一类的结构改动，不在本 spike 范围。

2026-10-02 起这份「未覆盖」清单不再手写：它与「跨行身份族」（`merged_columns` 两个 key、
`duplicate_identity`、`cross_source_conflict`，#254 报的就是这一族以前两栏都不提）
合并成一处定义 `backend/pb_hooks/lib/rule_coverage.js`，`gate_changeset.mjs` 报告的
第三栏「无打分通道」与 `score_rules.mjs` 的 `defaultRuleSet` 都从它读，漏归类套件会红。

## 5. 「先定线」的时间戳证据

#179 的核心交付是「门槛数字早于 #177 的实现合入」。实测：

| 事件 | 时间 |
| --- | --- |
| 门槛文档 PR #206 合入 `upstream/main` | 2026-09-25T07:42:55Z |
| #177 实现 PR #208 开出 | 2026-09-25T11:12:35Z |

门槛数字早于实现 PR 3 小时 29 分，可验证。

## 6. 复现与验证

```bash
python3 backend/tests/run_integration.py assist_baseline_integration.mjs
```

它注入 5 类已知陷阱（NFD 序列、`a` 代 `ɑ`、空释义、全半角混用、页码乱序），
把每条规则的 hits/tp/fp/fn/precision/recall/gate 与 `backend/tests/fixtures/assist_traps.json`
里的**手算期望值**逐字段对齐，含分母为 0 的情形（`precision` 必须是 `null` 而不是 `0`）。
同一份 fixture 也是 §7 报告的输入，所以报告里的数字与测试断言的是同一批。

## 7. 本轮产出的报告

[`docs/testing/assist-baseline-2026-09-25.md`](../../docs/testing/assist-baseline-2026-09-25.md)
——合成栏有数字，真实栏 `n/a`（部署库内还没有真实分歧/仲裁样本）。
志愿者上线并产生仲裁之后，重跑 §1 的命令即可把真实栏填上；
两栏数字不得合并、不得平均，也不得对外用作准确率承诺（#97）。

## 8. 结论回填

按 #179 的验收项，结论要回到 #177 / #178 / #180 / #161 四个 issue 各一条 comment。
本轮回填的要点：所有规则样本量都远低于 `n_min` ⇒ **一律保持 `off`**；
R5 的启用还多压着一个 #170；R3 的 info 级在伪分歧上命中，正是"它不该进校对端"的实证。
