# 万语校坊

万语校坊是面向方言、地方语言与民族语言资料整理团队的协同校勘平台。

很多珍贵资料已经存在于 PDF、词典、表格和纸质文献中，但把它们变成可靠的结构化数据，往往仍靠少数人反复人工核对。万语校坊希望把这件事做得更顺手：多人独立校对、自动发现差异、管理员仲裁，再把结果完整导出。

在“乡声万语”中，万语校坊负责专业资料整理；它也可以独立部署，用在其他语言、地方志或资料数字化项目里。

> **如果你关心 Web 工程、资料数字化、协同流程、语言学整理或校勘效率，欢迎直接参与。**

第一次贡献可以从 Issues 中的小任务开始；如果还不熟悉 Git / GitHub，可以先使用 [E-Dialect Git / GitHub 协作练习场](https://github.com/e-dialect/code-contributing-practice)。

产品定位与乡声集盒的协作边界见 [docs/PRODUCT_POSITIONING.md](docs/PRODUCT_POSITIONING.md)。

## 目录

- [当前流程与边界](#当前流程与边界)
- [欢迎参与](#欢迎参与)
- [当前稳定能力](#当前稳定能力)
- [2027 春节重点增强](#2027-春节重点增强)
- [功能概览](#功能概览)
- [快速启动](#快速启动)
- [首次配置](#首次配置)
- [使用流程](#使用流程)
- [CSV 格式](#csv-格式)
- [项目结构](#项目结构)
- [开发说明](#开发说明)
- [常见问题](#常见问题)

## 当前流程与边界

2027 春节阶段采用 **Data First + Product Polish**，总控 Issue 见 [SF-W · 2027 春节万语校坊 Sprint Tracking](https://github.com/e-dialect/wanyu-proofreader/issues/91)；本阶段不重写核心架构。

当前版本采用“可配置多人独立校对 + 管理员仲裁”流程：每个项目可设置每条材料所需的校对人数（默认且最少为 2）。收齐 N 份独立结果后，全部完全一致时条目自动完成；存在任意差异时，系统会永久保留全部结果并转入管理员仲裁。

`approved` 的跨产品数据质量边界以[产品定位文档](docs/PRODUCT_POSITIONING.md#1-定位)与 [#97](https://github.com/e-dialect/wanyu-proofreader/issues/97) 为准。

## 欢迎参与

我们欢迎代码、测试、文档、交互体验和真实资料整理流程方面的贡献。如果你发现某一步“实际校对起来很别扭”，即使暂时没有技术方案，也可以直接开 Issue 描述真实工作流。

## 当前稳定能力

- PDF / CSV 导入；
- 项目与角色管理；
- 多人独立校对；
- 差异检测；
- 管理员仲裁；
- 最终结果导出（按 PDF 页码定位；当前不包含逐位校对者的全过程审计记录）；
- 专用语言键盘；
- task lease / draft / progress。

## 2027 春节重点增强

- 智能错误发现与校勘辅助；
- 真实莆仙资料试点；
- 蒙古语 20k+ 数据试点；
- Review Bundle v0；
- Gold / Trusted corpus QA。

“智能协同校勘”描述产品方向，不表示当前已经具备成熟的 AI 自动校勘模型。

## 功能概览

| 角色 | 入口 | 主要功能 |
|------|------|----------|
| 平台管理员 `platform_admin` | `/workspace` | 管理项目创建白名单与额度，并可维护全部项目 |
| 项目所有者 / 管理员 | `/admin` | 配置成员与访问方式、准备 PDF/CSV、查看进度、仲裁和导出结果 |
| 项目校对员 | `/tasks` | 查看自己的项目队列、接取任务、校对结构化字段、使用项目键盘、查看个人统计 |

核心能力：

- 基于 PocketBase 的注册、登录、平台角色和项目级能力控制。
- 当前代码保留 `hinghwa` external identity provider 作为历史兼容路径；身份映射、独立权限与 SSO 状态以[产品定位文档](docs/PRODUCT_POSITIONING.md#3-登录)为准。
- 项目创建默认采用白名单：平台管理员不限量，普通用户须获授权并可设置额度。
- 项目支持指定成员、公开加入和口令加入；加入后成员身份持久保留。
- 同一用户可在不同项目承担不同职责，同一项目内管理员和校对员互斥。
- 项目所有者或管理员维护项目、PDF 文件和 CSV 条目。
- 项目所有者、管理员和平台管理员可按模板批量生成最多 200 个志愿者账号；初始密码只通过一次性 CSV 交付，首次登录必须修改。
- CSV 每行对应一条校对任务，`PDF页码` 用于定位原文页。
- 编辑器左右分栏显示 PDF 原文和纵向结构化字段卡；每个字段同时展示待校对原文、当前结果和修改状态。
- 内置版本化“莆仙方言键盘”，统一包含 IPA、数字上标、大词典拼音方案和平话字 BUC 字符。
- 项目所有者或管理员可配置启用键盘和默认键盘；用户的选择按用户与项目记忆，无可用键盘时隐藏入口。
- 键盘字符会插入到当前光标或替换选区，编辑内容按用户和任务自动保存到本地草稿。
- PDF 预览支持缩放、适宽、旋转、全屏和页码定位，窄屏下编辑器自动切换为上下布局。
- 支持 `Ctrl/⌘+S` 保存草稿、`Ctrl/⌘+Enter` 提交、`Alt+←/→` 切换任务。
- 任务使用 10 分钟活动租约；编辑器可见且活跃时每 2 分钟续租，断网、后台停留或关闭页面后自然过期。
- 租约令牌只保存在当前标签页会话，数据库仅保存摘要；失效时保留本地草稿并提供重新领取入口。
- 项目大厅按项目汇总可领取、我的进行中和完成进度，不向校对员显示当前校对轮次。
- 每人每轮最多提交一次，编辑器始终只从原始材料开始，不会预填其他校对员结果。
- 任意数量的独立结果只写入受限的校对历史集合；比较和状态转换由后端事务完成。
- 收齐项目要求的 N 份结果后，全部一致自动标记为 `approved`；任意差异进入 `arbitration`，由管理员逐字段确认最终值。
- 校对提交前展示修改字段摘要；管理员仲裁必须明确确认所有差异字段后才能提交。
- 个人主页展示参与项目数、校对次数、结果一致率和排行，不一致记录不会从统计中消失。
- 管理员可按条号、PDF 页码、文本或校对员搜索条目，按状态筛选并分页浏览大项目。
- 管理控制台按待仲裁数量优先排列项目，可从管线状态直接进入项目筛选结果。
- 页面运行异常会显示可恢复的错误界面，管理员列表加载和批量操作均提供页面内反馈。
- 浏览器保存的登录身份会在应用启动时向后端刷新；账号失效时自动回到登录页。

## PocketBase 0.40 重建升级

当前后端使用 PocketBase 0.40（补丁版本以 `backend/go.mod` 为准）/ Go 1.27，前端使用 Node 24 LTS / PocketBase SDK 0.28.1。
旧版本尚无正式运营数据，本次采用新目录重建；不要直接复用旧 pb_data。
部署切换、回滚及验证证据见 [升级决策](docs/dependency-upgrades.md)。

## 快速启动

### Docker Compose 本地生产模式

默认 Compose 会构建生产镜像，并将 Nginx 前端发布到本机 `8080` 端口：

```bash
cp .env.example .env
docker compose up -d --build
```

Windows 宿主机如果不适合直接挂载 `./pb_data`，用 Docker named volume 启动：

```bash
cp .env.example .env
docker compose -f docker-compose.yml -f docker-compose.named-volume.yml up -d --build
```

`.env` 里通常只需要先改：

- `APP_ADMIN_EMAIL` / `APP_ADMIN_PASSWORD`：万语校坊业务管理员账号。
- `PB_ADMIN_EMAIL` / `PB_ADMIN_PASSWORD`：需要创建 PocketBase 管理员时再改；生产入口默认不会公开 Admin UI。
- `ENABLE_POCKETBASE_ADMIN_UI`：Traefik 模式默认 `true`，本地生产入口默认 `false`；可显式设置 `false` 关闭后台入口。后台始终要求独立的 PocketBase 管理员登录。

启动后访问：

- 前端：`http://localhost:8080`
- PocketBase Admin UI：默认对 `http://localhost:8080/_/` 返回 404。
- PocketBase API：`http://localhost:8080/api/`

生产模式下前端会先构建为静态文件，再由 Nginx 托管。默认同源访问 PocketBase：

```txt
http://localhost:8080/      -> 前端
http://localhost:8080/api/  -> PocketBase API
http://localhost:8080/_/    -> 默认 404；显式启用后才代理 Admin UI
```

常用命令：

```bash
docker compose ps
docker compose logs -f frontend
docker compose logs -f backend
docker compose down
```

说明：

- `docker-compose.yml` 是本机生产镜像入口，不使用 Vite dev server，因此不需要维护 Vite `allowedHosts`。
- `frontend` 内置 Nginx 会把 `/api/` 转发到 Docker 内部地址 `backend:8090`；backend 不发布宿主机端口。
- 本地生产入口默认隐藏 PocketBase Admin UI。需要访问时，将 `ENABLE_POCKETBASE_ADMIN_UI=true` 后执行 `docker compose up -d --force-recreate frontend`；完成后改回 `false` 并再次重建前端容器。
- `TRUSTED_PROXY_CIDRS` 必须限制为实际 Traefik、内置 Nginx 与后端共享的 Docker network。Nginx 只信任这些来源提供的 `X-Real-IP`，并会覆盖浏览器传入的 `X-Forwarded-For`；后端也只解析该网段转发的地址。不要把 backend 端口直接暴露到公网。
- `BACKEND_URL` 留空时，前端自动使用 `window.location.origin`，适合同域名或同端口反向代理部署。
- `BACKEND_URL` 设置为完整后端地址时，前端容器会把构建产物里的 `VITE_BACKEND_URL_RUNTIME_REPLACEMENT` 替换成该地址，适合前后端不同域名部署。
- PocketBase 数据默认通过本地目录 `./pb_data` 持久化，重建容器不会清空数据库和上传文件。Windows 宿主机如果遇到 SQLite 或文件挂载问题，可叠加 `docker-compose.named-volume.yml` 改用 Docker named volume。
- PocketBase schema 和 API rules 由 `backend/pb_migrations` 自动应用。

### Docker Compose Traefik 模式

公网部署使用独立的完整 Compose 文件：

```bash
cp .env.example .env
# 编辑 .env，至少取消注释并设置 TRAEFIK_HOST
docker compose -f docker-compose.traefik.yml up -d --build
```

该入口不发布宿主机端口。`frontend` 会加入默认名为 `traefik-global-proxy` 的 external network，Traefik 只路由到 `frontend:80`，再由 Nginx 同源代理 `/api/`。如果代理网络名不同，请设置 `TRAEFIK_NETWORK`；网络必须由 Traefik 部署预先创建。

Windows 宿主机也可叠加 named volume：

```bash
docker compose -f docker-compose.traefik.yml -f docker-compose.named-volume.yml up -d --build
```

常用命令：

```bash
docker compose -f docker-compose.traefik.yml ps
docker compose -f docker-compose.traefik.yml logs -f frontend backend
docker compose -f docker-compose.traefik.yml down
```

### Docker Compose 开发模式

适合需要前端热更新的本地开发。

```bash
cp .env.dev.example .env
docker compose -f docker-compose.dev.yml up --build
```

Windows 宿主机可改用 named volume：

```bash
cp .env.dev.example .env
docker compose -f docker-compose.dev.yml -f docker-compose.named-volume.yml up --build
```

启动后访问：

- 前端：`http://localhost:5250`
- PocketBase Admin UI：`http://localhost:8090/_/`
- PocketBase API：`http://localhost:8090/api/`

常用命令：

```bash
docker compose -f docker-compose.dev.yml ps
docker compose -f docker-compose.dev.yml logs -f frontend
docker compose -f docker-compose.dev.yml logs -f backend
docker compose -f docker-compose.dev.yml down
```

说明：

- Docker 前端开发端口默认使用 `5250`，配置在 [.env.dev.example](.env.dev.example)。
- 前端代码挂载到容器内，支持热更新。
- PocketBase 数据默认写入项目根目录 `./pb_data`；Windows 宿主机可叠加 `docker-compose.named-volume.yml` 使用 Docker named volume。

### 手动本地开发

适合不使用 Docker 或需要分别调试前后端的场景。请分别打开两个终端。

后端：

```bash
cd backend
# 集成测试会自动构建一次性二进制；手工调试时自行构建到 backend/pocketbase
# （该路径已被 .gitignore 排除，仓库不提供预编译二进制）
go build -o pocketbase .
./pocketbase serve --hooksDir=pb_hooks --migrationsDir=pb_migrations
```

前端：

```bash
cd frontend
cp .env.example .env
npm install
npm run dev
```

`.env` 示例：

```env
VITE_PB_URL=http://127.0.0.1:8090
```

手动开发默认地址：

- 前端：`http://localhost:5173`
- 后端：`http://127.0.0.1:8090`

### 生产构建与预览

```bash
cd frontend
npm install
npm run build
npm run preview
```

构建产物位于 `frontend/dist/`。Docker 生产镜像支持运行时 `BACKEND_URL` 覆盖，因此同一份镜像可以部署到不同域名。

### 云服务器部署

1. 安装 Docker Engine 和 Compose Plugin。
2. 上传或拉取本项目代码到服务器。
3. 复制环境变量文件：

```bash
cp .env.example .env
```

4. 编辑 `.env`。

Traefik 同域名部署示例：

```env
TRAEFIK_HOST=fangji.example.com
TRAEFIK_NETWORK=traefik-global-proxy
TRAEFIK_ENTRYPOINT=websecure
TRAEFIK_CERT_RESOLVER=letsencrypt
APP_ADMIN_EMAIL=admin@example.com
APP_ADMIN_PASSWORD=请换成强密码
APP_ADMIN_NAME=管理员
PB_ADMIN_EMAIL=pb-admin@example.com
PB_ADMIN_PASSWORD=请换成另一个强密码
ENABLE_POCKETBASE_ADMIN_UI=true
BACKEND_URL=
PB_ALLOWED_ORIGINS=
```

访问结构：

```txt
https://fangji.example.com/      -> 前端
https://fangji.example.com/api/  -> PocketBase API
https://fangji.example.com/_/    -> 默认 404；维护窗口可显式启用
```

`docker-compose.traefik.yml` 默认只支持同域名入口，不为 backend 创建独立公网 router。若需要前后端不同域名，应单独设计 backend router、external network、`BACKEND_URL` 和 `PB_ALLOWED_ORIGINS`，不要直接套用此配置。

5. 启动服务：

```bash
docker compose -f docker-compose.traefik.yml up -d --build
```

6. 查看状态：

```bash
docker compose -f docker-compose.traefik.yml ps
docker compose -f docker-compose.traefik.yml logs -f backend frontend
```

7. 首次登录应用：

- 使用 `.env` 里的 `APP_ADMIN_EMAIL` 和 `APP_ADMIN_PASSWORD` 登录网站。
- Traefik 模式默认开放 **`https://你的域名/_/`** 的 PocketBase 管理员登录页；输入 `/_` 会相对跳转到 `/_/`，不会跳向容器地址或降级为 HTTP。
- 这里使用 **`PB_ADMIN_EMAIL` / `PB_ADMIN_PASSWORD`** 对应的 PocketBase 管理员账号，与万语校坊的 `APP_ADMIN_EMAIL` / `APP_ADMIN_PASSWORD` 业务管理员账号不同。
- 如果旧 `.env` 中有 `ENABLE_POCKETBASE_ADMIN_UI=false`，它会继续覆盖默认值并返回 404。改为 `true` 后执行 `docker compose -f docker-compose.traefik.yml up -d --build --force-recreate frontend`（仅 restart 不会更新容器环境变量）。
- 要关闭后台，显式设置 `ENABLE_POCKETBASE_ADMIN_UI=false` 并重新创建 frontend。backend 仍不发布宿主机端口，不需要给 Traefik 新增 backend 路由。
- PocketBase collections、字段和 API rules 会由迁移自动应用，不需要进后台手动配置业务规则。

如果服务器前面是宿主机上的 Nginx/Caddy/宝塔而不是 Traefik，请使用默认 `docker-compose.yml`，并把域名代理到 `${FRONTEND_PORT:-8080}`。backend 始终不直接发布宿主机端口。

## 首次配置

1. 启动 PocketBase。
2. 确认迁移自动创建或更新以下 collections：
   - `users`：内置 Auth 集合，扩展 `role` 字段，当前有效全局角色为 `platform_admin`、`user`。
   - `projects`：校对项目，`admin` 字段保存唯一所有者，并配置新成员访问方式及 `required_proofreads`。
   - `project_memberships`：项目管理员或校对员关系；每个用户在同一项目只有一个角色。
   - `project_creator_grants`：普通用户的项目创建授权、可选额度和审计时间。
   - `external_identity_mappings`：外部 provider subject 与本地用户的一对一服务端映射，客户端不能直接读写。
   - `project_access_secrets`：口令加入项目的盐值和摘要，不保存明文口令。
   - `keyboards`：经启动校验和同步的全局版本化键盘定义，保留预置/上传来源字段。
   - `project_keyboards`：项目启用键盘、显示顺序与默认键盘。
   - `task_leases`：任务持有者、原队列、令牌摘要、活动时间和到期时间；客户端无法直接读取。
   - `project_files`：项目 PDF 文件。
   - `pages`：待校对条目、已提交人数、任务状态和最终结果。
   - `proofreading_attempts`：每轮任意数量的独立校对结果和独立仲裁结果；校对员只能读取自己的尝试。
3. 创建业务用户：
   - Docker 部署时，设置 `APP_ADMIN_EMAIL` 和 `APP_ADMIN_PASSWORD` 后会自动创建业务管理员。
   - Docker 部署时，设置 `PB_ADMIN_EMAIL` 和 `PB_ADMIN_PASSWORD` 后会自动创建 PocketBase Admin UI 管理员。
   - 公开注册入口创建的用户会被后端 hook 固定为 `user`，默认没有项目权限。

批量生成的志愿者账号没有业务邮箱要求，可在登录框直接使用用户名。系统为每个账号生成独立的 16 位密码并标记 `must_change_password`；账号完成首次改密前无法领取或提交任务。

不要直接修改已经执行过的迁移文件。需要调整 schema、权限或数据修复时，请新增迁移文件。

## 使用流程

### 1. 登录与路由

- 未登录用户只能访问 `/login` 和 `/register`。
- 所有用户登录后进入 `/workspace`，入口按当前项目能力显示。
- 平台管理员可进入“创建权限”，向普通用户授权、设置额度或撤销授权。
- 获得项目管理能力的用户可进入 `/admin`；项目校对员可进入 `/tasks`。
- 新数据库直接使用 `platform_admin` / `user` 及项目成员职责；历史角色转换仅保留在旧迁移参考目录中，不在本次重建时运行。

#### 外部统一身份

在 `.env` 设置 `HINGHWA_IDENTITY_BASE_URL=https://identity.example.com` 后，登录页会显示“兴化语记”入口，万语校坊后端向该地址的 `/login` 发送 `username`、`password`。这是当前保留的 `hinghwa` 历史兼容路径，不表示乡声集盒 SSO 已经实现。首次验证成功时系统创建一个没有项目权限的本地 `user` 并保存 provider-local subject 映射；已登录用户也可在个人主页显式绑定。系统不会按邮箱或姓名自动合并账号，登录或绑定后会从公开 `/users/{id}` 详情核对 ID 并补齐空缺的昵称、邮箱和头像；已有用户也会补齐，保留已填写的本地资料。邮箱通过本地格式/唯一性校验后保存为未验证，冲突时跳过；头像仅从已知兴化语记存储域读取有效的 PNG/JPEG/GIF/WebP（最多 2 MiB、边长最多 4096 像素），保存到本地头像字段，不转发远端令牌或跟踪图片 URL。资料补齐共用 5 秒超时，失败不阻断登录；密码、角色与项目权限不从远端导入。

远端返回的 HS256 token 只在单次后端请求内读取后立即丢弃，不写数据库、日志或浏览器响应，也不需要共享远端签名密钥。适配器强制 HTTPS、5 秒超时、禁止重定向、限制响应为 64 KiB，并按来源地址执行登录限流；日志只记录 provider 与脱敏后的结果类别。`HINGHWA_IDENTITY_BASE_URL` 为空时该入口不会显示。

### 2. 创建与开放项目

1. 使用平台管理员账号，或由平台管理员给普通用户开放项目创建权限。
2. 在工作台点击“创建项目”；普通用户达到额度后不会显示可用入口，服务端也会拒绝超额创建。
3. 填写项目名称、简介和访问方式。新项目默认采用“指定成员”。
4. 创建成功后进入项目详情页。

创建者自动成为项目唯一所有者。所有者和项目管理员可在项目设置中添加成员、批量生成志愿者账号、配置至少 2 人的校对人数、配置启用键盘和默认键盘，并在“公开加入”“指定成员”“口令加入”之间切换；切换方式或修改口令不会移除已有成员。删除项目或转移所有权会立即释放原所有者占用的创建额度。新旧项目默认采用 2 人校对并启用“莆仙方言键盘”。

口令加入的失败尝试同时按“项目 + 账号”和“项目 + 可信客户端来源”限速；可信来源由 `TRUSTED_PROXY_CIDRS` 控制，客户端自行提交的转发头不参与身份判定。限制窗口和封禁均结束满 24 小时后，每小时由进程级定时任务原子清理，每个集合最多删除 250 条。清理不在加入请求中运行；即使没有请求也会执行。并发刷新后的有效记录不会被删除。

### 3. 批量生成志愿者账号

1. 在项目设置的“批量志愿者账号”填写数量、包含 `{n}` 的用户名规则、起始编号、补零位数和昵称规则。
2. 服务端先在事务内检查全部用户名；任一冲突或校验失败时整批不创建，单批最多 200 个。
3. 成功后账号会直接成为该项目校对员，浏览器立即下载带 UTF-8 BOM 的 CSV，包含项目、昵称、用户名、初始密码和登录地址。
4. 初始密码明文不写数据库或日志，响应禁止缓存；页面刷新或离开后无法重新取得本批密码。当前页面未关闭前可以再次下载同一份 CSV。
5. 志愿者可用用户名或邮箱登录。使用初始密码登录后会被引导到首次改密页，完成前不能领取或提交校对任务；改密完成后须使用新密码重新登录。

项目详情页会展示总页数、已校对数、校对完成数和完成进度。

条目较多时，可使用列表上方的搜索、状态筛选和每页条数设置。搜索范围包括条号、PDF 页码、原始/校对文本和校对员姓名或邮箱。筛选只影响当前显示，不会改变项目统计或已经勾选的待校对条目。

### 4. 管理员上传 PDF

1. 进入项目详情页。
2. 在“上传 PDF 文件”区域选择单个 PDF，选择后会自动开始上传并显示进度。上传期间不能再选择文件。
3. 等待后端校验结果；如上传失败，可点击“重试上传 PDF”或重新选择文件。

单个 PDF 最大 100 MiB（104,857,600 字节），CSV 仍为 50 MiB。后端 PDF 请求和内置 Nginx 请求上限为 101 MiB，为 multipart 编码预留空间。升级时需同时重新部署后端和前端 Nginx；后端启动迁移会更新已有数据库的 PDF 字段限制。若部署了额外网关，也需允许至少 101 MiB 的请求体。

PDF 用于校对员编辑时预览原文。文件只上传一次，后端会检查大小、扩展名、文件签名并使用 pdfcpu 深度解析 PDF 结构；校验成功后记录页数、校验器和校验时间。每个项目只有一个主 PDF，新文件成功后会原子替换主文件，旧文件保留为历史记录；只有状态为 `ready` 且标记为主文件的 PDF 才会用于预览。PDF 不会自动 OCR 或生成条目，待校对文本主要通过 CSV 导入。

### 5. 管理员导入 CSV

1. 准备包含表头的 CSV 文件。
2. 确保文件包含一个受支持的页码列。
3. 在项目详情页选择 CSV 并点击“后端预检 CSV”。
4. 查看编码、表头、数据预览、可导入数量和错误明细，确认后再开始导入；确认阶段复用后端已保存的文件，不会再次上传。

导入规则：

- 每一行生成一条 `pending` 待校对条目。
- 页码字段支持 `PDF页码`、`page`、`pdf_page` 或 `页码`，且只能出现其中一个。
- 页码必须是正整数；项目存在主 PDF 时，页码不能超过该 PDF 的总页数。
- 除页码字段外的列会作为结构化字段展示在校对表格中。
- 去掉页码字段后内容全空的行会被拒绝。
- 浏览器只上传一次文件，解析、校验和数据库写入都在后端作业中完成。
- 格式错误的行会记录 CSV 行号、字段、错误代码和原因，并被跳过；其他合法行继续导入。
- 前端会显示后端作业状态、成功/跳过数量和前 100 条错误明细。
- CSV 支持标准引号转义和引号字段内换行，不允许空表头、重复表头或行列数量不一致。
- 支持 `UTF-8`、`GB18030`、`GBK` 编码识别。
- 相同项目重复上传内容相同的 CSV 时会复用既有成功或处理中作业，避免重复导入。

### 6. PDF 与 CSV 的组合

在选择文件和导入顺序时，项目支持以下三种组合：

- **PDF-only**：可以上传、验证和预览 PDF，但 PDF 不会自动 OCR，也不会自动生成校对条目；在导入 CSV 前任务大厅不会出现新任务。
- **CSV-only**：可以在没有 PDF 的情况下预检并导入 CSV；条目可正常校对，但编辑器没有原文 PDF 可供对照，CSV 页码只作为来源元数据保留。
- **PDF + CSV（推荐）**：先上传并等待 PDF 变为“可用”，再预检 CSV。预检会固定当时的主 PDF 及其页数，正式导入的每条任务永久关联该 PDF；之后上传新的主 PDF 不会改变旧任务的原文来源。若希望同一 CSV 对应新 PDF，请重新执行预检。

升级前已经完成预检、但尚未确认导入的旧作业没有 PDF 快照，确认时会要求重新上传并预检，避免静默关联错误文件。

### 7. 管理员管理条目

项目详情页底部显示条目列表。管理员可对 `pending` 状态的条目进行：

- 范围选择，例如 `1-33` 或 `1,3,5-8`。
- 全选待校对条目。
- 批量下移所选条目。
- 批量删除所选条目。
- 单条上移或下移。

已被认领、校对中、正在收集结果或已完成的条目不会参与这些顺序和删除操作。

### 8. 校对员接取项目

1. 使用已被分配为该项目校对员的账号登录，或先加入公开/口令项目。
2. 进入“项目大厅”。
3. 查看各项目的可领取任务、我的进行中任务和完成进度。
4. 点击“领取任务”或“继续校对”。界面只预告即将打开的条号，不显示其内部轮次。

系统会优先进入该项目中当前校对员自己的进行中任务；如果没有进行中任务，则按条号接取下一条可处理任务。

同一条目的每份独立结果必须来自不同校对员。如果剩余条目都包含自己的既有提交，界面只提示暂无可处理任务，不暴露已提交人数、所需人数或后台轮次。

领取后编辑器显示本次任务保留时间。页面可见且浏览器窗口活跃时会自动续租；也可以主动释放任务。租约到期但尚未被其他人重新领取时，原校对员仍可用原令牌提交；一旦任务被重新领取，旧标签页只能保留草稿并重新领取，不能覆盖新持有人的工作。

### 9. 校对员编辑并提交

编辑页左侧显示 PDF 原文，右侧按纵向字段卡显示 CSV 内容和项目键盘。字段卡始终保留待校对原文，修改后的字段会明确标记，也可以逐项恢复原文。

操作流程：

1. 根据 `PDF页码` 查看对应 PDF 页；界面允许在当前页和下一页之间切换，并支持缩放、适宽、旋转和全屏。
2. 在右侧字段卡中逐项独立校对；顶部会显示当前任务位置、草稿状态和修改字段数，不显示后台轮次。
3. 从本项目启用的键盘中选择并展开需要的分组，在当前光标处插入特殊字符，也可以替换已选中的文本；浏览器会记住该用户在本项目的选择。
4. 在自己的进行中任务之间切换上一条/下一条；首条、末条或仅有一条时，相应按钮不可用，界面会说明原因。任务位置加载失败时可重试，已提交条目不再显示进行中任务位置。
5. 点击“检查并提交”，核对修改字段摘要后确认提交。没有修改时，确认表示导入内容全部正确。

编辑内容修改后会自动保存到当前浏览器的本地草稿；刷新或重新打开同一任务时会自动恢复。草稿按用户和任务隔离，原始任务内容变化时旧草稿会自动失效，提交成功后会清除。离开当前任务、切换上一条/下一条或刷新页面前，如果当前内容尚未提交，系统仍会提示确认。

本地草稿使用 `localStorage`，任务租约令牌只使用 `sessionStorage`。关闭标签页不会主动发送释放请求，租约将在无活动 10 分钟后自然释放给其他校对员；若希望立即交还，可点击“释放任务”。

编辑器快捷键：

- `Ctrl/⌘+S`：立即保存本地草稿。
- `Ctrl/⌘+Enter`：打开提交确认；确认面板打开时再次使用可提交当前校对。
- `Alt+←/→`：切换到上一条或下一条任务。

提交结果：

- 未收齐 N 份结果时，条目状态变为 `proofread`，继续等待其他校对员独立提交。
- 后续校对始终从原始 CSV 内容开始，不显示任何已有结果。
- 收齐 N 份且全部字段内容完全一致时，条目状态变为 `approved`。
- 收齐 N 份后存在任意差异时，`mismatch_count` 增加，条目变为 `arbitration`；全部结果会保存在 `proofreading_attempts` 中。
- 管理员提高 N 时，尚未仲裁的自动一致条目会保留既有结果并重新开放；降低 N 时会立即重算已达阈值的非活跃条目。持有有效租约的编辑者可先完成或释放任务，已完成仲裁的条目不会重新开放。

### 10. 管理员仲裁不一致条目

1. 从管理员控制台的“待仲裁”数量进入项目，或在项目详情状态总览中点击“待仲裁”。
2. 仲裁台左侧显示当前条目关联的 PDF，右侧动态展示全部校对结果并默认只显示不一致字段；可逐项采用原文、任一校对结果或手工编辑，也可以批量采用一个来源。
3. 所有差异字段明确确认后，可填写仲裁说明并检查提交摘要；提交后条目变为 `approved`。

仲裁不会覆盖或删除任何独立校对历史，最终值会作为单独的 `arbitration` 记录保存。

### 11. 校对员个人主页

校对员可在 `/tasks/profile` 查看：

- 参加项目数。
- 已校对条目数。
- 结果一致的校对次数。
- 结果一致率。
- 一致率排行和条目排行。

同一条目的每次独立提交会分别计入参与记录；尚未完成项目人数要求的尝试暂不进入一致率分母。

### 12. 管理员导出结果

在项目详情页点击“导出校对结果 CSV”。

导出规则：

- 按条号顺序导出。
- `approved` 条目使用最终校对结果。
- 未完成条目回退到原始 CSV 内容。
- 导出的第一列为 `PDF页码`。
- 文件名格式为 `{项目名}_校对结果.csv`。

## CSV 格式

CSV 必须包含表头，且必须包含 `PDF页码`、`page`、`pdf_page` 或 `页码` 中的一个字段。其他字段名不限，会在校对编辑器中作为栏目展示。

示例：

```csv
PDF页码,词条,读音,释义,例句
1,天光,tʰiŋ⁵⁵ kŋ̍⁴²,早晨,天光就起身
1,食饭,siaʔ⁵ puŋ⁵³,吃饭,转来食饭
2,厝边,t͡sʰuɔ⁵³ piŋ⁵⁵,邻居,厝边来坐
```

字段说明：

| 字段 | 是否必填 | 说明 |
|------|----------|------|
| `PDF页码` / `page` / `pdf_page` / `页码` | 四选一 | 正整数，用于定位 PDF 原文页；存在主 PDF 时不得超过其总页数 |
| 其他字段 | 至少一个非空 | 作为校对表格栏目导入 |

## 项目结构

```text
wanyu-proofreader/
├── README.md
├── CHANGELOG.md
├── CONTRIBUTING.md
├── Makefile                      # make check / test-integration / seed / coverage
├── .env.example
├── .env.dev.example
├── docker-compose.yml
├── docker-compose.dev.yml
├── docker-compose.traefik.yml
├── docker-compose.named-volume.yml
├── ops/
│   ├── audit_storage.py          # 只读的磁盘与缓存水位巡检
│   └── prepare_upload_timeout.py # Traefik 读取超时配置
├── scripts/
│   └── check_compose_structure.py
├── docs/                         # 运维、依赖升级、计划与验证截图
├── frontend/
│   ├── eslint.config.js
│   ├── Dockerfile
│   ├── nginx.conf
│   ├── package.json
│   ├── vite.config.js
│   ├── public/
│   │   └── pdfjs/                  # PDF.js 静态资源
│   ├── tests/                    # node:test 单测与浏览器/fixture 资源
│   └── src/
│       ├── components/             # 导航、编辑器、PDF 预览、项目键盘
│       ├── composables/            # PDF、结构化字段、任务导航复用逻辑
│       ├── constants/              # 条目状态和状态标签
│       ├── lib/                    # PocketBase 客户端、草稿和 diff 工具
│       ├── router/                 # Vue Router 与角色路由守卫
│       ├── services/               # PocketBase 数据访问封装
│       ├── stores/                 # Pinia 登录状态
│       ├── utils/                  # PocketBase 错误格式化
│       └── views/                  # 登录、注册、管理员、校对员页面
└── backend/
    ├── Dockerfile
    ├── main.go                     # 自定义 PocketBase 启动入口
    ├── import_service.go           # PDF 校验和持久化 CSV 导入队列
    ├── external_identity.go        # 外部身份 provider、映射、登录和绑定
    ├── hinghwa_identity.go         # 兴化语记 /login 安全适配器
    ├── docker-entrypoint.sh
    ├── pb_hooks/                   # PocketBase hooks（路由与权限判定）
    ├── keyboards/                  # 版本化内置键盘 JSON 与格式说明
    ├── pb_migrations/              # Schema、权限、导入作业、键盘和多人校对迁移
    ├── legacy_migrations/          # 已废弃的 0.22 时代迁移，仅作参考
    ├── ops/
    │   └── backup.py               # 离线校验式备份与恢复
    └── tests/                      # run_all.py、suites.json、集成套件与守卫脚本
```

## 开发说明

### 技术栈

- 前端：Vue 3、Vite、Vue Router、Pinia
- 后端：PocketBase 0.40 自定义 Go 构建
- 样式：纯 CSS
- PDF 预览：静态引入 PDF.js
- 部署：Docker Compose

### 前端脚本

```bash
npm test
npm run dev
npm run build
npm run preview
```

`npm test` 运行前端单元测试，覆盖光标/选区插入、本地草稿、跨任务反馈、角色工作台状态汇总、管理员条目筛选/分页/范围解析，以及仲裁差异确认门槛。

### 键盘定义与同步

内置定义位于 `backend/keyboards/*.json`，格式见 `backend/keyboards/README.md`。后端二进制通过 Go `embed` 打包定义，并在每次启动时先严格校验 `schemaVersion`、ID、分区和按键，再按键盘 ID 幂等同步。仓库中不再存在的旧预置只会标记为停用，既有项目关系不会被删除；未来上传自定义键盘应复用同一 JSON 结构与校验器。

键盘集成测试覆盖启动同步、新项目默认值、项目级读写权限、关闭全部键盘和默认键盘约束：

```bash
PB_URL=http://127.0.0.1:8090 \
APP_ADMIN_EMAIL=admin@example.com \
APP_ADMIN_PASSWORD=your-password \
node backend/tests/keyboards_integration.mjs
```

### 关键状态

```text
pending
  -> proofreading
  -> proofread
  -> ...（由不同校对员继续提交）
  -> approved

收齐 N 份后不一致:
proofreading -> arbitration -> approved
```

状态含义：

| 状态 | 含义 |
|------|------|
| `pending` | 尚无独立校对结果 |
| `claimed` | 已被校对员接取，还未进入编辑态 |
| `proofreading` | 校对员正在编辑 |
| `proofread` | 已有独立结果，尚未收齐项目要求的人数 |
| `arbitration` | 收齐结果后存在差异，等待管理员仲裁 |
| `approved` | N 份结果全部一致或仲裁完成，条目在本项目校勘工作流中完成；跨产品质量边界见[产品定位文档](docs/PRODUCT_POSITIONING.md#1-定位) |

`reviewing`、`rejected` 是旧流程遗留状态，当前路由和主要业务流程不再使用。

### 后端约束

校对员不能直接更新 `pages`。后端自定义接口在事务中完成以下操作：

- 原子认领 `pending`、`proofread` 或租约已过期的条目，并轮换不可恢复的随机令牌。
- 领取、续租、提交和释放均核验数据库中的令牌摘要；提交成功后删除租约。
- 同一校对员每轮最多提交一次。
- 保存不可被另一位校对员读取的校对尝试。
- 在后端比较 N 份结构化结果并决定 `approved` 或 `arbitration`。
- 调整 N 时事务性重算状态，并保护仍持有有效租约的编辑者与已完成仲裁的条目。
- 仅允许管理员读取全部结果和提交仲裁。

### 第一阶段集成测试

测试覆盖越权修改拦截、盲校、一致自动通过、不一致转仲裁、管理员仲裁和历史统计：

```bash
PB_URL=http://127.0.0.1:8090 \
PB_SUPER_EMAIL=pb-admin@example.com \
PB_SUPER_PASSWORD=your-password \
node backend/tests/phase1_integration.mjs
```

请只对测试数据库运行；脚本会创建并清理临时项目和用户。

可配置人数测试覆盖三人一致与差异、单人重复提交、N 增减、动态仲裁记录、有效/过期租约和校对员队列脱敏：

```bash
PB_URL=http://127.0.0.1:8090 \
APP_ADMIN_EMAIL=app-admin@example.com \
APP_ADMIN_PASSWORD=your-app-password \
PB_SUPER_EMAIL=pb-admin@example.com \
PB_SUPER_PASSWORD=your-password \
node backend/tests/proofreading_quorum_integration.mjs
```

批量账号测试覆盖权限、200 个上限、用户名冲突回滚、CSV BOM/no-store、随机密码、用户名登录、首次改密门禁和令牌轮换：

```bash
PB_URL=http://127.0.0.1:8090 \
APP_ADMIN_EMAIL=app-admin@example.com \
APP_ADMIN_PASSWORD=your-app-password \
PB_SUPER_EMAIL=pb-admin@example.com \
PB_SUPER_PASSWORD=your-password \
node backend/tests/volunteer_accounts_integration.mjs
```

外部身份测试完全使用本机 mock HTTPS provider，不访问真实统一身份服务；覆盖成功、失败、超时、禁止重定向、畸形/超大响应、重复映射、绑定冲突、新旧账号资料补齐、已有资料保护、重复邮箱跳过、头像持久化和地址/大小/格式限制、默认无项目权限、可信代理取址和客户端/全局双层限流：

```bash
cd backend
go test ./...
```

部署环境只在获得一次性测试账号时进行人工联调，CI 不依赖外部服务。适配行为依据上游 Django [`/login` 接口](https://github.com/e-dialect/hinghwa-dict-backend/blob/develop/hinghwa-dict-backend/user/views.py)及其[令牌实现](https://github.com/e-dialect/hinghwa-dict-backend/blob/develop/hinghwa-dict-backend/utils/token.py)；万语校坊使用响应中的稳定用户 ID，不消费远端 token；登录和绑定后另外读取公开用户详情并核对 ID，补齐本地空缺资料。

容器 CI 还会经过实际 Nginx 代理轮换伪造的 `X-Forwarded-For`，确认同一可信 `X-Real-IP` 仍共享客户端额度，并确认另一客户端不会被该额度连带封锁。

项目权限集成测试覆盖默认拒绝创建、有限/无限额度、并发额度边界、创建授权撤销、所有权转移、成员角色互斥、三种访问方式、成员持久性、账号与可信来源双重口令限速，以及跨项目越权拦截：

```bash
PB_URL=http://127.0.0.1:8090 \
APP_ADMIN_EMAIL=admin@example.com \
APP_ADMIN_PASSWORD=your-password \
PB_ADMIN_EMAIL=pb-admin@example.com \
PB_ADMIN_PASSWORD=your-password \
node backend/tests/project_access_integration.mjs
```

任务租约集成测试覆盖令牌摘要、续租、显式释放、过期后提交、他人重新领取和旧标签页提交拦截：

```bash
PB_URL=http://127.0.0.1:8090 \
APP_ADMIN_EMAIL=admin@example.com \
APP_ADMIN_PASSWORD=your-password \
PB_SUPER_EMAIL=pb-admin@example.com \
PB_SUPER_PASSWORD=your-password \
node backend/tests/task_leases_integration.mjs
```

### 第二阶段前端测试

```bash
cd frontend
npm test
npm run build
```

测试覆盖编辑器光标插入、本地草稿恢复和跨任务提交反馈；生产构建用于验证 Vue 组件与资源可正常打包。

### 第三阶段前端测试

第三阶段测试已并入同一测试命令：

```bash
cd frontend
npm test
npm run build
```

新增用例覆盖管理员搜索/状态组合筛选、分页边界，以及普通逗号、中文逗号和逆序范围输入。
- 公开注册用户固定为全局 `user`，避免注册时提权；项目职责通过独立成员关系分配。

### CSV / PDF 上传集成测试

上传用例覆盖 CSV 预检与确认、BOM 和页码别名、逐行错误、内容去重、PDF 深度损坏、页数元数据、主 PDF 替换及 CSV 页码越界：

```bash
PB_URL=http://127.0.0.1:8090 \
APP_ADMIN_EMAIL=admin@example.com \
APP_ADMIN_PASSWORD=your-password \
node backend/tests/upload_jobs_integration.mjs
```

可通过 `REAL_PDF_PATH` 和 `REAL_CSV_PATH` 传入本地真实文件；脚本只读取文件，并会创建和清理临时项目。较大的 PDF 会获得 300 秒的异步校验等待预算。

设置 `TEST_LARGE_PDF=1` 可额外验证 80 MiB、100 MiB PDF 上传并完成深度校验，以及 100 MiB + 1 字节文件被拒绝；使用合成文件和临时项目，需要预留足够的内存与临时磁盘空间。将 `PB_URL` 指向前端 Nginx 地址可同时验证代理限制。

上传服务输出单行 JSON 结构化日志，包含 `request_id`、项目/作业/文件标识、哈希、计数、耗时和稳定错误码。可使用 `docker compose logs -f backend` 查看，并用响应头 `X-Request-ID` 关联一次请求的接收、排队、处理和终态事件。

## 常见问题

### Docker Compose 启动后访问不到前端

默认 `docker-compose.yml` 将生产前端发布到 `http://localhost:8080`，可通过 `FRONTEND_PORT` 修改端口。开发模式前端地址是 `http://localhost:5250`；Traefik 模式不发布宿主机端口，需确认 `TRAEFIK_HOST`、external network 和 Traefik router 状态。

可先检查容器状态和日志：

```bash
docker compose ps
docker compose logs -f frontend
# Traefik 模式：
docker compose -f docker-compose.traefik.yml ps
docker compose -f docker-compose.traefik.yml logs -f frontend
```

### 后端启动后没有业务表

确认 PocketBase 启动目录包含：

- `backend/pb_migrations/`
- `backend/pb_hooks/`

迁移只会执行一次。如果已用旧数据启动过，并确认不需要旧数据：默认本地目录模式可清空 `./pb_data` 后重新启动；如果叠加 `docker-compose.named-volume.yml`，则可用 `docker compose -f docker-compose.yml -f docker-compose.named-volume.yml down -v` 删除对应 named volume 后重新启动。

### 首次 Docker 部署后端报 `_collections` 不存在

这是 PocketBase 数据库没有完成初始化时读取 collections 造成的。当前 Dockerfile 会固定在 `/pb` 启动，并将数据库写入 `/pb/pb_data`，确保数据卷、迁移和 hooks 使用同一目录。

如果曾经用旧镜像首次启动失败，并且确认没有需要保留的数据，可清理旧数据后重新构建。

默认本地目录模式：

```bash
docker compose down
rm -rf pb_data/*
docker compose up --build
```

如果叠加 `docker-compose.named-volume.yml`：

```bash
docker compose -f docker-compose.yml -f docker-compose.named-volume.yml down -v
docker compose -f docker-compose.yml -f docker-compose.named-volume.yml up --build
```

### 注册后不能创建或进入项目

这是预期行为。公开注册用户会被后端 hook 固定为 `user`，既没有平台权限，也没有任何项目身份。Docker 首次启动可通过 `APP_ADMIN_EMAIL`、`APP_ADMIN_PASSWORD` 创建平台管理员；由平台管理员开放创建白名单，由项目所有者或管理员分配项目职责。不要通过 PocketBase Admin UI 直接写项目成员关系，以免绕过 ACL 同步。

### CSV 导入提示缺少 PDF页码

请确认表头中包含且仅包含一个受支持的页码字段：`PDF页码`、`page`、`pdf_page` 或 `页码`。`PDF 页码`（中间带空格）不受支持。推荐保存为 UTF-8 CSV。

### 项目显示暂无可处理

同一校对员每轮只能为同一条目提交一次。如果项目中剩余未完成条目都已经包含你的提交，需要其他校对员继续接取。

### 上传 PDF 后没有自动生成校对条目

当前实现中 PDF 只用于原文预览。请通过 CSV 导入待校对文本条目。

### 个人中心

点击导航头像进入个人中心，可修改当前账号的昵称和邮箱。保存后导航即时更新。邮箱是选填项，修改或清空邮箱会撤销原验证状态；不会修改外部身份的邮箱，也不会改变角色或项目权限。`PATCH /api/fangji/profile` 仅接受当前登录用户的 `name`、`email`，使用 PocketBase 校验邮箱格式和唯一性，保存成功返回新的认证令牌与用户记录，前端同步刷新会话。

### 生僻字与 Unicode 验证

网页字体链包含自托管的 `Fangji Rare Han` 补充字体（思源黑体及遍黑体 OFL 子集）；这是为兼容保留的历史内部资产名，不代表当前产品名称。覆盖源字体包含的扩展 A–J 及兼容汉字，共 82,007 个码位。283 个 WOFF2 分片总计约 13.6 MB，使用精确 `unicode-range` 按需下载；常用汉字/ASCII 页面不请求这些字体。字体声明增加约 24 KB gzip CSS，不预加载整套字体。字体来源、许可证、覆盖清单和可复现构建方式见 [字体说明](frontend/public/fonts/rare-han/README.md)。

UTF-8、SQLite 和 PocketBase 能存储四字节生僻字，不需要 schema 迁移。差异高亮、头像/列表截断及后端仲裁说明按 Unicode 码位处理；输入光标仍使用浏览器规定的 UTF-16 偏移。校对/仲裁中的生僻字补充字体加载失败时显示码位提示，原始内容保持不变。PDF 字形仍取决于原始 PDF。

全链路测试使用 `𢶀𠮷㙟𰻞䲠`，包含扩展字字段名、CSV 预检/导入、Go 入库、JS hooks 校对提交、仲裁/说明、自动通过和 UTF-8 导出。仅对临时数据库执行：

```sh
PB_URL=http://127.0.0.1:18095 \
APP_ADMIN_EMAIL=test-admin@example.com APP_ADMIN_PASSWORD='<test password>' \
PB_SUPER_EMAIL=test-super@example.com PB_SUPER_PASSWORD='<test password>' \
node backend/tests/rare_characters_integration.mjs
```

脚本默认清理创建的项目和用户；设置 `RARE_BROWSER_FIXTURE=/tmp/fangji-rare-fixture.json` 可保留临时测试数据及认证信息供浏览器后续验收，此文件不能提交。前端单元测试另覆盖差异片段不产生孤立代理码元、键盘插入光标、JSON/CSV 与字体失败提示；Go 测试覆盖 SQLite 持久化读取。

可一键建立全新临时数据库、按部署顺序迁移、执行上述链路、重启后检查持久化并清理：

```sh
python3 backend/tests/run_rare_characters_integration.py
```

该测试已加入 CI 的 `Backend Unicode workflow`。浏览器测试脚本位于 `frontend/scripts/test-rare-fonts.cjs`（Chrome、Firefox、WebKit 字形与失败提示）和 `test-rare-workflow.cjs`（真实编辑/草稿/校对/仲裁/CSV 下载）。可在临时目录安装 Playwright，通过 `NODE_PATH` 指向其 `node_modules`；设置 `FRONTEND_URL`、`SCREENSHOT_DIR`，后者还需要 `RARE_BROWSER_FIXTURE` 指向前述测试保留的临时数据。每次完整浏览器流程需要一套新 fixture。普通 `npm test` 无需安装浏览器。

### 生产容器权限

生产后端以 UID/GID `10001:10001` 运行，根文件系统只读，仅数据卷和 512 MiB 的 `/tmp` 可写；
前端以 Nginx 普通用户运行，容器内端口为 `8080`，本机访问仍为 `http://localhost:8080`。
两个生产入口都移除全部 Linux capabilities，并设置 no-new-privileges。
绑定已有 `pb_data` 时先停止服务，再由宿主机管理员将完整目录的读写权限交给 UID/GID 10001；
例如 Linux 上执行 `sudo chown -R 10001:10001 ./pb_data`。命名卷首次创建会继承镜像内的数据目录权限。
不要通过 `chmod 777` 解决权限问题，也不要在新版 PocketBase 中直接使用不兼容的旧数据目录。

前端为支持运行时 BACKEND_URL 和 Admin UI 配置，需要写静态资源、Nginx snippets/conf.d 及缓存目录，
因此未设整个前端根文件系统只读；其他目录仍归 root 所有。开发镜像保留现有开发用户行为。
Traefik 的 TLS router 增加一年 HSTS，关闭强制 HTTP HSTS；本机 HTTP 入口不发送 HSTS。
当前 Traefik Admin UI 默认开启是既有维护入口策略，正式运营应显式设置 `ENABLE_POCKETBASE_ADMIN_UI=false`。

## 许可证

除文件或目录另有说明外，本仓库中由 e-dialect 有权授权的原创软件代码采用
[GNU Affero General Public License 第 3 版且仅该版本（AGPL-3.0-only）](LICENSE)。
第三方组件继续适用其路径级许可证和版权声明；软件许可证不自动覆盖导入的 PDF、
词典、语料、校勘项目、用户内容、录音、数据集、模型权重、商标、Logo 或生成导出物。
完整边界见 [LICENSING.md](LICENSING.md) 和
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)，资产与运行时边界见
[ASSET_BOUNDARIES.md](ASSET_BOUNDARIES.md)。

品牌整合前的旧版方辑源码快照 [`fangji-v1.0.0`](https://github.com/e-dialect/wanyu-proofreader/releases/tag/fangji-v1.0.0)
继续适用其发布时所附条款。替代商业许可仅能覆盖北京塔聚科技有限责任公司拥有或已获充分授权的权利，
不构成对仓库内全部历史贡献、第三方内容或用户资产的重新授权。

## 小内存服务器构建

后端镜像在构建阶段通过 `GOMAXPROCS=1` 和 `GOFLAGS=-p=1` 限制 Go 执行并行度和包构建并行度，前端构建 Node 堆上限为 768 MiB；测试仍在镜像构建中执行。运行容器的资源限制不会限制镜像构建，需要另行配置受限 BuildKit。

edialect 部署主机使用当前选中的 edialect-bounded 构建器（1280 MiB 内存、内存和 swap 合计 2304 MiB、1 核 CPU、一个构建步骤）以及 2 GiB 主机 swap。上线前确认 docker buildx ls 的选中项正确，且没有 BUILDX_BUILDER 环境变量覆盖它，再执行 docker compose -f docker-compose.traefik.yml up --build -d。其他主机需按实际容量配置自己的构建器。

主机的安装、资源保护、验收证据及回滚说明见 /home/edialect/infra/managed/RESOURCE_FIX.md。
