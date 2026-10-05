# Review Bundle v0

人工可控的批次交换契约。乡声集盒导出 `ReviewBundle/v0`，人工检查后由万语校坊校验；校对结束后万语校坊导出 `ReviewResultBundle/v0`，再经人工检查回到乡声集盒。

本文件只定义语义和校验。导入执行是后续工作，本校验器不写库。不建设 realtime API、webhook、message queue、distributed transaction 或 shared database。校验通过也不等于自动回流，也不把 Candidate 升级为 Gold。

## 1. 承载

一个目录，或一个 zip。根上有 `manifest.json`，清单里的 JSONL 可以放在子目录。目录和 zip 按同一套相对路径读取。zip 如果只有一个顶层目录，校验器会先去掉这一层。清单没有列出的文件会被忽略，也不会被导入。

JSONL 使用 LF。`lines` 按物理行计数：末尾换行不另算空行。`bytes` 是文件字节数。`sha256` 是这些字节的 SHA-256，小写十六进制；大写也可通过比对。

样例（合成数据，不是语料）：

- `backend/reviewbundle/testdata/review-bundle-v0/inbound/`
- `backend/reviewbundle/testdata/review-bundle-v0/result/`

## 2. 进入包 `ReviewBundle/v0`

| 字段 | 必填 | 含义 |
| --- | --- | --- |
| `bundle.bundle_id` | 是 | 这一批的稳定编号。不是 `pages.id` |
| `bundle.schema_version` | 是 | 必须是 `ReviewBundle/v0` |
| `bundle.created_at` | 是 | RFC3339 |
| `source_system` | 是 | 来源系统。乡声集盒用 `xiangsheng-jihe` |
| `source_id` | 是 | 来源系统里的对象或数据集编号 |
| `source_version` | 是 | 该对象的版本 |
| `requested_fields` | 是 | 希望校对的字段名。可为空数组 |
| `rights_ref` | 是 | 来源登记的 `sources.logical_id` |
| `operator` | 是 | 导出这批的人 |
| `files[]` | 是 | `path`、`sha256`、`lines`、`bytes` |
| `payload` 行 | 是 | JSONL 里每行一条，见下 |

每行：

```json
{"entry_id":"entry-001","fields":{"headword":"样例甲","reading":"sia3-li6"}}
```

`entry_id` 是来源系统自己的编号。它和万语校坊的 `pages.id` 不是同一个空间，不能因为字符串碰巧相同就当成同一条。`fields` 里必须包含每一个 `requested_fields`。

进入包不能带 `result_of`。

## 3. 结果包 `ReviewResultBundle/v0`

在进入包的公共字段之外，必须有 `result_of.bundle_id`，指回被校对的那一批。`source_system` 在万语校坊导出时为 `wanyu-proofreader`。`requested_fields` 可以原样带回，也可以不带。

每行：

```json
{"entry_id":"entry-001","reviewed_fields":[{"field":"reading","value":"sia3-li6","decision":"confirmed","provenance":"proofread_round:1"}]}
```

| 字段 | 含义 |
| --- | --- |
| `entry_id` | 与进入包同一套来源编号，仍然不是 `pages.id` |
| `field` | 被审的字段名 |
| `value` | 最终值。JSON 类型不限，但键必须在 |
| `decision` | 非空字符串。建议用 `confirmed`、`corrected`、`rejected`。签字前不收成枚举 |
| `provenance` | 这个值从哪一次决定来。不是 `pages.id` |

`provenance` 建议写成 `proofread_round:<轮次>`、`arbitration:<决定编号>` 或 `field_decision:<决定编号>`。校验器只要求它非空、不换行、不超过 200 个字符。

## 4. 和来源登记、出处的关系

- `rights_ref` 指向来源登记（#169）的 `sources.logical_id`。格式是字母或数字开头，后面可含字母、数字、`.`、`_`、`:`、`-`，最长 80。校验器只检查这个字符串，不查询 `sources`，因此来源登记是否已经合并都不影响校验，未知用途也不会在这里被改判。
- `provenance` 指向校对轮次、仲裁或字段级决定。议题里的 A4、C3 若分别指来源登记和结果出处，对齐点就是这两个字段。请双方在下方签字表确认，这里不代签。

## 5. 版本策略

`schema_version` 不是 `ReviewBundle/v0` 或 `ReviewResultBundle/v0` 时，整包拒绝，报告里只有这一条错误，不继续验收条目。不允许部分导入。多出来的 JSON 键在这两个版本里忽略；要改必填字段，升版本。

## 6. 校验器

只验不写。两条入口做同一件事，都接受清单里的子目录路径：

- 离线：`go test ./reviewbundle`，覆盖仓库里的样例目录。
- 在线：`POST /api/fangji/bundles/validate`，`multipart` 字段名 `bundle`，内容是 zip。登录用户可用。响应是校验报告；报告里 `ok: false` 时 HTTP 仍是 200。上传本身不是 zip 时返回 400。两种结果都不写数据库。

`ok: false` 时调用方不得导入。重复校验同一包不新增、不修改任何记录。

失败时 `errors[].code` 与中文 `message` 一起返回，消息里写明「已拒绝整包，未写入任何数据」。验收的五类是：

| code | 何时 |
| --- | --- |
| `manifest_missing` | 没有 `manifest.json` |
| `checksum_mismatch` | SHA-256 不符 |
| `line_count_mismatch` | 行数不符 |
| `schema_version_unsupported` | 版本不认识 |
| `duplicate_entry_id` | 同一个 `entry_id` 出现多次 |

字节数不符时 code 为 `byte_count_mismatch`，同样整包拒绝。

## 7. 导入语义

以下规则由 #183 落地，实现见 `backend/bundle_import.go`。契约本身只描述形状，这一节是「W 收到包之后怎么做」的口径——#93 / #94 收敛版本并存、以及 #96 的结果包回流都要**引用这里**，不要各自再定一份。

### 7.1 列集合与顺序

导入后的条目列**就是 `requested_fields`**，顺序也按它。条目里多给的键不落库，但会记进作业的 `error_message`（「已忽略 N 个未请求字段：…」），不静默丢弃。

理由：§2 只要求 `fields` **包含** `requested_fields`（下界），所以多给不算违约；但 `pb_hooks/lib/column_roles.js` 的 `headersForProject` 会把项目内各页的表头按页序 union 成项目级列清单——多给的一个键会变成整个项目的一列并随任务下发给校对员，而条目之间键序不一致会让那份清单的交错顺序取决于哪一页先到。

### 7.2 幂等

- 同一 `(project, bundle_id)` 且**未失败**的作业：重放直接返回原作业，不新建、不重导。
- `failed` **不在**短路范围内。`bundle_id` 是来源侧身份、上游不能随意改，把 failed 也算进幂等等于让一个瞬时失败的批次永久无法经由 API 重试。
- 作业级由部分唯一索引 `idx_import_jobs_bundle (project, bundle_id) WHERE status != 'failed' AND bundle_id != ''` 兜底，条目级由 `idx_pages_source_entry (project, source_system, source_id, source_version, source_entry_id)` 兜底。`bundle_id != ''` 那半边与 pages 的来源键同理由：空串表示「这一行没有这个键」，CSV / OCR 作业的 `bundle_id` 都是空串，不排除它们就会在 `(project, '')` 上互相撞唯一约束。并发下两边都是同一套写法：先查后写，唯一索引挡住后来者，再重查一次区分「重复」与「真失败」。

### 7.3 版本变化与已有校对记录

自然键包含 `source_version`，所以同一 `entry_id` 的新版本是**新条目**，旧条目原样留在库里：

- 旧条目的正文（`ocr_row_json`）与它的 `proofreading_attempts` 都不得被导入改写或删除——导入只插入、不更新；
- 同一条旧条目会因此与它的新版本同时出现在领取队列里，状态各自独立。「同一词头的新旧两条要不要一起领取」是 #93 / #94 的口径，不在 #183 里定。

### 7.4 来源关联

`rights_ref` 必须能在 `sources` 里按 `logical_id` 找到：找到则写入作业的 `source` 并标 `linked`；找不到则**拒绝这一次导入**，不静默标成 `unknown`。与 `docs/plans/2026-09-29-source-registry.md` 记的 CSV 侧口径一致。

### 7.5 部分失败

§6 的校验是整包拒绝。通过校验之后，契约允许、但本系统的条目模型容纳不了的行（去掉页码后全空、字段值不是文本）按行报进 `import_job_errors`，合法行继续，终态 `completed_with_errors`；全体失败则终态 `failed`。

## 8. 语义对齐签字

代理不能代签。请 @aB0T-bupt 与 @L8848-Li 在评审里确认下表。未确认前，导入执行不应开始。

| 字段 | 万语校坊理解 | 乡声集盒 | 万语校坊 |
| --- | --- | --- | --- |
| `bundle.bundle_id` | 批次编号，不是 `pages.id` | 待 @aB0T-bupt 确认 | 待 @L8848-Li 确认 |
| `bundle.schema_version` | 只接受本文两个版本，否则整包拒绝 | 待确认 | 待确认 |
| `source_system` / `source_id` / `source_version` | 来源系统、对象、版本 | 待确认 | 待确认 |
| `requested_fields` | 请求校对的字段名 | 待确认 | 待确认 |
| `entry_id` | 来源系统编号，不与 `pages.id` 合并 | 待确认 | 待确认 |
| `rights_ref` | `sources.logical_id` | 待确认 | 待确认 |
| `manifest.files` | 路径、SHA-256、行数、字节数 | 待确认 | 待确认 |
| `operator` | 导出或交包的人 | 待确认 | 待确认 |
| `result_of.bundle_id` | 结果包指回进入包 | 待确认 | 待确认 |
| `reviewed_fields.value` / `decision` / `provenance` | 最终值、决定、出处；出处不是 `pages.id` | 待确认 | 待确认 |
