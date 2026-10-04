# 页图预览验收证据

2026-10-03，生产前端构建、临时后端、合成四页 PDF，Chromium。
截图中的账号、项目和内容均由测试生成，不含真实词典或生产账号。

- [桌面页图与坐标示例](desktop.png)：1440×900；示例框仅由测试叠加。
- [移动页图](mobile.png)：390×844。
- [PDF 降级](fallback.png)：图片 descriptor 被测试模拟为 404。
- [请求与单次首屏耗时](network-and-timing.json)：只请求授权范围第 2/3 页图片，
  导航到预加载页没有新增 asset 下载，图片路径没有 `/pdf` 内容请求或 PDF.js 加载。

复现入口：`backend/tests/page_images_browser.cjs`，运行说明见
[页图预览文档](../../task-page-images.md)。首屏数据为单次合成资料样本，不能外推生产性能。
