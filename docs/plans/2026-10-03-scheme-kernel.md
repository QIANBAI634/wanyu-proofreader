# 拼音方案归一化引擎（#189 内核）

本文件说明 `backend/scheme/` 的流水线、数据形状、加载器的拒绝面，以及**哪些决定被有意留在引擎之外**。

一句话定位：这是一个**没有装真实规则**的转换内核。**目标端**的清单已经有了——`data/hinghwa_canonical.json` 是目标方案 `puxian-xiangyin`（页面定名「莆仙话拼音」，社群内亦称「莆仙乡音社拼音」；口径：莆田城里口音）的声母 15 / 韵母 44 / 声调 7，含逐条 IPA、例字与出处，由 `LoadScheme` 加载校验；**源端**仍然没有：每本书凡例写的符号与它自己的 IPA 要逐本登记，在此之前往 `segment_map` 里填任何一条对应表都等于凭空推断，正是 #114 §7 与 #189 非目标禁止的事。本包交付的是 #189 点名的结构、状态机与门槛，规则是数据，材料已有的那半已经落地。

## 流水线

`Convert(input, adapter)` 走 #114 §6 的六级，每一级都在 `convert.go` 里单独可测。表里第 5 级同时写明了**它在代码里的实际查表时机**——两者故意不一致，理由与补偿机制都写在那一行，不留给读者猜：

| 级（§6 编号） | 做什么 | 失败时的状态 |
| --- | --- | --- |
| 1 Unicode 规范化 | 只做 NFC。不做 NFD/NFKC——那会把 `ɑ` 与 `a`、预组合鼻化与裸附标之间的区别抹掉 | — |
| 2 音节解析 | 声母/韵母/声调三段，最长匹配优先，顺序固定不依赖 map 遍历 | `UNSUPPORTED` |
| 3 分段映射 | `segment_map` 逐段查；命中一对多即停 | `AMBIGUOUS` |
| 4 上下文规则 | 只在指定邻接下改写，用于凡例三.2 那类「一个字符串两层音系」。邻接必须至少写一个、且必须是源清单里真实存在的片段，否则这条规则永不命中——加载即拒 | — |
| 5 例外表 | 整条覆盖，承载人工复核结论（#190 第 4 条的反哺落点）。**查表发生在第 1 级之后、第 2 级之前** | 取其声明状态 |
| 6 目标合法性 | 产出的每一段都必须在目标清单里 | `UNSUPPORTED` |

例外表前置是有意的：人工结论存在的理由恰恰是「前面几级处理不了这个写法」——`sa533` 的声母 `s` 没有任何映射规则，按 §6 的顺序它会在第 3 级就被判 `UNSUPPORTED`，例外永远轮不到（`TestConvertCoversAllFourStatuses` 里那条用例的名字就是这个）。

代价很实在：这条出口绕开了第 2 级的拆解与第 6 级的清单核对，而它偏偏是唯一允许携带 `EXACT`/`REVIEWED` 的出口——下游把这两个状态当作确定值，再也分不出「查过的」和「没查过的」。所以那两道检查没有取消，只是**从运行时搬到加载时**：`LoadAdapter` 用与第 2 级同一个拆解函数（`splitSyllables`），把每一条例外的 `canonical_pronunciation` 对着**目标**清单走一遍，拆不成「一个声母 + 一个韵母 + 正好一个调值」就整文件拒绝。这比第 6 级还严一点：它要求整串消费干净，第 6 级只查各段是否在清单里。

第 2 级有一条硬规矩，与 `scripts/scheme/tone.py` 同源：**一个音节位上的数字串必须正好是一个合法调值**。`533453` 不拆、不猜、不"取最长"，直接判解析失败——字母丢光是损坏，不是留给程序解的题。

## 数据形状

结果就是 #114 §5 那七个字段，不改名不合并：

```
source_scheme_id / source_pronunciation_proofread /
canonical_scheme_id / canonical_pronunciation /
normalization_status / normalization_rule_version / normalization_trace
```

`normalization_status ∈ {EXACT, REVIEWED, AMBIGUOUS, UNSUPPORTED}`。

两条不变式，各有测试钉住：

1. **只有 `EXACT` 与 `REVIEWED` 能带 `canonical_pronunciation`。** `AMBIGUOUS` 带一个猜出来的值，下游就再也分不出它和确定值——所以 `TestDeclinedResultsNeverCarryACanonicalValue` 对每个拒绝用例都断言该字段为空。
2. **`normalization_trace` 必须点名每一条实际生效的规则 ID**，包括触发歧义的那条。#189 要的是"规则升版后能列出受影响记录"，只记 `rule_version` 做不到这件事。
3. **不存在静默失效的规则。** 一条规则要么可能在运行时生效、要么在加载时被拒。第 2 条成立的前提是「进了 trace 的规则就是被查的那条」，而规则文件是手抄数据，最容易出的不是报错而是写一行永不生效的对应关系：同键两行、`part` 拼错、邻接拼错，全都属于这一类。

### 两份数据文件

| 文件 | 是什么 | 谁加载 | 真材料 |
| --- | --- | --- | --- |
| adapter（`testdata/adapter_*.json`，将来的 `data/*.json`） | **源方案**的规则：源清单、目标清单、`segment_map`、`context_rules`、`exceptions` | `LoadAdapter` | ❌ 只有合成件，源端要逐本登记凡例 |
| scheme（`data/hinghwa_canonical.json`） | **目标方案**的清单：每个 notation 的 IPA、例字、出处、取回日期 | `LoadScheme` | ✅ 莆田城里口音一份 |
| 离线侧的 `scripts/scheme/data/tone_notation.json` | 同一目标方案的**登记行**（`schemes.puxian-xiangyin`）：调号集、页面出处、以及指向上一行的 `inventory_file` | `tone.py`（**拒绝**，见下） | ✅ 同一份，不另抄 |

分开的理由是 #114 §7 让转换走 `source notation → documented IPA → target notation`，两端都要记自己的 IPA。源端逐书不同、目标端全场一份；把目标端折进每个 adapter 文件就是同一件事抄 N 份，而抄本正是会各自漂的东西。

第三行的存在要交代清楚，因为它看起来像是在同一个方案上开了两处定义：

- **`tone.py` 会拒绝它，这是设计而不是缺口。** 那套调号 `gi1` 的 `1` 是**调类号**（阴平），与大词典的**调值**同形不同义——同一条理由已经写在 `puxian-wendu` 那一行上。`tone.py` 转换的是语料列，而语料里没有目标方案这一列，所以它对这个方案无话可做。
- **登记行不含第二份调值。** 目标侧合法性检查要的是「调号集 1–7 + 声母 + 韵母」，这三项都在 `data/hinghwa_canonical.json` 里；把 7 个调值在 `tone_notation.json` 再抄一份，只会得到一份 `tone.py` 永远读不到（它 `annotation_system` 就把门关上了）的副本——那正是本仓库在别处明确拒绝的「静默失效」形状。
- **两处是不是同源同版，由测试钉住而不是靠人眼**：`scripts/scheme/test_tone.py` 的 `TargetSchemeTests` 顺着 `inventory_file` 打开引擎那一份，断言两边 `scheme_id` 相同、调号集相同、页面定名与口径都出现在 `basis` 里，并断言登记行确实没有夹带第二份调值。这一根桩照的是 `test_long_tones_agree_with_the_shared_detector_constant` 的先例。

`Scheme` 给出三个接口：`Inventory()` 返回 `Adapter.Canonical` 要的那三个列表；`Pronunciations()` 返回 `part:notation → IPA`（只覆盖声母与韵母；零声母在 `onset:` 下，值是 `∅`）；`Pivot()` 是同一份关系反过来读的 `part:IPA → 若干 notation`，也就是转换真正查表的方向——`source notation → documented IPA → target notation` 的第二个箭头。

**声调不走这两个映射。** 一个调类的调值随来源而变——同一阴平在一本资料里记 533、在另一本里记 544、第三本记 33——拿调值当等值比较的键，后两本都会被判成不支持，而那正是转换该承载的情形。所以 `Tone.Value` 不出现在 `Pronunciations()`/`Pivot()` 里，也没有 `tone:` 键；声调对应是「调号 → 调类 → 调号」，读 `Tones` 的 `Category` 与 `Notation` 两个字段，来源自己的编号由来源自己的说明解释。

**`Pivot()` 的值是列表，不是单个 notation。** 一个 part 里两个 notation 记同一个读音是真实材料里会有的事，此时选哪个是复核员的问题——返回第一个等于把 `AMBIGUOUS` 悄悄变成一个没人核过的 `EXACT`。今天这份清单里每个读音只有一个 notation，那是这份文件的事实，不是加载器的规矩（见下）。

**本包还没把目标端接到 adapter 上**：`Adapter.Canonical` 今天仍从 adapter 文件里读，接过去不改任何规则语义，属于下一步。

`Option.IPA` 记的是机器值，与页面那一格只有一处不同：零声母。页面 IPA 栏原文是展示串「ʔ/不标」——写给读者的二选一，没有哪本书会这样写；拿它当等值比较的落点，源侧标 `ʔ` 的和什么都不标的（页面叫「不标」）两种写法都命不中，整条转换会掉进 `UNSUPPORTED`。所以这一格按本项目的声母类别口径记作统一约定符号 `∅`，页面原文照录在该条 `note` 里，出处与备注仍可逐字对着页面核。这是全文件唯一一处「照抄会出错、所以有说明地归一化」的字段，也就是 `data/hinghwa_canonical.json` 顶部的「派生四」。

本节的口径，以及下面「同音多候选不拒绝加载」「声调按调类走」两条，都出自 `2026-10-07-pinyin-pivot-interchange.md`（本目录内，与 #306 同批入库）。那份文档记录的是维护者访谈后的决定，也写明本轮**不要**什么——`kind: zero`、调值整数数组、`realizations`、独立的 `pivot_profile` 系统——所以它是这几条取舍的出处，而不是本包的转述；本文件只记落地形状。

`ʔ` 的其余出现一律不动。塞尾韵母那 13 条（`ah` = `aʔ`、`oh` = `ɔʔ` …）里的 `ʔ` 是真实音段，不是零声母的另一种写法；来源明确把 `ʔ` 立作独立声母时同样保留，按该来源自己的对应规则处理。零声母的归一化不是全局字符替换。

## 加载器的拒绝面

`LoadAdapter(path)` 只接受显式路径，**没有默认值**（#193/#195 的教训：默认值会把某个人的家目录发布出去）。以下情形一律返回 `ErrInvalidRule` 而不是半生效：

- `schema_version` 不是 1；
- 源方案与目标方案同名；
- 缺 `rule_version`（没有它 trace 无意义）；
- `annotation_system != tone_value`——《文读字汇》的 1–7 是**调类**，与大词典的**调值**同形不同义，字符串层面无法区分，所以必须由登记方声明，程序不猜；
- 规则 ID 重复；某条映射的目标值不在目标清单里；一对多规则同时写了 `to` 与 `candidates`；
- **同一个源片段写了两条规则**（`part`+`from` 相同，含一对一与一对多混用）。运行时按 `part:from` 查表，两行同键必然有一行永不生效、也永不出现在 trace 里——那正是「没人知道它已经死了」的形状，而 #189 要的是反过来：升版时能点名受影响记录；
- 分段规则的 `part` 不是 `onset`/`rime`/`tone`；一对多的 `candidates` 里有目标清单外的值（复核员面对一个根本不该出现的候选）；
- 上下文规则**永远不可能命中**：既没写 `when_onset` 也没写 `when_rime`（引擎没有「无条件改写」这个概念），或写的邻接在源清单里不存在。它与「`rewrites nothing`」是同一个缺陷的两半，过去只拦了后一半。至于 `rewrite_*` 是否在目标清单里，**故意不在这里查**——它只在特定邻接下才触发，静态证不了，留给第 6 级（`testdata/adapter_illegal_rewrite.json` 与 `TestTargetLegalityRejectsAHandBuiltIllegalSyllable` 钉的就是这件事）；
- 例外条目声明了 `AMBIGUOUS`/`UNSUPPORTED`（例外是人工结论，只能断言确定值），或 `REVIEWED` 却没写 `basis`；
- **例外的 `canonical_pronunciation` 拆不成目标方案能拼的音节**（见流水线第 5 级：这条出口在运行时绕开了拆解与合法性两级，只能在这里补回来）；例外条目规范化后撞在同一个源形上（两行只能有一行被查到）；
- 例外条目的键与值都以 NFC 存储。源侧真实材料本就 NFC/NFD 混排，值不规范化就会以手抄的字节形式出门，第 6 级又正好被绕开。

`LoadScheme(path)` 同样只接受显式路径，返回 `ErrInvalidScheme`。除上面同形的几条（`schema_version`、ID 与名称、清单非空）外，目标方案文件另有四条拒绝面（前两条是为「经 IPA 转换」这件事准备的），末尾再记一条它**做不到**、只能写在明处的事：

- **缺 `accent`**：莆仙不止一个口音，一份为某个口音登记的清单静默套用到另一个口音上，比没有清单更坏；
- **缺 `provenance`**（每条 `what`+`locator` 都要有，`retrieved` 要是 `YYYY-MM-DD`）：#189 卡住的从来不是缺一张表，而是缺「表在哪」的记录——这也是「零材料」能在清单早就公开的情况下持续一个月的唯一原因；
- **notation 在每一 part 内必须唯一**，且只有一个 notation 允许为空（零声母，且只许出现在声母一侧）。**一个 part 里两个 notation 记同一个读音则不拒绝**：那是真实材料里会有的事，而拒绝它并不能消掉歧义，只会把这份方案挡在仓库外，让最需要被看见的清单没人看得见。歧义交给规则层按 `AMBIGUOUS` 处理，`Pivot()` 在这种键上给出候选列表而不是静默取第一个——把选择权留给复核员，而不是留给 map 的遍历顺序；
- **notation / IPA / 调符必须是 Unicode NFC**，与例外值同一条理由（同形不同码）。这条比 adapter 严：adapter 对例外值是**规范化后落库**，这里是对**文件**直接拒绝。差别在来源——例外值是人手输入的运行时数据，目标方案文件是逐字抄来的、要被人对着出处核的成品；一个必须被改写才能参与比较的形式，宁可当场退回也不要静默替换掉；
- **`retrieved` 是日期，不是摘要。** 上游那个 chunk 若内容变了而地址没变，本仓库没有任何东西能发现——文件里的 `retrieved` 会照旧指向取回的那一天，附件里那句「已核对」的边界就在这里。要真钉住得上构件的哈希，那需要网络与上游配合，不在本包范围内；写在这里是为了让下一个读这份文件的人不把日期当成完整性证明。

## 关于 #189 第 6 条「一套定义两处使用」

#189 要求目标方案合法性校验复用 #177 的 R6，并明确写了「跨 goja/Go 两个运行时做不到字面意义上的一套定义，请先在 PR 里写明选了哪条」。

**选 ①：把调值/声母/韵母词表与合法性判据导出成数据文件，两边各自加载。**

选 ① 的第一半已经落地：**目标方案的词表现在有且只有一份**，即 `data/hinghwa_canonical.json`，由 `LoadScheme` 在载入期校验。离线侧不再复写它，只在 `scripts/scheme/data/tone_notation.json` 里登记一行 `puxian-xiangyin` 并指向它（见上表第三行）——两边各自加载，一份定义。第二半（把 `LoadScheme` 接成 `Adapter.Canonical` 的来源、并让目标侧合法性检查真的读它）仍然没做，因为它要等下面那条 `schema_version` 的决定。

调值合法性今天仍存在于三处：`scripts/corpus_probe/detectors.py`（`LEGAL_LONG_TONES`）、`scripts/scheme/data/tone_notation.json`（每列一套，且已有测试与前者对齐）、`backend/pb_hooks/lib/assist_rules.js`（R6）。**Go 侧是第四处的空壳**——它不硬编码任何调值，只读 adapter 自带的 `canonical.tone_values`。#189 提醒过 R6 不能直接当目标方案的判据（它的判据是「≥3 位且不是 533/453」，看不见目标方案那 5 个两位调值），所以「消除已有的三份」不是把 R6 抄过来，而是让它们都改读同一份数据——那是拿到目标清单之后紧接着的一步，本 PR 只把目标清单摆到位。

## 材料缺口（阻塞真实规则）

| 需要的东西 | 现状 |
| --- | --- |
| 莆仙乡音社方案清单（声母/韵母/调号） | ✅ **目标端已有**，源端仍缺。`backend/scheme/data/hinghwa_canonical.json` 是目标方案 `puxian-xiangyin`（页面定名「莆仙话拼音」）在莆田城里口音下的 15 声母 / 44 韵母 / 7 声调，逐条带 IPA、例字、出处与取回日期，由 `LoadScheme` 加载并在载入期校验（无 IPA、无出处、非 NFC 编码、notation 重复或出现两个零声母都会拒绝加载）。出处 `https://hinghwa.cn/pinyin`，清单原文在该页的构建产物 chunk `js/166.c91cbba4.js` 的组件 `data()` 里。**只登记这一个口音**——页面原文明写「下面介绍的拼音方案为莆田城里口音」，其它口音要另登记；`scheme_id`、`name`、`accent` 三个字段分开正是为这件事。**源端**（各书凡例的符号 ↔ IPA）仍要逐本登记，这半没有材料 |
| 该页清单是否已抽全 | ✅ 是。页面上声母/韵母各有一个「1 2」翻页器，#189 因此写过「完整清单仍需逐页取全，本文只录已核对到的部分，**不声称已抽完**」。已核对：整个 chunk 里 `pagination`/`pageSize`/`total`/`fetch`/`axios`/`api.` 全部零命中，表格数据整份作为 props 传给组件，翻页只是前端切片、不触发任何请求。所以 15 / 44 / 7 就是该页发布的全部，不是一个分页面的第一页 |
| 大词典「拼音方案 ↔ 国际音标对应关系」 | 凡例三.1 明写「请参见附录」。扫描版正文是 606 页，末页 p601–606 仍是 Z 段词条，**附录不在这个文件里** |
| 文读字汇方案清单 | ✅ 有。其凡例 p10–11 给了 18 声母 / 36 韵母 / 调类 1–7 全表 |
| 大词典罗马字清单 | 🟡 隐式。正本 `拼音` 列 + 键盘 `dictionary-romanization` 段可反推，但缺显式清单 |

拿到前两项之前，本包能且只能保持合成规则状态。`testdata/adapter_synthetic.json` 里每一条 basis 都写着 `synthetic`，就是为了让人一眼看出它不是语言学结论。

## #190 需要在这个包之上补什么

- 存储：`normalization_*` 字段落库与迁移（本包不碰 schema）；
  - `normalization_rule_version` 上**不建索引**：「规则升版后列出受影响记录」是升版那一刻才跑一次的罕见查询，不值得让 pages（导入热路径）的每次插入都维护它。需要时按项目全表扫：`project = ? && normalization_rule_version = ?`，属**离线查询**，不在任何请求路径上；
- 作业面：`conversion_jobs`、批次游标、四行汇总；
- 复核队列：`AMBIGUOUS` 的 `candidates` 与 `trace` 已经在结果里，队列只是把它们摊开给人看；
- 反哺：人工结论写回 `exceptions`，本包的 `REVIEWED` 状态与 `basis` 字段就是为此留的形状。写回的通道必须经过本包的加载与校验——例外值是全场唯一在运行时不做清单核对的出口（理由见流水线第 5 级），绕过校验直接改文件就等于把 `EXACT` 发给一个拼错的值；
- **部署**：`backend/Dockerfile` 的构建上下文是**白名单式**的（`COPY *.go`、`reviewbundle/`、`pb_migrations/`、`keyboards/`），只有列进去的目录才在镜像里。方案文件因此必须放在 `backend/scheme/` 之下——#289 给这份白名单补的 `COPY scheme/ ./scheme/` 是**整目录递归**的，`data/` 会跟着一起进去，放到 `backend/` 的其它目录则不会。`scripts/check_docker_build_context.py` 钉的就是这份白名单。今天缺这条 COPY 还不致命，因为 `main.go` 尚未导入本包、镜像里那句 `go test ./...` 碰不到 `scheme/`；有代码真正加载方案文件的那一刻起它就致命——这也正是本包故意不写死默认路径（`FANGJI_SCHEME_ADAPTER_DIR` 由调用方给）的另一面：路径由人给，就必须有人保证它在容器里可读。
