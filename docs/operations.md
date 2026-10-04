# 单机运维与恢复

使用单实例 PocketBase/SQLite。正式启用前按以下步骤演练，记录版本、耗时和结果。

## 备份与恢复

目标 RPO 为 24 小时，目标 RTO 为 60 分钟；这是初始目标，实际应按数据量测量。
每日低流量窗口停写备份，升级前额外备份；保留 7 份日备份、4 份周备份和 6 份月备份。
备份目录包含全部数据库、WAL/SHM（若存在）、上传文件及其他 pb_data 元数据。
不要只复制 data.db，也不要在线逐个复制数据库和文件。

```sh
docker compose stop frontend backend
python3 backend/ops/backup.py backup ./pb_data /secure-backups/fangji-20260909 \
  --version "$(docker inspect -f '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "$(docker compose ps -q backend)")" --application-stopped
docker compose start backend frontend
```

后端镜像在构建时注入 `VERSION`/`COMMIT`/`BUILD_DATE`，同时写入 OCI 标签
`org.opencontainers.image.revision`，因此备份记录可以直接从镜像读取，不必手工誊抄；
容器启动日志第一行 `fangji backend <version> (commit <sha>, built <date>)` 可作为交叉核对。
由 Compose 直接构建时使用 `FANGJI_VERSION`/`FANGJI_COMMIT`/`FANGJI_BUILD_DATE` 传入，
CI 的镜像构建与 `make docker-build` 已自动传入。未传入时记为 `dev`/`unknown`，
`scripts/check_compose_structure.py` 会在巡检输出里提示这一点——它就是需要纠正的配置信号。
每日存储巡检见下文「存储巡检与告警」：`ops/audit_storage.py` 只读不删，超预算或非零退出。

工具拒绝已存在的备份目录、软链接及放在源目录内的备份，复制前后检查文件哈希，
验证 SQLite 完整性并记录版本。`--application-stopped` 是操作者对已停写的确认，
工具不能独立判断容器是否停止，文件变化检测也不能替代停写。
named volume 部署需先停止服务，再将卷内容完整复制到离线目录后运行同一命令。
备份成功后传到加密的异地存储，上传完成后验证 manifest；生产数据不得放入 Git。
每日调度应在任何命令非零退出、24 小时无新备份或异地校验失败时通知维护者。
异地存储目标和通知渠道由部署者配置，仓库不预置凭据或发送通知。

恢复到全新路径，保留当前目录供排查：

```sh
docker compose stop frontend backend
python3 backend/ops/backup.py restore /secure-backups/fangji-20260909 ./pb_data-restored
# 验证输出版本与将要运行的镜像匹配；将 Compose 数据挂载切换到恢复目录。
# 确认容器用户能读写该目录后，启动 backend 和 frontend。
```

工具检查完整清单、SHA-256 和 SQLite integrity_check，不覆盖现有目标目录。
启动后检查 `/healthz` 和 `/api/health`，管理员登录、项目/条目数、PDF 打开、
领取/提交、仲裁、CSV 导出，并对比备份前文件哈希。每季度和重要版本升级前重复演练。

## 存储巡检与告警

`ops/audit_storage.py` 是只读巡检：统计 `pb_data` 总体积、磁盘剩余水位、PDF 预览缓存
与上传暂存残留，超过 `--budget` 或剩余空间不足时**非零退出**，但不删任何文件——裁剪
始终由人决定。生产 `pb_data` 不在 CI runner 上，公共 `schedule:` workflow 看不到它，
所以这条接线落在部署侧，由下面的 cron 或 systemd timer 二选一驱动。

把下面脚本存为 `/usr/local/bin/fangji-storage-audit.sh`（`chmod 0755`），按部署实际改
开头的几个变量；它负责留档、按退出码告警，并保留只读语义：

```sh
#!/usr/bin/env bash
# 每日存储巡检；只读，不删任何文件。
set -uo pipefail

REPO=/opt/fangji                       # 仓库或部署根目录
DATA_DIR="$REPO/pb_data"               # 生产数据目录；named volume 部署改成其挂载点
LOG_DIR=/var/log/fangji                # 留档目录，先 mkdir 并授权运行用户可写
JSONL="$LOG_DIR/storage-audit.jsonl"   # 按天追加一行，用于回看增长趋势
BUDGET=$((2 * 1024 * 1024 * 1024))     # 脚本默认值，仅适合几乎无存量 PDF 的实例；取值见下
ALERT_EMAIL=ops@example.com            # 告警落点；换成实际值班邮箱，或改成 webhook 封装

cd "$REPO"
OUT="$(python3 ops/audit_storage.py --data-dir "$DATA_DIR" --budget "$BUDGET" --json)"
RC=$?

# 留档：把整份 JSON 压成一行再追加，保证 JSONL 每条记录占且仅占一行（audit_storage.py
# 的 --json 是 indent=2 的多行输出，直接追加会破坏 JSONL）。这样能 grep/绘图看积压增长，
# 而不是只知道“今天超限”。按日志保留策略（参见「日志与升级」的 30 天口径）轮转该文件。
printf '%s' "$OUT" | python3 -c '
import json, sys, time
audit = json.load(sys.stdin)
record = {"ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
          "rc": int(sys.argv[1]), "audit": audit}
print(json.dumps(record, ensure_ascii=False))
' "$RC" >> "$JSONL"

# 退出码到告警：只有非零才发（超预算、磁盘水位不足，以及巡检自己没跑起来的 rc=2），
# 正常时不发信，避免噪声淹没真实信号。
# 这里用 mail(1)，需本机有 MTA；走 webhook 时换成对应的 curl 调用即可。
if [ "$RC" -ne 0 ]; then
  printf 'fangji storage audit FAILED (rc=%d) on %s\n\n%s\n' "$RC" "$(hostname)" "$OUT" \
    | mail -s "[fangji] storage audit alert" "$ALERT_EMAIL"
fi
exit "$RC"
```

`--budget` 是整个 `pb_data` 的水位，而这份瞬时开销有两处、各有 1 GiB 口径：「PDF 分块
上传」一节的全局 1 GiB 上传暂存，以及 `docs/task-pdf-cache.md` 里预览缓存的总预算
1 GiB——两个目录都在 `pb_data` 下，也正是 `audit_storage.py` 的 `TTLs` 在盯的那两项。
所以取值要覆盖「两份瞬时预算 + 常态持久数据（`storage/` 与 `data.db`）」，脚本默认的
2 GiB 只适用于几乎没有存量 PDF 的实例；先按当前实测体积再留余量确定 `BUDGET`。抬高
预算前先看容量：磁盘剩余不足是按 `max(budget, 1 GiB)` 判定 `error` 的。脚本在达到预算
80% 时报 `warn`、超过时报 `error`（非零退出）；改了这两处口径就同步改这里。

调度二选一。cron（`/etc/cron.d/fangji-storage-audit`，以能读 `pb_data` 的非特权用户运行）；
stdout/stderr 必须落盘，脚本里唯一能区分「真的超预算」和「工具压根没跑起来」的信息就在
stderr，丢进 `/dev/null` 就再也查不到了：

```cron
# 每日 03:30 低流量窗口巡检；字段依次为 分 时 日 月 周 用户 命令
30 3 * * * fangji /usr/local/bin/fangji-storage-audit.sh >> /var/log/fangji/storage-audit.log 2>&1
```

该日志与 JSONL 同样按「日志与升级」的 30 天口径轮转。

或 systemd timer（`Persistent=true` 会补跑关机期间错过的巡检）：

```ini
# /etc/systemd/system/fangji-storage-audit.service
[Unit]
Description=fangji daily read-only storage audit

[Service]
Type=oneshot
User=fangji
WorkingDirectory=/opt/fangji
ExecStart=/usr/local/bin/fangji-storage-audit.sh
```

```ini
# /etc/systemd/system/fangji-storage-audit.timer
[Unit]
Description=Run the fangji storage audit daily

[Timer]
OnCalendar=*-*-* 03:30:00
Persistent=true
RandomizedDelaySec=15m

[Install]
WantedBy=timers.target
```

启用：`systemctl enable --now fangji-storage-audit.timer`，`systemctl list-timers` 核对下次触发。

**谁看这个告警**：与「备份与恢复」里每日调度失败时通知的维护者是同一人/同一值班渠道，
归到 [#131](https://github.com/e-dialect/wanyu-proofreader/issues/131) 的运维基线统一认领，
不要变成无人认领的脚本。收到非零告警后先看退出码，两个信号就够分清是哪一类问题：

- `rc=1` 是巡检判定超限或磁盘水位不足，属容量问题；
- `rc=2` 是巡检**根本没跑起来**——特征是当天 JSONL 没有记录、邮件正文里没有 JSON，
  原因在 cron 的 `storage-audit.log` 或 `journalctl -u fangji-storage-audit.service`
  捕获的 stderr 里（形如 `can't open file .../ops/audit_storage.py`），通常是 `REPO`
  或 `DATA_DIR` 路径写错、仓库没 checkout、Python 缺失，与容量无关。

确认是巡检跑出来的结果之后，再看 JSONL 趋势判断是稳态超限还是突增，用 `--json` 输出里的
`largest` 与缓存/暂存条目定位，确认后手动裁剪——巡检本身不会删文件。

## TLS、网络与管理入口

公网 TLS 在 Traefik 终止；只将 frontend 接入代理网络，backend 不发布公网端口。
按实际代理网段配置 TRUSTED_PROXY_CIDRS；外部伪造转发头不得成为限速身份。
仅 HTTPS 的 Traefik router 应设置 HSTS，不能在本机 HTTP 模式强制 HSTS。
当前本机 Compose 默认关闭 Admin UI；Traefik 入口为维护便利默认开启，
正式运营须显式 `ENABLE_POCKETBASE_ADMIN_UI=false`，需要维护时结合 VPN/IP 白名单临时开放。
健康检查和启动依赖已在 Compose 配置。PDF 最大 100 MiB，Nginx 请求上限 101 MiB，
异步校验可能持续数分钟；realtime 连接读取超时为 3600 秒。

## 日志与升级

应用和 Nginx 写 stdout/stderr，使用 `docker compose logs` 查看；生产 Compose
配置 Docker 日志轮转，每个容器最多 5 个 10 MB 文件。按需将脱敏日志集中保存 30 天。
不得记录密码、认证头、token、口令、完整 CSV/PDF 正文；审计记录保留操作者 ID、
资源 ID、时间、操作结果和 request_id。备份/恢复工具仅输出版本和文件数。

升级前确认 CI、阻断评审、镜像 digest、配置差异及迁移说明；停写备份，
先用备份副本演练新版本，再切换正式服务并完成上述烟雾检查。
失败时停止新服务，恢复旧镜像及升级前整目录备份；不能用旧程序直接打开新版本已迁移的数据。

## 本次演练边界

自动测试创建包含扩展汉字/音标的 SQLite 记录及 PDF/CSV 文件，完整备份后恢复到新目录，
验证数据库记录和全部文件 SHA-256 一致；损坏备份、软链接及覆盖现有数据均被拒绝。
这是可重复的离线工具演练，不等同于实际服务器的容量、异地传输及通知链路验收。
部署者仍须测量实际 RPO/RTO，验证容器非 root/最小权限和异地恢复。

## PDF 分块上传

用户仍选择一份不超过 100 MiB 的完整 PDF。浏览器按 1 MiB 顺序传输，显示整体
进度并可取消；网络错误、408/429/5xx 最多重试三次（1、2、4 秒退避）。已完成
分片不会因后续失败而重传。浏览器用 Blob.slice 截取字节，无需解析或手动拆分 PDF。

接口位于 `/api/fangji/projects/{projectId}/pdf-uploads`：POST 创建或恢复会话，
GET 列出当前用户未完成会话，GET `/{id}` 查看已收分片，
PUT `/{id}/chunks/{index}` 提交分片，POST `/{id}/complete` 完成，DELETE `/{id}`
取消。每次核对登录用户和项目管理权限。创建请求携带整文件 SHA-256
`contentHash` 与客户端随机 requestId：刷新或重开后重新选择同一 PDF 会按内容哈希
恢复已收分片，不能只靠文件名和大小匹配。相同分片返回成功，内容冲突返回 409。
完成时校验分片哈希、总长度、PDF 头及声明的文件身份，按顺序拼接后进入既有深度
校验队列；重复完成返回同一文件记录。合并落库使用由会话派生的记录 ID，服务重启
后重试完成不会新建第二条记录。

每用户一个进行中会话，全局最多四个。按每文件两倍大小预留临时预算（全局
1 GiB），私有目录为 `pb_data/pdf-upload-staging-v1`，目录 0700、文件 0600，
会话元数据写在 `meta.json`。取消立即删除分片，闲置一小时后由每分钟清理任务回收；
重启会从磁盘恢复未过期会话并删除无效残留。完成结果保留到会话过期，支持网络
响应丢失后的幂等重试。项目详情页展示可恢复上传、重新选择同一文件、过期和放弃。

正常上传无需调整共享 Traefik：60 秒限制作用于每个分片请求，而非整本书的
累计传输时间。极慢到单个 1 MiB 分片也超过入口超时的网络仍可能失败；此时
可使用下述可选部署排障设置。旧整文件 API 保留供现有客户端兼容使用。

验证（临时数据库，不连接生产）：

```sh
go test -C backend ./...
FANGJI_SLOW_UPLOAD=1 python3 backend/tests/run_integration.py pdf_chunks_integration.mjs
npm --prefix frontend test
npm --prefix frontend run build
# 已安装 Playwright Chromium 后运行；macOS 可设置 BROWSER_CHANNEL=chrome。
PDF_UPLOAD_BROWSER_SCRIPT="$PWD/backend/tests/pdf_upload_browser.cjs" \
PDF_BROWSER_FIXTURE=/tmp/fangji-upload-browser-fixture.json \
python3 backend/tests/run_integration.py pdf_chunks_integration.mjs
```

慢网测试使完整 HTTP 流程超过 60 秒并校验原件字节完全一致，未模拟生产 Traefik。
浏览器回归模拟分片 503 和完成响应丢失，确认自动重试只创建一条 ready 文件记录。
Go/前端测试另覆盖重复与冲突分片、取消、超限、权限撤销、重启和闲置清理。
浏览器 fixture 只包含一次性测试凭据，不得提交生产凭据。

## 可选排障：旧整文件上传在 60 秒附近失败

100 MiB 的容量上限不代表允许传输足够久。Traefik 的入口
`transport.respondingTimeouts.readTimeout` 默认 60 秒，计时包含整个请求体。
慢速上传会在到达 PocketBase 前断开；Nginx 常记录空响应的 400，后端没有对应
`upload_received`。同一文件重试若恰好在 60 秒以内传完就会成功。

确需放宽入口超时时，可在 **Traefik 自身的静态配置**中保留其他设置并合入：

```yaml
entryPoints:
  websecure:
    transport:
      respondingTimeouts:
        readTimeout: 600s
```

JSON 部署可生成待审查文件（不要将输出重定向到输入文件）：

```sh
python3 ops/prepare_upload_timeout.py /path/to/traefik.json > /tmp/traefik-upload.json
diff -u /path/to/traefik.json /tmp/traefik-upload.json
```

备份原配置后替换为生成文件，并按基础设施的启动方式重建/重启 Traefik。
如果基础设施有配置生成器，同时修改生成源，避免下次部署覆盖。
这个入口可能由多个站点共享，变更会允许它们的上传连接占用至多 10 分钟；
不使用无限超时。回滚为备份文件并重启 Traefik 即可，无数据库迁移。
仅重建万语校坊容器或设置 router 的 `serversTransport` **不能**改变入口读取超时。

验证：在测试项目以约 1 MiB/s 上传一份 80 MiB PDF，确认耗时超过 60 秒仍返回
202，随后文件状态为 ready；并验证超限文件仍返回 413、无权限用户仍被拒绝。
部署后的日志应同时出现 Nginx 202 和后端 upload_accepted/pdf_ready。
生产故障证据：首次约 60 秒中断且后端无记录，第二次约 55 秒传输成功；
校验本身不到一秒。无需重复上传来“预热”PDF 校验器。

参考：[Traefik 入口 respondingTimeouts](https://doc.traefik.io/traefik/v3.3/routing/entrypoints/#respondingtimeouts)。

## 规则门控放行与降档（#228）

`assist_rule_gates` 决定机器疑点要不要下发给校对员。缺行按 `off` 处理，即**一条都不给**；
这张表没有任何自动写入方——档位变化只能由平台管理员按下面的步骤人工应用。

打分前有一个前提，它出错时的症状是「报告能出、数字全空、界面一切正常」：

- **弱标注需要真实提交记录。** 标签来自 `pages.proofread_row_json` 与各次
  `proofreading_attempts.row_json` 的字段级对齐（`scripts/assist/weak_labels.mjs`），
  没人提交过就是 0 条样本、全表 `n/a`、全规则 `off`。那是**证据不足**而不是**精度不足**，
  两者处置不同（门槛文件 §3）：前者等证据或改抽检口径，后者才考虑关规则。
  2026-10-02 用正本 15,022 行跑的首轮就是这个样子：疑点 31,876 条，样本 0 条。

另一个容易读错的地方：`GET/PUT /api/fangji/projects/{id}/column-roles` 返回的视图是拿**表头**
（第一条条目的列名）对照的，所以项目还没有条目时，每列都会显示 `present: false`、全部列名进
`stale`。那不是"你标错了"，也不是 R5 不产的原因——规则引擎用的是 `column_roles_json` 这份存储映射
配**每行自己的列名**（`lib/column_roles.js` 的 `rolesForRules`），导入前标一样生效。
`stale` 真正的含义是"这些名字在当前表头里找不到"，导入完成后它会自己清空。

判据（`strong` 需 p̂ ≥ 0.90 且 n ≥ 100；`warn` 需 p̂ ≥ 0.60 且 n ≥ 150）的唯一代码出处是
`backend/pb_hooks/lib/gate_release.js`，打分器与写入侧共用同一份常数；口径的文档出处是
`docs/plans/2026-09-25-assist-rule-thresholds.md` §2/§5。改判据要同时改这两处。

1. **打分**（全程只读，不写库）：

   ```bash
   node scripts/assist/score_rules.mjs --db <部署库的只读副本> --json /tmp/score.json
   ```

2. **产出待评审变更集**（同样不写库；`--approved-by` 必填，因为它要落进每条记录）：

   ```bash
   node scripts/assist/gate_changeset.mjs --score /tmp/score.json \
     --approved-by "<人名/邮箱>" --report docs/plans/gate-changeset-<date>.md \
     --out /tmp/gate-changeset-<date>.json
   ```

   变更集把「建议放行」与「保持 off（逐条给理由）」分两栏列出；不在变更集里的规则保持 off。
   **评审这一步不能省**：文件应当作为 PR diff 或 `docs/plans/` 里的产物留下，
   而不是直接在命令行里生成就应用。

3. **应用**（平台管理员身份；判据不满足的条目逐条拒绝，不整批失败）：

   ```bash
   curl -X POST "$PB_URL/api/fangji/gates/changeset" \
     -H "Authorization: $PLATFORM_ADMIN_TOKEN" -H 'Content-Type: application/json' \
     -d @/tmp/gate-changeset-<date>.json
   ```

   返回 `{applied, unchanged, refused, locked, entries[]}`；`refused` 非零要逐条看理由，
   不要重发一份把判据改小的变更集来"绕过去"。

4. **验证生效**：`GET /api/fangji/gates` 看档位与 `approved_by`/`changeset`/`applied_by`；
   管理端 `GET /api/fangji/projects/{id}/findings` 里对应疑点的 `gate` 与判据数字同步；
   校对端 `GET /api/fangji/pages/{id}/findings` 应出现 hint，且 `suppressed_by_gate` 下降。

5. **降档（kill switch）**：

   ```bash
   curl -X POST "$PB_URL/api/fangji/gates/revoke" \
     -H "Authorization: $PLATFORM_ADMIN_TOKEN" -H 'Content-Type: application/json' \
     -d '{"producer":"rule","producer_version":"l0-v1","kind":"missing_field","message_key":"required_role_field_empty","note":"误报复核中"}'
   ```

   幂等：重复撤销不产生新状态。**降档后重放同一份变更集不会把它抬回去**（返回 `locked`）——
   要恢复必须显式 `{"restore": true}` 清除降档标记，再发一份**新的**变更集。
   `restore` 只清标记、不改档位，所以这里不存在绕过判据的第二条升档路径。

注意：`assist_rule_gates` 读取上限是 `MAX_GATE_ROWS = 2000`，超出部分静默按 `off` 处理。
`GET /api/fangji/gates?limit=N` 的 `truncated`、以及两个 findings 接口的
`gate_rows_truncated` 是这一情况的唯一可观测出口；巡检时确认表行数远离上限，
接近时要么清理，要么把上限连同这条纪律一起改。


## AI 辅助校对的验收怎么跑

链路是否"在校对流程里真的起作用"，看两支东西，不必靠人眼看截图：

```bash
# 端到端：导入 → 重算 → 门控挡住 → 人工放行 → 命中区间切回原文 → 降档 → 大厅对账
python3 backend/tests/run_integration.py assist_chain_integration.mjs
```

它跑在一次性的真 PocketBase 上（`run_integration.py` 负责建库、起服务、清理），
断言顺序就是链路顺序，所以任何一段断掉都会指出是哪一段。

```bash
# 界面证据：管理端各态 + 大厅层级条 + 校对端放行前后
VITE_PB_URL=http://localhost npm --prefix frontend run build
BROWSER_CHANNEL=chrome \
  NODE_PATH="/tmp/assist-browser/node_modules" \
  ASSIST_BROWSER_SCRIPT="$PWD/backend/tests/assist_browser.cjs" \
  python3 backend/tests/run_integration.py assist_browser_integration.mjs
```

`BROWSER_CHANNEL` 与 `NODE_PATH` 是**本地才需要**的：CI 由 `assist-browser` 作业自己装 playwright。
本机这两个变量各挡一个真实的坑——不指定 channel 时 playwright 会找它自己那个构建号的
chromium（`Executable doesn't exist`），而 `NODE_PATH` 必须指向**真的装着 playwright 的那份**
node_modules（`npm root -g` 里未必有，指向它会 `Cannot find module`）。
跑成功的判据不是退出码，而是输出里有 `ASSIST BROWSER OK [...]` 这一行，
且方括号里的状态名数量与截图清单一致。

**这一支有个容易骗过人的地方**：没设 `ASSIST_BROWSER_SCRIPT` 时它会打印 SKIP 并以 0 退出。
于是"全套件绿"里可能根本没跑过浏览器（`run_all.py` 现在会把这种情况显式报成 skip，
但看汇总的人仍要知道这个区别）。CI 里由 `assist-browser` 作业负责设变量、
校验每张 PNG 非空并上传构件，所以**要贴证据就去那次构建的构件里取**，
不要从本地某次"其实跳过了"的运行里取。

正本规模的复现命令见上面「规则门控放行与降档」的打分/变更集两步；它的产物是报告，
不是界面，两者不要混为一份证据。

同一次运行还会拍出「条目阻塞结论」的三态（#240 验收第 7 条）：
`blocked-conclusion-unset`（库里没有结论，撤销按钮灰着）、
`blocked-conclusion-settled`（**由界面上的表单**写入，回读串带齐 who/when/basis，
且层级当场落 C）、`blocked-conclusion-no-permission`（项目管理员看得到「机器疑点」
但看不到这一节，同时接口对他是真 403）。第二张必须是点出来的而不是夹具预置的，
否则它证明的只是"前端会渲染一行字"。
