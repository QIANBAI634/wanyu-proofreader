# 辅助规则基线报告（2026-09-25）

样本来自 assist_traps.json：条目 4、提交 4、字段级样本 16。 键盘口径 = hinghwa-dialect.json；列角色 = 已提供。

## 合成样本指标（验证打分工具自身正确，不代表线上表现）
| 规则 | 命中 n | TP | FP | FN | precision | recall | Wilson 95% | 建议 gate | 依据 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| R1 char_out_of_repertoire | 0 | 0 | 0 | 2 | n/a | 0 | n/a | off | n/a；无命中样本，证据不足以下结论 |
| R2 confusable_substitution | 3 | 1 | 2 | 0 | 0.3333 | 1 | [0.0615, 0.7923] | off | n/a；样本量 3 低于任何档的 n_min，不评精度 |
| R3 combining_marks | 1 | 0 | 1 | 1 | 0 | 0 | [0, 0.7935] | off | n/a；样本量 1 低于任何档的 n_min，不评精度 |
| R6 long_digit_run | 0 | 0 | 0 | 1 | n/a | 0 | n/a | off | n/a；无命中样本，证据不足以下结论 |
| R6 tone_token_count_differs | 0 | 0 | 0 | 1 | n/a | 0 | n/a | off | n/a；无命中样本，证据不足以下结论 |
| R5 missing_field | 1 | 1 | 0 | 1 | 1 | 0.5 | [0.2065, 1] | off | n/a；样本量 1 低于 strong 档要求的 100 |

> 本表只列弱标注粒度 `(提交, 字段)` 能度量的判据；R3 列级 `mixed_normalization_forms`、R4 `punctuation_mix`、R7 的两个判据不参与打分，**它们的档位决策不在本报告的证据范围内**（理由见 `scripts/assist/README.md` §4）。

## 真实样本指标
n/a —— 部署库内尚无真实分歧/仲裁样本。

## 假分歧隔离
被排除的 unicode_equivalent 负例：**1** 条（主分析不含它们；这个数字本身量化 #174 的代价）。

## 能否外推
不能。合成样本按已知陷阱构造，命中分布由构造方式决定；真实分布要等 #93 试点的数据。两栏数字不得合并、不得平均、不得对外用作准确率承诺（#97）。
