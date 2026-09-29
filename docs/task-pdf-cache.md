# 校对 PDF 分配与私有缓存

任务预览只分发条目对应页和后一页，书籍末页只分发一页。Nginx CSP 的
`connect-src` 允许 `blob:`，供 PDF.js 读取已经过身份校验下载的 PDF。

## 提交后优先复用同页原件

领取接口 `POST /api/fangji/projects/{projectId}/claim` 接受可选
`previousTaskId`。服务器核对同项目、当前轮次该用户的已提交校对记录，再从
记录推导原件和 PDF 起始页；客户端不能自行指定文件或页码来扩大权限。
优先领取同一原件记录（不可变上传版本）、同 PDF 起始页的合格条目，组内按
条号、ID 排序；耗尽后回到原队列。未绑定文件的旧条目按项目当前主 PDF 解析。

保留事务分配、每次一条、已有任务优先、租约和避免重复校对规则。其他人的
有效租约、该用户已校对的条目仍会排除。没有提前领取或预下载下一任务。

## 逐条授权，跨条目复用

`GET /api/fangji/pages/{pageId}/pdf/descriptor` 每次核对当前任务权限和有效租约，
返回 `key/start/end/total/expiresAt`。标识绑定用户、原件 ID/文件名/哈希、两页
范围和五分钟 UTC 时间窗口，不包含任务 ID，也不是可绕过鉴权的下载令牌。
PDF 接口再次鉴权，并在响应头返回实际生成的标识和有效期，以处理两次请求
之间跨时间窗口或更换原件的情况。所有响应为 `private, no-store`。

浏览器只持有当前一份 Blob；每个新条目都请求描述，标识匹配且未过期才复用。
同页切换不卸载 PDF.js，保留缩放、滚动位置和正在看的局部页。跨页、原件
替换或窗口过期会重新下载；退出账号、切换用户、离开工作区或租约失效会
撤销 Blob URL。五分钟到期在下一次任务描述校验时阻止复用，已打开的阅读器
不会因时间窗口切换打断当前校对。

## 服务端预切与预算

上传校验阶段串行预切单页。缓存位于 `pb_data/pdf-preview-cache-v1`（目录 0700、
文件 0600），不属于公开文件 API。同一用户、原件版本、两页范围在同一时间窗口
复用带水印文件；水印包含用户、原件版本摘要、页码范围和窗口生成时间，不再含
任务 ID。其他用户使用自己的水印。

**请求路径不切整本。** 缓存未命中时——尚未预切、已过期、被预算淘汰，或页目录
存在但读不出来——直接按需裁剪该任务的两页并加水印，原件不受影响。整本拆分只
发生在串行导入 worker 里。旧实现在缓存失效时会于请求线程重做整本拆分，把首屏
推到秒级；它还持有进程级互斥锁，于是其他用户的预览被一并串行化。因此预切是
纯优化：失去它只让这一次请求多解析一本的交叉引用表，成本不会随书本长度增长。

带水印文件生成后最多保留五分钟；单页缓存保留 24 小时，但**每次命中都会刷新
保留窗口**，所以仍在使用的资料不会因为一个固定计时器丢掉缓存，长期闲置的
资料照常过期。每分钟清理，服务启动后同样清理遗留文件。总预算 1 GiB，单书
展开上限 256 MiB，空间不足淘汰最旧项。展开超限的版本记忆 24 小时，避免每个
新任务重复整书预切。仅支持单进程部署。

每次预览生成一条结构化日志（事件 `pdf_preview`），含 `source_key`、`page_range`、
`cache`（`watermark-hit` / `pages-hit` / `miss-degraded` /
`pages-unreadable-degraded`）与 `lookup_ms` / `open_ms` / `extract_ms` / `merge_ms` /
`watermark_ms` / `total_ms`，用于量化各段成本而不是猜。

`lookup_ms`（探测缓存的一次 `stat`）与 `open_ms`（打开原件）刻意分开计数：把两者
合成一个数字会让读数的人无法判断这次请求到底碰没碰磁盘。

## 发布与验证

新迁移 `1789027200_pdf_task_affinity.js` 增加同页候选索引。升级前备份，正常
启动执行迁移；迁移回退仅删除索引。旧版程序不使用该索引，回滚缓存实现时可
在停止服务后删除私有缓存目录以回收空间。

```sh
go test -C backend ./...
python3 backend/tests/run_integration.py pdf_reuse_integration.mjs
npm --prefix frontend ci
npm --prefix frontend run build
# 需要可用的 Playwright Chromium；macOS 可指定 BROWSER_CHANNEL=chrome。
PDF_REUSE_BROWSER_SCRIPT="$PWD/backend/tests/pdf_reuse_browser.cjs" \
PDF_BROWSER_FIXTURE=/tmp/fangji-pdf-browser-fixture.json \
python3 backend/tests/run_integration.py pdf_reuse_integration.mjs
```

集成测试使用临时数据库，覆盖同页优先、耗尽回退、并发互斥、无效上一任务、
其他用户水印、原件替换、逐条鉴权和租约失效。浏览器回归验证连续三条只下载
一次、同一 canvas、125% 缩放/滚动/页码保留、跨页重新下载和租约失效清理。
浏览器 fixture 含临时凭据，测试运行结束即失效，不得作为生产数据提交。
