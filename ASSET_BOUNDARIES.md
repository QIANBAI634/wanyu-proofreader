# Asset and Data Boundaries / 资产与数据边界

The root AGPL declaration applies only to original software code that
e-dialect is authorized to license. It does not grant rights to material merely
because that material is uploaded to, stored by, exported from, or bundled
beside the application.

| Path or material | Boundary |
|---|---|
| Original application code, tests, migrations, hooks, and configuration authored for this repository | Software license in [`LICENSE`](./LICENSE), subject to authorship and path-level exceptions |
| `frontend/public/pdfjs/**` | Third-party PDF.js distribution and path-level notices; see [`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md) |
| `frontend/public/fonts/**` | Third-party font software and subsets under their adjacent OFL notices; names and subsets do not transfer copyright |
| `docs/**/*.png`, other documentation screenshots, and `frontend/public/favicon.svg` | Documentation and visual/brand assets; no additional media or trademark license is granted unless an adjacent notice says otherwise |
| Synthetic test fixtures | Test code/data only; they must not contain production documents, accounts, or real personal data |
| Imported PDFs/CSV, dictionaries, corpora, proofreading projects, annotations, and user content | User/operator assets; not licensed by the repository software license and require their own lawful source and terms |
| PocketBase runtime data, `pb_data`, backups, caches, and logs | Operational data; excluded from the repository software license and subject to access, retention, privacy, and security controls |
| Review bundles and generated exports | No automatic new license; rights depend on their inputs, contributors, contracts, and applicable data terms |
| Recordings, voice samples, model weights, and generated audio/data | Require separate speaker/voice, model, data, and output-rights review |
| `乡声万语`, `万语校坊`, historical `方辑` branding, logos, and visual brand assets | No trademark or brand permission is granted by the software license |

Moving an external asset into this repository does not change its ownership or
license. A future data, document, media, or voice contribution must identify
source, provenance, consent where relevant, and an explicit asset/data
agreement. The code CLA is not a substitute for those permissions.

## Third-party registration / 第三方登记判据

Third-party registration follows distribution, not a directory allowlist.
Release artifacts here include project deliveries and runtime images built from
the deployment configuration. The manual register in
[`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md) covers separately bundled
assets, binaries, and model files, plus independent CLI tools or libraries added
to runtime images for specific features. Go/npm dependency trees and base-image
system packages are tracked through dependency manifests and upstream package
metadata rather than individually duplicated in this manual register. Those
records do not replace license notices or release-time compliance review.
A CLI installed separately by an operator, used only as an external tool, and
not shipped with the repository or an artifact does not require a manual entry
merely because the application invokes it.
Installing that same CLI into a distributed runtime image changes the decision.

- **随仓库或发布物分发的第三方组件须登记**：本节的发布物包括项目交付的压缩包、
  可执行文件及镜像，也包括按本仓部署配置构建的运行镜像。无论组件位于前端、后端、
  其他目录，还是构建时下载后装入产物，都按下述登记载体记录，并保留适用的上游
  声明。是否 vendored、是否开源或是否通过 CLI 调用，均不能单独替代分发判据；
  目录表是现有材料的边界说明，不是永久白名单。
- **登记载体分工**：[`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md) 是手工
  清单，覆盖单独捆绑交付的第三方资产、二进制和模型文件，以及为具体功能额外装入
  运行镜像的独立 CLI 或库（如页图预览用的 Poppler/libwebp）。按组件的适用字段记录
  来源、版本、版权、许可证及本地修改；版本随镜像构建解析时，注明发行版/包来源，
  实际版本以该构建的包元数据为准。应用自身的 Go/npm 依赖树通过 `backend/go.mod`、
  `backend/go.sum`、`frontend/package.json`、`frontend/package-lock.json` 追踪；基础
  镜像及通用系统包（如 `curl`、`ca-certificates`）通过 Dockerfile 的镜像/包声明及
  上游发行版包元数据追踪，不逐项重复写入手工清单。这是登记载体的分工，不免除
  许可证义务：锁文件不替代版权和许可声明，分发者仍须针对实际产物核对并保留
  适用声明、履行相应义务；操作者自行构建后再分发时也须进行该核对。
- **系统级外部工具通常不登记**：由操作者在运行机器上独立、按需安装，且不随仓库或
  发布物分发的 CLI，不因脚本调用而进入第三方分发清单。仍须在使用文档中说明安装
  依赖及适用条款；日后改为捆绑分发时重新判定，并履行相应许可证义务。
- **模型与服务另有权利审查**：OCR 模型文件随仓或随发布物分发时同样须登记，模型
  代码的许可证不自动覆盖权重、训练数据或输出。操作者另行获取的模型仍须独立确认
  来源与使用权利。仅调用云 API 不等于分发其实现或模型，不因此登记到第三方分发
  清单；服务条款、语料处理权限与数据出境仍须单独确认。

| 判定示例 | 是否登记到 `THIRD_PARTY_NOTICES.md` |
|---|---|
| 将第三方 OCR 可执行文件 vendored 到 `backend/tools/` 并随仓库分发（假设示例），或为具体功能将独立 CLI 装入后端运行镜像（现有 Poppler 即属此类） | 须登记到手工清单；后端路径或系统包安装方式不构成豁免 |
| 将 Tesseract 的 `chi_sim.traineddata` 放入项目任意目录或发布镜像（假设示例） | 须登记该模型文件的具体来源、版本和适用许可证，不能仅沿用引擎代码许可证 |
| 在独立机器上运行 `ocr/extract_text.py`，调用操作者按需另行安装、未随脚本捆绑分发的 Poppler `pdftotext`（部署方式示例） | 不因该调用登记；本项目后端镜像另行分发 Poppler 的情形则须登记，见下方核对 |

### OCR 工具链与页图预览依赖核对（#245）

本次核对基于 2026-10-04 的主分支 `da1e9eb`：`THIRD_PARTY_NOTICES.md` 已登记随仓
分发的 PDF.js、CMaps、标准字体及两组字体子集，以及后端运行镜像为页图预览分发的
Poppler（`poppler-utils`）和 libwebp（`libwebp-tools`），应全部保留。
[`backend/Dockerfile`](./backend/Dockerfile) 安装这两个包，即使它们以外部命令方式
调用，也属于随发布镜像分发。`ocr/` 只含脚本与文档，没有捆绑 OCR 引擎二进制或模型
文件；独立运行 `extract_text.py` 时另行安装的 `pdftotext` 不因脚本调用额外登记。
本次仅核对 OCR 工具链、页图预览用的 Poppler/libwebp 及现有手工清单条目的保留，
在该范围内无需补登或删项；这不表示已完成 Go/npm 依赖树或基础镜像系统包的全量
许可审计。上面的 OCR 二进制和模型例子是未来分发方案的判定示例，不表示当前已
包含这些组件；后续发布物改变时须重新核对。

---

根 AGPL 声明只覆盖 e-dialect 有权授权的原创软件代码。文档、语料、词典、录音、标注、
用户内容、运行数据库、模型、生成物或品牌资产不会因为被软件上传、存储、导出或与软件
一同放置就自动获得代码许可证。相关材料须分别确认来源、权利、同意、隐私与适用条款；
代码 ICLA 不能代替数据、媒体、说话人或声音合成授权。
