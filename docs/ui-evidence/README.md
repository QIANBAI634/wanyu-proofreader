# 令牌与键盘走查证据

截图来自本机一次走查。改前是令牌合入前的界面（`7b90e64`），改后是焦点环、设计令牌和动态提示角色都已在页面上的界面。两边连的是同一个本地后端。全程只用键盘，没有用鼠标点击。

## 焦点环

登录框第一个输入框按 Tab 进入后，用计算样式取色：

| | outline | box-shadow |
| --- | --- | --- |
| 改前 | `none` | `rgb(229, 239, 240) 0px 0px 0px 3px`（`#e5eff0`） |
| 改后 | `3px solid rgb(49, 95, 104)`（`#315f68`） | `none` |

`#315f68` 对 `#fff` 的 WCAG 相对亮度比是 **7.08:1**，对 `--paper` `#f6f3ec` 是 **6.39:1**。改前 `#e5eff0` 对 `#fff` 约 **1.17:1**。

![改前登录焦点](before-login-focus.png)

![改后登录焦点](after-login-focus.png)

## 错误态与空态

错误态是登录时使用不存在的账号。空态是没有任何项目的用户打开校对大厅，文案为「当前没有需要你处理的项目」。这两处的像素在令牌替换前后保持一致，颜色只是改了名字。

![改前登录错误](before-login-error.png)

![改后登录错误](after-login-error.png)

![改前空态](before-empty-tasks.png)

![改后空态](after-empty-tasks.png)

## 键盘走查

校对提交从登录到确认提交没有使用鼠标。引导层出现时用 Esc 关闭。

| 步骤 | 结论 | 做法 |
| --- | --- | --- |
| 登录 | 通过 | Tab 进入账号框，可见 `3px` 主色环；Enter 提交 |
| 工作台 | 通过 | Tab 到「材料校对」，Enter 进入 |
| 大厅 | 通过 | 看到可领取项目，焦点环在主按钮上 |
| 领取 | 通过 | Enter 激活「领取任务」或「继续校对」 |
| 对照 | 通过 | 进入编辑器，原文与字段同屏 |
| 字段导航 | 通过 | 在位置「1 / 2」的第 5 条上按 Tab。焦点从「词条」（`proofread-field-0`）移到「读音」（`proofread-field-1`），字段标题跟着变 |
| 任务切换 | 未通过 | 同一账号同时有第 5 条和第 6 条进行中任务，「下一条」可用。Alt+→ 会先打开第 6 条，接着被重新领取带回第 5 条，并出现「原任务已被重新领取」。这项不能算通过，所以 #265 继续开着 |
| 字符键盘插字 | 通过 | Tab 到 `.ipa-key`，Enter 把字符插入校对字段 |
| 草稿 | 通过 | Ctrl+S 后出现「草稿保存中」 |
| 提交确认 | 通过 | Shift+Tab 到「检查并提交」，Ctrl+Enter 打开确认框。连续 Tab 留在框内。Esc 关闭后焦点回到「检查并提交」。再打开后 Tab 到「确认提交」并 Enter，页面出现「校对结果已提交」 |
| 仲裁 | 通过 | Tab 到条目上的「仲裁」链接并 Enter。用 Tab 和 Enter 点「采用原文」，直到「检查并完成仲裁」可用。Tab 留在确认框内，Esc 后焦点回到该按钮 |
| 导出 | 通过 | Tab 到「导出校对结果 CSV」，Enter 后开始下载 CSV |

![字段导航前，焦点在词条](field-nav-before.png)

![字段导航后，焦点在读音](field-nav-after.png)

![Alt+→ 之后回到第一条](task-switch-returned.png)

Alt+→ 在编辑器里调用的是切换任务，不是下一个校对字段。上面三张图是补测：前两张是 Tab 换字段，第三张是两条进行中任务时按下 Alt+→ 之后的结果。地址先到第 6 条，同一秒内回到第 5 条，并出现「原任务已被重新领取」和 `Cannot read properties of null (reading 'id')`。

![校对大厅](hall.png)

![对照编辑](editor.png)

![字符插入](keyboard-insert.png)

![提交确认](submit-dialog.png)

![Esc 之后](after-escape.png)

![提交结果](submitted.png)

![导出](export.png)

![仲裁](arbitration.png)
