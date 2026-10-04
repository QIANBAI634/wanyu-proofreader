# 校对页图预览（#160）

任务预览优先使用后台生成的 WebP。当前页加载完成后预取相邻页；仅在任务授权的
`start…end` 内请求（现有校对权限为任务页及其下一页，末页只有一页）。图片缺失、
链接过期、资源下载失败或浏览器解码失败时回退原有 PDF.js 预览。

## 生成与缓存

PDF 导入仍先完成验证和逐页 PDF 缓存。文件标为 `ready` 后，非阻塞地排入独立页图队列；
单独的 worker 以并发 1 生成页图，不占用 CSV/PDF/OCR 导入队列，不阻止领取任务或后续导入。
旧文件或过期缓存由首次图片查询非阻塞排队预热；HTTP 请求只查询缓存，不拆书、不渲染整书。
独立队列容量 16，等待与执行中的任务共同去重；队列满时放弃本次预热，下次访问可再排队。
`work_started` 的 `kind=pdf-images` 与 `queue_wait_ms` 记录图片队列等待，
`work_finished.duration_ms` 记录处理耗时。

每页先用 pdfcpu 烧入 `Wanyu | 来源摘要 pN` 公共水印，再用 Poppler `pdftoppm`
按 CropBox 与 PDF 原生旋转渲染，最长边 2048px，最后 `cwebp -q 90` 编码。
用户身份水印由前端覆盖层显示。缩放、旋转和全屏在图片模式中仍可使用。

**水印取舍需要维护者评审确认：** 图片字节仅烧入共享的公共来源水印，用户身份层可被客户端移除，
下载后的图片不能凭字节识别查看者。采用共享页图以减少重复渲染和缓存开销，服务端记录授权访问审计
作为追踪补充。原 PDF 降级仍逐用户烧入身份水印；两条预览路径的追踪能力不同。

页图目录为私有 `pdf-preview-cache-v1/images-{source/version hash}/`：

- `N.webp`、`N.json`（像素宽高）、`ready`；
- 原始文件 ID、存储文件名（`file` 字段）、内容 hash 或渲染版本变化都会使资产 ID 变化；
  上传显示名 `original_filename` 不参与缓存键，仅修改显示名不会重建页图；
- 在数据目录内的临时目录逐页生成，全部成功后原子发布，失败不发布半成品；
  服务启动时、两个 worker 开始前清理遗留的 `pdf-images-{数字}` 临时目录，
  定期清理不触碰正在生成的目录；
- Poppler 和 cwebp 各自使用独立的 30 秒超时，整本生成最多 10 分钟，停服务时取消渲染；
  每本页图不超过 256 MiB，沿用总缓存 1 GiB、闲置 24 小时清理；
- 使用时刷新闲置窗口，生成过程不持有全局预览锁；发布和清理才短暂持锁；
- 渲染失败不更改 PDF 的 ready 状态，记录日志并退避 24 小时；修复工具后可在停服务时
  删除对应 `oversized-images-*` 失败标记以提前重试。

缓存可随时删除，原始 PDF 与校对数据不受影响。页图是原资料派生资产，适用输入资料的
来源、授权和保留规则，不因生成而获得仓库软件许可证；见 `ASSET_BOUNDARIES.md`。

## API 与坐标

`GET /api/fangji/pages/{pageId}/images/{number}/descriptor` 返回：

```json
{
  "assetId": "稳定的来源/渲染版本/页码摘要",
  "width": 2048,
  "height": 1536,
  "url": "/api/fangji/pages/…/images/2/asset?key=…&expires=…",
  "expiresAt": "2026-10-03T09:10:00Z"
}
```

宽高是已应用原生旋转和 CropBox 的页图坐标基准。框坐标可保存为像素或除以宽高的
归一化坐标；前端显示时按相同尺寸比例缩放。浏览器回归在桌面截图上叠加
`(10%,15%,35%,8%)` 的示例框，说明坐标与底图共享基准；不向实际校对界面添加假 OCR 框。

descriptor 和 asset 都要求 Authorization，且每次重新检查任务归属、项目权限和有效租约。
asset 的窗口 key 绑定用户、来源版本、页码和五分钟到期窗口；**它不是身份凭据**，
只有 URL 无法访问。返回 `private, no-store`，不接受窗口以外的页码或过期链接。

成功下载 asset 时记录 `pdf_preview` 审计：`user_id`、`asset_id`、来源摘要 `source_key`、
`page_range`、`cache=image-hit`、`total_ms`；日志不记录凭据、窗口 key 或图片内容。

前端拿短期 URL 用带鉴权的 fetch 下载，然后只把 Blob URL 交给 `<img>`。
缓存复用前仍请求 descriptor 检查权限；过期重新授权，任务范围/来源变化、退出登录、
身份变化、租约失效或组件卸载都会释放 Blob。相邻页预取与导航共用在途资源，避免重复下载。

## 部署

运行镜像增加 Alpine 的 `poppler-utils` 和 `libwebp-tools`。进程继续以 UID 10001 运行，
不需要网络权限、特权容器、Python 或额外微服务。参数以独立 argv 传给进程，不经过 shell。
渲染器接触私有逐页 PDF 和受限临时目录；没有工具的本地环境仍可使用 PDF 路径。
Poppler 与 libwebp 的发行包保留各自许可证，见 `THIRD_PARTY_NOTICES.md`。
本地构建的同一后台镜像未压缩层体积约 29.1 MiB，现有后台镜像约 20.2 MiB，
增加约 9 MiB（不同构建戳和程序版本也会影响比较）。已在镜像内确认两个工具可由 UID 10001 执行。

## 验证

```sh
make check
REQUIRE_PAGE_IMAGES=1 python3 backend/tests/run_integration.py pdf_access_integration.mjs
PDF_BROWSER_SCRIPT="$PWD/backend/tests/page_images_browser.cjs" \
PDF_BROWSER_FIXTURE=/tmp/page-images-fixture.json \
PDF_BROWSER_OUTPUT=/tmp/page-images-evidence \
REQUIRE_PAGE_IMAGES=1 python3 backend/tests/run_integration.py pdf_access_integration.mjs
```

浏览器测试使用生产构建、真实临时后端和合成 PDF；Playwright 通过 `NODE_PATH` 定位，
先运行 `npm --prefix frontend run build`。CI 的 pdf-access 作业安装渲染器，运行真实图片测试，
并保存桌面/移动/降级截图与 `network-and-timing.json`。原跨任务 PDF 复用测试显式走降级路径。

2026-10-03 Windows 本地合成 PDF 单次首屏样本（从导航到可见内容，含接口与 UI 启动）：
桌面 WebP 354ms，移动 WebP 220ms，桌面 PDF 降级 410ms。这是单次合成资料证据，
不作为真实词典或生产网络的速度承诺。图片路径没有加载 PDF.js，也没有请求 `/pdf` 内容；
只取第 2 页和第 3 页两个 asset，切换至已预取第 3 页没有新增 asset 请求。

本地证据位于 `output/playwright/page-images/`（忽略目录）；真实语料不得作为测试产物提交。
本次可审阅的合成资料截图与请求记录归档在 [页图验收证据](screenshots/page-images/README.md)。
