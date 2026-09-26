# 机器疑点（review_findings）契约

> 本文件是 **#176** 的交付物，也是 #161（渲染）、#162（难度信号消费）、#124（导入期预览）、
> #125（bbox 写入方）四边共同引用的唯一定义处。**一处定义，四边消费**：任何一侧要改形状，
> 先改本文件并出新 PR，不要在消费端各自解释字段。
>
> 门控档位（哪条规则能进校对端）不在本文件定义，见
> [`2026-09-25-assist-rule-thresholds.md`](./2026-09-25-assist-rule-thresholds.md) §2。
> 本文件只实现那张表要求的过滤动作。

## 1. 两张新集合

### 1.1 `review_findings`（append-only）

迁移：`backend/pb_migrations/1789113600_review_findings.js`。

| 字段 | 类型 | 必填 | 含义 |
| --- | --- | --- | --- |
| `project` | relation → `projects` | 是 | 级联删除随项目 |
| `page` | relation → `pages` | 是 | finding 的落点；行级/列级 finding 也挂在条目上——**挂哪一条由生产者声明口径，见 §8.1** |
| `field_name` | text | 否 |  CSV 列名，空 = 整条级。**用文本不用枚举**：列名由项目决定，与 #170 的「角色」不是同一层 |
| `round` | number | 否 | 产出时所在轮次，**仅供事后统计，绝不下发给校对端**（#175 红线 1 / 盲校） |
| `kind` | select（10 值，见 §2） | 是 | 疑点大类 |
| `severity` | select `info \| warn \| strong` | 是 | finding 自身属性，**不是规则档位** |
| `message_key` | text | 是 | 措辞键，前端按 key 渲染中文（§4）。**它是规则身份的组成部分** |
| `params_json` | text（JSON 字符串） | 是 | 措辞参数，只允许结构信息（码位、计数、列名），见 §6 |
| `evidence_json` | text（JSON 字符串） | 否 | `{bbox?, char_offsets?, excerpt?, page?}`，形状由 #125 定义写入方 |
| `producer` | select `rule \| ocr \| bundle_import` | 是 | 谁产的 |
| `producer_version` | text | 是 | 规则/模型版本，升版即新批次 |
| `produced_at` | date | 是 | 批次时间 |
| `superseded_at` | date | 否 | 非空 = 该批次已被取代 |

访问规则：`listRule / viewRule / createRule / updateRule / deleteRule` **全部为 `null`**。
集合 API 不给任何口子，读写一律经过 §3 的两个路由。

索引：`(page, superseded_at)`、`(project, kind)`、`(producer, producer_version, kind, message_key)`。
三条都被 `backend/tests/check_migrations.py` 的 `EXPLAIN QUERY PLAN` 断言覆盖——
即它们不是装饰，读取路径真的走得到。

### 1.2 `assist_rule_gates`（门控登记表）

门槛文件 §2.1 要求的那个可变状态，落在这里。

| 字段 | 类型 | 含义 |
| --- | --- | --- |
| `producer` / `producer_version` / `kind` / `message_key` | 四元组 | **规则身份**，唯一索引 `idx_gate_rule_identity` |
| `gate` | select `strong \| warn \| off` | 档位 |
| `sample_n` / `precision_hat` | number | 判定所用的 `n` 与 `p̂`，让档位可追溯到数字 |
| `window_started_at` / `window_ended_at` / `evaluated_at` | date | 判定窗口 |
| `note` | text | 为什么是这个档 |

**缺行 = `off`**。新规则一入库就对校对端不可见，先有数据再有档位（#177 的初始约定）。
表里出现无法识别的 `gate` 值时按 `off` 处理，不放行。

为什么键必须含 `message_key`：实测同一个 `kind`（`encoding_form_anomaly`）由两个语义无关的检测器
产出（`combining_marks_present` 3,179 条 info、`mixed_normalization_forms` 4 条 warn）。
按 `kind` 门控会把两者合并打分，得到的数字谁也不代表。

## 2. `kind` v1 枚举（10 值）

`char_out_of_repertoire`、`confusable_substitution`、`encoding_form_anomaly`、`missing_field`、
`reading_format_invalid`、`punctuation_mix`、`page_outlier`、`duplicate_identity`、
`cross_source_conflict`、`merged_columns`。

新增 `kind` 需要迁移（select 值是 schema 的一部分），因此**必须连同 §4 的措辞键一起加**，
`frontend/tests/findingMessages.test.js` 会守住「检测器新增措辞键 → 前端必须跟上」。

## 3. 两个只读路由

### 3.1 校对端 `GET /api/fangji/pages/{pageId}/findings`

鉴权：`$apis.requireAuth("users")` + 与 `GET /task` 同一套在手判定——
manager/平台管理员直通；否则要求「该条目正被你认领」或「你在这一轮已提交过（回看）」。
**不满足即 403**，所以猜到 `pageId` 也读不到别人条目的疑点。

响应已按 `gate` 与 `severity` 双重过滤，形状就是 #161 要消费的 `hints`：

```json
{
  "page": "pbc_0123456789ab",
  "hints": [
    {
      "field": "莆田IPA",
      "kind": "reading_format_invalid",
      "severity": "strong",
      "message": { "key": "long_digit_run", "params": { "runs": ["5333"], "run_count": 1 } },
      "highlight": true,
      "evidence": { "char_offsets": [[4, 8]] }
    }
  ]
}
```

过滤规则（与门槛文件 §2 一字不差）：

- `gate = off` → 该规则的 finding **一条都不出现**；
- `gate ∈ {warn, strong}` → 放行该规则的 `severity ∈ {warn, strong}`；两档**放行的集合相同**，
  差别只在 `strong` 是否 `highlight`（`gate` 是下限，不是恰好）；
- `severity = info` → **永不出现在本路由**，即便该规则 `gate = strong`；
- 响应中不含 `round`、`producer*`、批次时间等任何可反推轮次或他人行为的字段。

无数据时返回 `{"page": "...", "hints": [], "truncated": false}`。
**`truncated` 必须回**：条目上疑点数超过读取上限（与统计端共用同一个 `MAX_PAGE_SIZE`）时，
前端要能区分"这条真没问题"与"还有但被截断了"——静默少给会让校对员以为自己看完了。

### 3.2 管理端 `GET /api/fangji/projects/{projectId}/findings`

鉴权：`requireManager`。查询参数 `page`、`per`（上限 200）、`kind`、`producer`。
**不做门控过滤**：`off` 档与 `info` 级照样可见，并附上 `gate` / `gate_sample_n` / `gate_precision_hat`。
门槛文件要求「未达标规则仍计算、仍写库、只在管理端统计」，这个读取口是那句话成立的前提——
如果这里也过滤，`off` 就等价于「不运行」，档位再也无法被数据推翻。

```json
{
  "items": [{ "id": "rec...", "field": "仙游IPA", "kind": "encoding_form_anomaly",
              "severity": "info", "message": {"key": "combining_marks_present",
              "params": {"marks": ["0x303"]}},
              "producer": "rule", "producer_version": "v1", "gate": "off",
              "gate_sample_n": 0, "gate_precision_hat": null, "page": "rec...",
              "project": "rec...", "produced_at": "2026-09-25 00:00:00.000Z",
              "evidence": {} }],
  "hasMore": false, "page": 1, "per": 50
}
```

## 4. 措辞：`message_key` + `params_json`

后端**不存自由文本**。中文措辞集中在 `frontend/src/lib/findingMessages.js`，
key 与 `scripts/corpus_probe/detectors.py` 的 `finding(...)` 第四个实参一一对应（当前 11 个）。

- 未知 key 渲染成 `未登记的疑点类型：<key>`，**不抛错**——措辞缺失不能让校对界面白屏；
- `params` 缺失或形状错误也不抛错，退化成可读文本；
- 码位一律渲染成 `U+0303` 形式；传入非码位字符串得到「未知码位」，绝不回显字形。

## 5. 批次语义（不覆写）

重算 = **写新批次 + 把旧批次标 `superseded_at`**，不 UPDATE 内容字段、不物理删除（#91）。
判定「当前批次」的方式就是 `superseded_at = ""`：写入方负责在写完新批次后标旧批次。

强制手段：`backend/pb_hooks/findings.pb.js` 的 `onRecordUpdateRequest` 守卫逐字段比对回读的库内行，
除 `superseded_at`（以及 `created`/`updated` 系统字段）外的任何改动一律 **403**，
superuser 走 API 也一样被拒。`findings_integration.mjs` 对 9 个字段逐一验证了这一点，
并特意用「另一页」做 `page` 的篡改目标——同页改写是空操作，断言会恒真。

**已知边界**：守卫挂在 API 更新请求上。服务端特权代码（`$app.save` / Go DAO）不经过它，
因此 #177/#178/#180 的写入方必须自己只走「插入新批次」这一条路。

级联删除（删 `pages`/`projects` 记录）会带走其 finding。
这不是「覆写」，但确实是一次**物理删除**，与 #91「原始证据不可覆写」的精神冲突到什么程度，
是一个需要维护者拍板的口径问题（不属于本契约能自行决定的范围）：

- 现在的选择：`cascadeDelete: true`，与 `proofreading_attempts` 的既有做法同构，
  代价是删条目会连带删掉它的疑点；
- 备选：改成 `false`，则删条目/删项目在有疑点残留时会被外键挡住——更强的 append-only 保证，
  但会让平台管理员的删除操作变成"必须先处理疑点"。
  注意 main 上目前没有任何指向 `pages` 的 relation 用 cascade true，所以这不是既成惯例。
  切换的代价在测试侧（各套件的 teardown 要先删疑点再删项目）。

**待维护者定夺；本文件不假装这条已经想清楚。**

## 6. 内容边界（隐私红线）

`params_json` 与 `evidence_json` 里只允许**结构信息**：码位、计数、列名、偏移、bbox。
判据同 `scripts/corpus_probe/README.md`——**码位是结构信息，字形序列是内容**。
`evidence_json.excerpt` 是唯一的例外字段（为 #125 的 bbox 对齐预留），
写入方必须遵守「只截与该字段本身有关的最小片段」，且该字段只在条目在手者请求时返回。

响应绝不含他人提交内容：`row_json` / `text` / `first_*` / `second_*` / `proofread_*`
都不在本契约的两个响应形状里，`findings_integration.mjs` 用一份 `concealedKeys` 清单
对响应 JSON 做了字符串级排除断言。

## 7. 实现约束（给 #177 的提醒，都是这一轮踩过的坑）

- PocketBase 的 JSVM 把**所有** `.pb.js` 拼进同一个作用域：两个文件各自 `const FANGJI_API`
  会直接 panic（`Identifier 'FANGJI_API' has already been declared`）。共享常量请放
  `lib/*.js` 并在 handler 内 `require`。
- **同一个原因**：`.pb.js` 顶层的 `const` 在 handler 实际执行时读不到（ReferenceError）。
  只在求值期使用的顶层常量没问题，回调里用的必须从 lib 取。
- `onRecordUpdate`（模型级）里 `$app.findRecordById` 回读会在同一次保存的事务中失败，
  表现为 400 `Failed to update record`；请求级钩子 `onRecordUpdateRequest` 回读可用
  （`main.pb.js` 的 users/pages 守卫就是这个写法）。
- 集合 API 的 `POST records` 在本版本返回 **200** 不是 201；只有 `/api/fangji/*` 自定义路由
  自己决定状态码。
- `c.json()` 走 goja→Go 的转换时，对象里的 `undefined` 会变成 `null` 落到响应里。
  不想下发某个字段就别写进对象，别写 `field: undefined`。
- 日期字段比较统一用 `record.getString(name)`，别用 `String(record.get(name))`——
  后者表示不稳定，会把合法的 `superseded_at` 改动误判成覆写。

## 8. `FindingProducer` 边界

目的：让形态更换（云 API / sidecar / 浏览器内推理 / 规则）不改本文件 §1 的字段。
完整的决策理由见 [`2026-09-25-model-assist-inference.md`](./2026-09-25-model-assist-inference.md) §3
（#181）；**签名以本节为准，两处要一起改**。

```
FindingProducer = interface {
  Produce(ctx ProducerContext) -> []FindingDraft
  Identity() -> {producer: "rule"|"ocr"|"bundle_import"|"model", version: string}
  Capabilities() -> {needsEgress: bool, readsOtherPeopleSubmissions: false, writesBack: false}
}

FindingDraft = {
  page_id, field_name?, kind, severity ∈ {info|warn|strong},
  message_key, params_json, evidence_json, produced_at
  // evidence_json.anchor：本条挂在 page_id 上的口径（生产者自己决定，见 §8.1）
}

// 作用域：两个已实现的生产者都是整项目作用域（#208 项目级规则已进 main，#178 跨行检出在 #212 上）。
// 允许读同项目其他条目的源文本与行内容；不允许读他人的 attempt / 提交结果 / 轮次线索；
// 读到的其他条目内容不得再出现在本条 finding 的 params / evidence 里。详见
// model-assist-inference.md §3 的 ProducerContext 注释。
ProducerContext = {page, project, column_roles, enabled_keyboards}
```

三条约束由**接口形状**保证，不靠文档措辞；另有两条是对 `FindingDraft` 字段内容与挂靠口径的要求
（见 §8.1，不会因为签名存在而自动成立），合计五条，与 `model-assist-inference.md` §3 同一口径：

1. `readsOtherPeopleSubmissions` 的类型是 `false` 字面量——上下文里根本没有他人提交字段，
   「永不含他人结果」因此是不可表示，而不是"请注意"（#175 红线 1）。
2. `needsEgress` 未声明按 `true` 处理（保守），供出站闸门判断。
3. 生产者只返回 `FindingDraft`，接口上没有写回任何值的方法。

### 8.1 两条由 #208 评审逼出来的硬约束

1. `params_json` / `evidence_json` 不得含原样内容片段——两列都会随 hint 下发给该条目的
   在手校对员（`hintView`）。#175 红线 1 在数据形状上的落点就是这里。
   这条按**绝对**解释，不区分"本条目自己的原文"与"别人条目的原文"：生产者永远不需要携带任何
   原样内容就能让校对员定位问题（这一行他本来就看得到），而一旦开了"本条目的可以带"这个口子，
   "算不算本条目"就退化成每个生产者的自由判断。链上曾有一处反例——#178 的 identity params 带过
   `identity_headword` / `identity_reading` 两个无人消费的原文键，已按这条收掉——删键在 **#212**
   的 `5e976c6`（同一支里 `b6ec758` 补的是约束 2 的 anchor，两件事别混），该支尚未合并。
2. 生产者必须自己决定每一条 finding（行级也一样）挂在哪个条目上，并把口径写进 `evidence.anchor`。
   `page` 必填（§1 字段表与迁移里的 `relation("page", …)`，`required: true`）而"整列/整页"级判据客观存在，
   这个缺口早晚要被填；写在生产者侧、读取侧只认 `page`，就不会出现"解析不出来就退化成
   第一条"那种把别人的内容发给当前校对员的形状。规则生产者的具体口径见
   [`2026-09-25-assist-rules.md`](./2026-09-25-assist-rules.md) §3.6 —— 那一节已随 **#208** 进 main。

**对本文件数据结构的唯一影响点**：`producer` 枚举要新增 `"model"`。
那是一次 select 值变更（需要迁移），本文件此刻**不改**——它属于 L2 真正开工时的那次改动，
在这里预先占位会让 #176 为一个不存在的能力放宽枚举。除此之外的字段一个都不用动。

## 9. 消费方指引

| 消费方 | 拿什么 | 不该拿什么 |
| --- | --- | --- |
| #161 渲染 | §3.1 的 `hints`，按 `highlight` 分高亮/次要标记 | 不读 `round`；不显示 confidence 百分比 |
| #162 难度 | §3.2 或 #180 的派生字段 | 不把 tier 当轮次线索显示 |
| #124 导入期预览 | §3.2（producer = `bundle_import`） | 不在导入作业未完成时读批次 |
| #125 bbox 写入方 | 写 `evidence_json`，形状自定但需登记 | 不写自由文本措辞 |
