# 语料探测脚本（corpus probe）

离线检查一份方言资料 CSV 里**可疑的值**，只报不改。这里是 #177（第 0 层确定性规则）的参考实现，finding 的 `kind` 取自 #176 的枚举；它**不是产品代码**：不参与导入、校对、仲裁，也不写任何库。

## 来源

从 W2 工作区的探测脚本手工移植而来（`anomaly_probe.py` / `anomaly_probe2.py`，原先只存在于某台机器的会话缓存目录里，见 #193）。移植时做了三件事：

1. **删掉硬编码的本机路径**，输入必须显式给出（见下）；
2. 把 print 型脚本改成**纯函数 + 一个 CLI**，从而可被单测与 #179 的打分脚本直接调用；
3. 拆掉原脚本里定义了却没使用的 `LEGAL` 常量——实际判定只依赖 `533` / `453` 两个合法三数字调值，这一点现在写在 `LEGAL_LONG_TONES` 上并有正反用例。

只用 Python 标准库，未新增任何依赖。许可随仓库（`LICENSING.md`，AGPL-3.0-only），不含第三方资产，故不触发 `ASSET_BOUNDARIES.md`。

## 用法

```bash
python3 scripts/corpus_probe/probe_corpus.py --csv /path/to/正本.csv
python3 scripts/corpus_probe/probe_corpus.py --csv /path/to/正本.csv --json
python3 scripts/corpus_probe/probe_corpus.py            # 或 export WANYU_CORPUS_CSV=...
```

输入优先级：`--csv PATH` > `$WANYU_CORPUS_CSV` > 报错。**没有默认值**——默认值曾写死为作者本机的绝对路径（含用户名与会话 ID），在任何第二台机器上都会失效。字符集基线同理：`--keyboard PATH` > `$WANYU_KEYBOARD_JSON` > 仓库内的 `backend/keyboards/hinghwa-dialect.json`。

## 输出纪律

| 模式 | 给出什么 |
| --- | --- |
| 默认（人读） | 文件名（非路径）、sha256 前缀、行数、各 kind 计数、按列计数、受影响行数 |
| `--json` | 上述 + 每条 finding 的 `line` / `kind` / `severity` / `field` / `message` 与**已脱敏的** `params` |
| `--show-samples N` | 只有这里才输出单元格原文，并在 stderr 警告「输出已含语料内容，勿粘贴」 |

`params` 里 `runs` / `marks` 这类**逐字引用单元格**的字段会被剥掉，只留 `run_count` / `mark_count`；`codepoints`（十六进制码位）保留——它是 #123 判断如何无损表示所需的结构信息，不是词典正文。

之所以这么切：这类诊断天然会被粘进 issue 讨论，而 `CONTRIBUTING.md` 与 #120 都禁止未授权语料入仓。测试 `test_default_output_echoes_no_cell_value` 与 `test_json_output_is_redacted_…` 会遍历合成语料的**每一个非数字单元格值**逐个断言不出现，而不是抽查一两个。

错误信息里的家目录前缀会缩写成 `~/`，避免把用户名带进被粘贴的 stderr；非 UTF-8 与空文件走 `error: …` + 退出码 2，不抛 traceback。

```
$ python3 scripts/corpus_probe/probe_corpus.py --csv scripts/corpus_probe/fixtures/mini_corpus.csv
source: mini_corpus.csv  sha256: d8e499c2c80694bf…
rows: 14  findings: 19
       5  merged_columns [strong]
       4  missing_glyph_placeholder [strong]
       3  reading_format_invalid [strong]
       2  outside_unicode_set [warn]
       2  char_out_of_repertoire [warn]
       1  merged_columns [warn]
       1  encoding_form_anomaly [info]
       1  encoding_form_anomaly [warn]
by field: (row)=1, 仙游IPA=1, 拼音=8, 莆田IPA=4, 词条=2, 释义=3
affected rows: 12
```

## 规则清单

| 检测函数 | kind | 默认严重度 | 含义 | 已知的误报面 |
| --- | --- | --- | --- | --- |
| `detect_illegal_tone_runs` | `reading_format_invalid` | strong | 记音列里 ≥3 位连续数字，除 `533`/`453` 外都视为上标声调被压平 | 真需要三位以上调值的方案（莆仙三套方案里没有）；`@十六进制` 占位已先剔除 |
| `detect_tone_count_mismatch` | `reading_format_invalid` | warn | `拼音` 与 `莆田IPA` 的声调 token 数不等，通常意味着漏字或多字 | 「22 压平成 222」不算 token 差（由上一行负责）；占位数字已剔除 |
| `detect_missing_glyph_placeholders` | `missing_glyph_placeholder` | strong | `@十六进制` 形式的集外字占位 | —— |
| `detect_column_collapse` | `merged_columns` | strong | 记音/释义列里出现地区标签 `〔莆〕〔仙〕〔莆田〕〔仙游〕`，或方括号不配对（全角与半角分别计数，`[a］` 判为不配对） | 释义里合法使用方括号注码 |
| `detect_row_width` | `merged_columns` | strong | 一行的单元格数与表头不符 | —— |
| `detect_phonetic_in_meaning` | `merged_columns` | warn / strong | 释义列里混进一串记音（strong = 整格就是一段记音） | 用 `：`/`‖` 分层的释义不报 |
| `detect_inconsistent_forms` | `encoding_form_anomaly` | warn | 同一列里 NFC 与 NFD 两种编码形式并存，报少数派 | 只提示，**不改写**任何值 |
| `detect_combining_marks` | `encoding_form_anomaly` | info | 该值含组合附加符，列出码位 | 合法 IPA 组合符很多，所以是 info |
| `detect_non_repertoire_chars` | `char_out_of_repertoire` | warn | 出现既不在项目启用键盘里、也不在下列放行段中的非 ASCII 码位 | 键盘 JSON 本身是待维护清单，缺键会表现为误报 |
| `detect_cjk_extension` | `outside_unicode_set` | warn | 出现非 BMP 汉字：扩展 B/C/D/E/F/G/H 与兼容补充表 | 由 #123 决定如何无损表示 |

### 哪些规则看全列，哪些只看记音列

`detect_missing_glyph_placeholders` 与 `detect_non_repertoire_chars` **对每一列都跑**。它们回答的是「这一格里的字符能不能被表示」，与列承担什么语义无关；`词条` 与 `释义` 恰恰是最容易撞上这个问题的两列。

其余规则按列语义分流：`detect_illegal_tone_runs`、`detect_combining_marks` 只在记音列（`reading_fields`），`detect_phonetic_in_meaning` 只在释义列，`detect_column_collapse` 两边都跑。

> 曾经的 bug（#205）：这两个检测器也被 `reading_fields` 门控挡住，在真实 15,022 行正本上 **793 处占位符一处都没报**——因为它们全部落在 `词条` / `释义`，而记音列一处也没有。同步进平台规则会让规则引擎继承同一个盲区。`reading_fields` 仍是硬编码列名，由 #170 换成按列角色查询。

`char_out_of_repertoire` 的放行段（`ALLOWED_NON_REPERTOIRE_RANGES`）= IPA 区段 + 通用标点 + CJK 符号与标点（含 `〔〕`）+ 扩展 A + 统一表意 + 兼容表意 + 所有非 BMP 汉字区段。理由与 #177 R1 一致：**记音列里出现汉字是结构问题（`merged_columns`），不是「校对员打出了打不出的字符」**；非 BMP 汉字已有自己的 kind，不再二次报。

## 一格只报一次

`analyze_row()` 里有一条抑制规则：某个格子已被 strong 级的 `merged_columns` 或 `missing_glyph_placeholder` 判为结构损坏时，**同一格的 `char_out_of_repertoire` 不再重复报**。它挡的是「`zua42 〔莆〕 Ω`」这类同格混入真正打不出字符的情形（`test_a_broken_cell_reports_once`）。

这条抑制的覆盖面随 #205 一起扩大了：占位符检测不再受记音列门控后，`词条` / `释义` 里带占位符的格子同样会抑制同格的集外字符报——这才是抑制规则原本的意图（一个格子只留一条结构性问题）。

理由写在 #175 的红线里：校对员一旦学会忽略标记，整套机制就失效了。strong 级假阳性最贵，所以 #179 的门槛也按 strong 单独设。

## R-DEDUP：不要在这里长出「自动合并重复词条」

`entry_identity()` 与 `group_by_identity()` 表达的是项目既定的领域规则：**同形词头绝不合并，条目身份 = `(headword, pinyin)`**。同一词头多行是正常语料形态，不是脏数据。任何后续设计（包括 #178）都不得把「同词头」直接当成重复。

这条规则原先只活在未入仓脚本的注释里，很容易漏 —— 词汇表归位在 #198。

## 与平台规则的关系

#176 的 kind 枚举 v1 未包含 `missing_glyph_placeholder` 与 `outside_unicode_set`，本模块先用着，需在 #176 下补齐定义（含前端措辞）后再对齐；`row_width_differs` 目前寄居在 `merged_columns` 下，若 #176 认为它该独立成 kind，改一处常量即可。#179 负责给每条规则实测 precision/recall，**未达门槛的规则不得进入校对端界面**（#175 红线）。

## 已知边界

- `READING_FIELDS` / `MEANING_FIELDS` 与 `detect_tone_count_mismatch` 里的列名（`拼音` / `莆田IPA` / `仙游IPA` / `释义`）是硬编码的，这正是 #170（列语义标注）要消灭的东西；#170 落地后应换成按角色查询。
- 占位符与集外字符检测已改为**逐列运行**（#205），但这一改动没有依赖列角色，因此不构成 #170 的前置；#170 落地后此处无需回改，只需把 `reading_fields` 的其余用途换成角色查询。
- 判定基于「列的语义类别」而非「本批用了哪套拼音方案」，方案级校验属 #114 / #189。

## 测试

```bash
python3 -m unittest discover -s scripts -p 'test_*.py'
```

每条规则都有正反用例（必须命中的值 + 相邻的合法值），`fixtures/mini_corpus.csv` 是**人工构造的合成语料**，不含任何词典正文。该目录由 `make verify-static` 与 CI 的 `Compose invariants` 步骤执行。
