# 贡献指南

感谢你参与万语校坊。本文件补充本仓库特有的开发和评审要求；组织级规则以 [E-Dialect 贡献指南](https://github.com/e-dialect/.github/blob/main/CONTRIBUTING.md) 为准。

本项目原名“方辑（Fangji v2）”；品牌整合前最后一个旧版源码快照为 [`fangji-v1.0.0`](https://github.com/e-dialect/wanyu-proofreader/releases/tag/fangji-v1.0.0)。历史 commit、设计记录、migration、package、API 路径或兼容字段中可能仍保留旧名，不应仅为品牌 rename 做破坏性重命名；活跃界面和用户可见文案应使用“万语校坊”。

提交贡献前，请同时阅读：

- [e-dialect 社区行为准则](https://github.com/e-dialect/.github/blob/main/CODE_OF_CONDUCT.md)
- [个人贡献者许可协议（ICLA）](https://github.com/e-dialect/.github/blob/main/ICLA.md)
- [企业贡献者许可协议（CCLA）](https://github.com/e-dialect/.github/blob/main/CCLA.md)

## 开始之前

1. 搜索已有 issue 和 pull request，避免重复工作。
2. 在目标 issue 留言说明计划，并将其分配给自己；无法自行分配时请等待维护者确认。
3. 较大的改动先讨论范围、数据迁移和兼容策略，再开始实现。
4. 不要在 issue、日志、测试数据或提交中包含真实账号、token、生产数据等敏感信息。

## 分支与提交

- 从最新 `main` 创建分支；一个分支只处理一个可独立合并的问题。
- 推荐分支名：`feat/<summary>`、`fix/<summary>`、`docs/<summary>`、`ci/<summary>`、`chore/<summary>`。
- 提交信息与 PR 标题使用 Conventional Commits，例如 `fix(auth): preserve session on transient errors`、`ci: add frontend checks`。
- `scope` 必须是有归属的领域或模块，从现有词表里选：`auth`、`identity`、`projects`、`proofreading`、`onboarding`、`keyboards`、`pdf`、`upload`、`import`、`profiles`、`rare-chars`、`pagination`、`probe`（`scripts/corpus_probe/**`，离线语料探测与疑点规则）、`findings`（`review_findings` 数据模型、门控与只读接口）、`assist`（辅助层：`scripts/assist/**` 的弱标注与打分、`backend/pb_hooks/lib/assist_*.js` 的规则/难度/跨行判定）、`quality`、`migrations`、`ops`、`deps`、`ci`、`governance`（`.github/**` 与仓库治理文档、审批与权限边界）。词表里没有合适项时，在 PR 描述中说明新 scope 对应哪个目录或领域，再补进本表。
- 不要用阶段、版本或计划代号作 scope（`v2`、`v3`、`phase1`、`M1` 等），也不要用整层名字（`frontend`、`backend`、`core`）：它们不携带责任域信息，changelog 无法据此归类。一支 PR 确实跨两个领域时，scope 写主要的那个，另一个写在 PR 描述里，不要用「A 与 B」拼标题回避 scope 选择。
- PR 标题与提交信息的首行都不带 issue 编号（`(#131)`、`(#131) (#132)`、`fix #132` 等）。issue 关联只写在 PR 正文的「关联 Issue」里：完成用 `Closes #123` / `Fixes #123`，只覆盖一部分用 `Related to #123` 并说明遗留范围。Squash and merge 会把 PR 正文带进提交说明，关联不会因为标题里没有编号而丢失；标题里出现编号几乎总是一个来源错误：把合并后自动生成的提交信息回填成了 PR 标题。
- 不提交构建产物、`.env`、PocketBase 数据目录或无关格式化改动。
- 不改 `CHANGELOG.md`：该文件暂停更新，Release 时统一重新组织，见「CHANGELOG 暂停更新」。
- PR 已进入评审后不要随意重写历史；确需 rebase 或改写提交时，先在 PR 中说明并获得维护者确认，禁止强制覆盖共享分支。

## 本地开发与检查

推送前先跑一条命令：

```bash
make check
```

它依次执行 gofmt/`go vet`、前端 ESLint、运行时版本与文档一致性、集成套件清单校验、
Compose 不变量、`git diff --check`、行尾一致性、Go 与前端单测以及迁移 up/down/up 校验。

守卫脚本依赖 PyYAML，首次使用前装一次：

```bash
python3 -m pip install -r requirements-dev.txt
```

缺少它时 `make check` 会直接给出上面这条命令，而不是抛 `ModuleNotFoundError`。
本机没有 Docker 时，`verify-compose` 会显式打印 `SKIP` 并改跑纯 Python 结构检查，
真正的 `docker compose config` 断言仍由 CI 执行。

其余入口：

| 命令 | 用途 |
| --- | --- |
| `make test-go` | Go 单测；`RACE=1 make test-go` 启用竞态检测 |
| `make test-node` | 前端 `node:test` 单测 |
| `make test-integration` | 全部后端集成套件，共享一次编译 |
| `make test-integration SUITES=pdf_` | 只跑名字包含 `pdf_` 的套件 |
| `make coverage` | Go 与前端覆盖率报告 |
| `make seed` | 向运行中的实例灌入可复核的演示项目 |
| `make ci` | `check` + 集成套件 + 前端构建 + 镜像构建 |

单个套件也可以照旧直接调用；它会构建后端、在新临时目录按数字顺序逐条执行迁移、
启动测试服务，并在成功或失败后停止服务、删除数据：

```bash
python3 backend/tests/run_integration.py upload_jobs_integration.mjs
python3 backend/tests/run_integration.py task_leases_integration.mjs --race
```

套件清单以 `backend/tests/suites.json` 为唯一来源，CI 矩阵由它生成。
新增 `backend/tests/*_integration.mjs` 却忘记登记时，`check_test_inventory.py` 会让构建失败，
避免文档、CI 与磁盘上的套件再次各说各话。

涉及导入、权限、盲校、仲裁或迁移时，应运行相应集成测试，并使用临时数据目录，不能覆盖真实 `pb_data`。

每个命令失败时会输出测试名称和后端日志尾部；测试身份均为临时身份。Go 缓存按 `backend/go.sum`、
npm 缓存按锁文件管理；数据库不缓存。
贡献者应运行本文列出的适用本地检查；PR 中所有适用的 required checks 都必须通过后才能合并。当前 required checks 与 review requirement 以 GitHub branch protection / ruleset 显示为最终真源，不在 CONTRIBUTING 中维护固定数量。

提交前执行 `git diff --check`（暂存后使用 `git diff --cached --check`）。
`.gitattributes` 对 `frontend/public/fonts/rare-han/OFL.txt`、
`frontend/public/pdfjs/cmaps/LICENSE` 和
`frontend/public/pdfjs/standard_fonts/LICENSE_LIBERATION` 关闭空白检查，以保留上游许可证的原始字节。
来源与许可说明仍保留在各资源目录的 README 和许可证中；不要格式化这些文件，也不要扩大到整个第三方目录。
自有源代码和其他文件继续使用 Git 的正常空白检查。

### 行尾与检出

`.gitattributes` 把所有文本文件固定为「仓库内存 LF、检出也是 LF」，Git 属性的优先级高于
`core.autocrlf`，因此不需要按机器配置行尾。这消除了一类只在 Windows 出现的故障：`gofmt -l`
会把 CRLF 检出的每个 Go 文件都判为未格式化，读源码做正则断言的前端单测也会因为锚定 `\n`
的表达式匹配不到 `\r\n` 而在文件加载期崩溃，汇总里只留下一个 `fail 1`。
新增二进制资源时补一条 `binary` 规则，别依赖 `text=auto` 的启发式判定。

规则落地前已经检出的工作树不会被自动重写——Git 只看 stat 信息，磁盘上的行尾会原样留着。
确认没有未提交改动后重新检出一次即可：

```bash
git rm --cached -r .
git reset --hard
```

行尾门禁的实现是 `scripts/check_line_endings.py`：读取 `git ls-files --eol` 的索引列，只要文本
blob 里存了 CR（`i/crlf`、`i/mixed`）就失败。`make verify-static` 与 CI 的 Static analysis 作业
调的是同一个脚本，所以这条门禁本地和 CI 的覆盖面一致，两边都不需要额外记一次。

它兜的是属性管不到的那一侧：在归一化规则落地前就进过索引的内容，以及绕过 clean 过滤器的提交
（`git am`、`git apply --cached`）。索引列按 blob 的字节判定，标成 `-text` 或 `binary` 并不豁免：
不含 NUL 却带 CRLF 的文件仍会被报出来，这类文件按内容就是文本。`git diff --check` 只看空白，
不会报告这类行尾；索引列也不受本机 `core.autocrlf` 与尚未刷新的工作树影响，所以 Windows 贡献者
在按上面步骤重新检出之前也不会被这条门禁误伤。

### CHANGELOG 暂停更新

`CHANGELOG.md` 自 2026-09-23 起**暂停更新**：条目全部堆在 `## Unreleased` 里，既没有版本边界，
又让并行 PR 反复撞在同一行上——#155 六小时内带了三次 merge，每次只为一行文本。等到定下首个
Release 版本时，另开一支 PR 重新设计这个文件的组织形式（版本边界、分组与回填）。在那之前：

- 贡献者和合并者都不改这个文件，PR 也不必附 changelog 文案。改动记录以合并进 `main` 的提交信息
  为准：squash 合并会把 PR 正文带进去，需要回溯时从那里读，比一份手工维护的列表更难走样。
  文件顶部那段冻结声明是本规则的一次性例外，也就是它最后一次被这样改动。
- 这条不靠 CI 拦。`.github/CODEOWNERS` 已把 `/CHANGELOG.md` 挂在维护者名下，而 main 开启了
  code-owner 审批要求，所以改这个文件的 PR 必须有一位维护者批准；作者一方的检查不会因为
  碰了它就变红。
- 将来重做组织形式的那支 PR 本身要改这个文件，因此需要**作者之外的另一位** code owner 批准
  （GitHub 不允许自批）。两名维护者时按交替出手处理。

## PocketBase 与数据迁移

- 不要修改已发布或可能已经执行的迁移；通过新的迁移文件演进 schema 和数据。
- migration、hook、前端字段读取和 API 权限必须在同一个 PR 中保持兼容。
- PR 描述需说明迁移前置条件、数据影响、回滚方式和验证结果。
- 测试文件上传或导入流程时使用最小化、可公开的 fixture，不提交真实语料。

## Pull Request 要求

PR 应当：

- 关联 issue，并清楚说明解决了什么、没有解决什么。
- 保持范围单一；后续工作应新建或关联 issue，而不是不断扩大当前 PR。
- 列出实际执行的验证命令和结果；未运行的检查要说明原因。
- 标明破坏性变更、数据迁移、部署配置或安全影响。
- UI/交互变化提供截图或短视频，并覆盖错误、空状态等关键路径。
- 响应 review；阻断意见未解决前不要请求合并。

## 当前合并政策

main 已启用严格状态检查、解决讨论以及禁止强推/删除，管理员同样受限制；仓库级的全局批准数为 0。R0/R1 变更依靠 required checks、自动审查和作者提交的人工验证证据，R2 变更在组织治理文件落地后由路径级 CODEOWNER / 人工门禁控制。维护者还需执行以下合并门禁：

1. PR 必须基于当前目标分支，所有可用 checks 通过。
2. `REQUEST_CHANGES` 和未解决的阻断讨论必须先处理。
3. 合并前确认测试、迁移和回滚说明足够，且没有意外的无关改动。
4. 默认由维护者使用 **Squash and merge**，保持 `main` 每个 PR 一个清晰提交。
5. 紧急绕过必须在 PR 中记录原因，并创建后续修复 issue。

贡献者不要自行启用 auto-merge，也不要直接推送到 `main`。
