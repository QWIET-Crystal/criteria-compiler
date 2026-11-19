# criteria-compiler

把一个课题组的**纳排标准**编译成可执行的判据与判例，再对文献候选池做多体系召回、归一化与覆盖率报告。

工具只给**证据提示与陷阱预警**，不给"相关 / 不相关"的终判——结论由研究者下。

**想先跑起来？看 [DEMO.md](DEMO.md)，三条命令，大约 10 分钟。**

```
$ node bench/run.mjs

criteria-compiler benchmark
gold: 9 records (7 positive / 2 negative)
cap per query: 1000

stage                             pool      positives     negatives
----------------------------------------------------------------------
A. COF only                       814       2/7           0/2
B. six material families          2826      7/7           0/2
C. six families + 3 fixes         2837      7/7           0/2

elapsed: 51.3s
```

实测于 2026-11-14，需要 `OPENALEX_API_KEY`。池子规模会随 OpenAlex 索引更新小幅波动，
所以比较不同时间的结果时请带上日期与 cap。

**覆盖率依赖 cap。** `--cap` 是"每个查询最多取多少条"（上限 10 页 × 100 条 = 1000）。
用 `--cap 200` 跑 A 段只有 1/7——不是回归，是分母变小了。数字必须连 cap 一起说。

## 为什么需要它

文献检索的瓶颈通常不在"排得不够准"，而在**根本没进来**。

实测：只按 `COF` 一个材料槽检索，约 1000 篇候选里只能覆盖 7 篇金集中的 2 篇（29%）；
在这个口径内，增加耦合词、增加底物词、收窄到 201 篇子集，覆盖率**一动不动**。

原因是那 5 篇里 4 篇不属于 COF 体系——共轭微孔聚合物、聚庚嗪酰亚胺、碳氮、CdS。
它们的摘要里不出现任何 COF 字样，靠排序永远捞不回来。

把材料槽扩展成六族并集，覆盖率从 **2/7 直接到 7/7**。

> 2026-11-19 更正：早先这条写的是「六族 5/7，再加三条修正到 7/7」。
> 补上复数变体之后（`"carbon nitrides"`、`"bismuth oxysulfides"`），六族并集自己就够了——
> 那两篇以前只有修正项能捞到，是因为查询写的是单数、按字面匹配不到复数。
> **修正项不是召回瓶颈，词形才是。** 三条修正仍然多捞 11 篇，但不再承重。

## 三条修正（都是被数据打出来的，不是想出来的）

| 修正 | 为什么 | 验证 |
|---|---|---|
| 化学式空格归一 | 接口把下标渲染成空格：`H 2 O 2`、`Bi 2 O 2 S`、`CuInS 2` | 加空格变体后，目标文献在一次 23 条查询里被召回 |
| H₂O₂ 词改为可选 | C 型文献把 H₂O₂ 当场用掉，摘要根本不提 | 改用底物+产物词，14 条结果里命中 |
| DOI 兜底直查 | 部分记录无摘要，检索接口不返回 | 按 DOI 解析成功 |

以上三条不是写死在代码里的，它们在 `packs/cof-h2o2/pack.json` 的 `extraQueries` 里，每条都带 `why`。

## 从一句话开始（学生版入口）

专家版要求你自己写 `pack.json`。学生版不要——**你只需要说一句话，再给几篇你认的论文**：

```bash
node bench/start.mjs --id my-topic \
  --want "COF 光催化里真正同时发生的水氧化与双氧水生成" \
  --pos 10.1002/adfm.202510257,10.1021/jacs.6c00731 \
  --neg 10.1016/j.apcatb.2026.127309
```

它输出三样东西：

| 文件 | 是什么 |
|---|---|
| `draft.json` | 从你的正反例长出来的判据草案——**这是给你改的，不是结论** |
| `intake.md` | 你给的四个答案（存档） |
| `review-queue.csv` | 最该由你来标的那批论文，最后一列填 2/0/1 |

两个设计上的取舍值得说明：

- **区分词要用背景池筛一遍。** 只给正例的话，「photocatalysts」这种词当然满足「正例里有、反例里没有」——那不是判据，那是这个领域的常识。所以脚本会先拉一个同领域的池子，把高频词剔掉。
- **待标样本挑的是「贴着交集边缘」的**，不是最像的、也不是最不像的。离题目太远的论文，标了也不长知识。

它**不替你做**的判断：槽位怎么切（见 [docs/design-tree.md](docs/design-tree.md) A1′）、以及任何一条论文算不算。

## 标完之后：让它改判据

```bash
node bench/refine.mjs --pack my-topic
```

这是「越用越懂」的全部实现——**没有任何权重更新**。它只做一件事：从你标错的论文里，找出判据漏掉的说法。

| 你对账结果 | 它做什么 |
|---|---|
| 你判「算」，它说「不算」 | 从这些论文里长出新的区分词，加进草案 |
| 你判「不算」，它说「算」 | 长出排除信号；**但已经在「算」词表里的词一律不许进排除项** |
| 两批论文共享全部词汇 | 明说找不出干净排除词，并提示方向：该问「缺了什么」而不是「多了什么」 |

然后它会重排队列，**标过的论文不再问你**。

## 漏检账：把「漏了什么」变成一条条记录

```bash
node bench/ledger.mjs --pack cof-h2o2
```

别人的覆盖率是一个数。这里是一次一条的账：**这篇漏了、漏在哪条查询之外、被哪条查询救回来、还是根本救不回来。**

```
✓ 10.1002/adfm.202510323   首次召回 spaced-formula
✓ 10.1038/s41467-019-08454-0   首次召回 no-product-word
✗ 10.1016/j.mser.2025.101117   仍然漏（只有 DOI 兜底能拿到，不算召回）
```

两条刻意的设计：

- **单篇不升格。** 一条归因只涉及 1 篇时，不会建议改判据。单篇就改，是在奖励噪音。
- **兜底不算召回。** DOI 直查拿到的，单独标注，不计入检索能力。

完整的不许过拟合 / 不许欠拟合规矩见 [docs/fit-guards.md](docs/fit-guards.md)。

改完判据之后，旧队列就过期了——它按上一版挑的。跑一次 `refine` 会按新判据重拉：

```bash
node bench/refine.mjs --pack my-topic --pick 20
```

没有标注时它跳过学习、只重拉。实测这一步的差别很大：同一份草案从「数命中词数」换成
`asymmetric + photosynthesis` 共现判据，重拉出来的队列从一堆无关的 MOF 电荷转移论文，
变成三篇真正在讲「不对称光催化产 H₂O₂」的论文。

## 认不出来的原因分三类

```bash
node bench/ledger.mjs --pack cof-h2o2 --cause <doi> <criterion|data|out_of_scope> --note "为什么"
```

| 原因 | 该做什么 |
|---|---|
| `criterion`（判据缺一条） | 改判据——**唯一**值得动判据的一类 |
| `data`（化学式空格、缺摘要） | 先修数据，改判据没用 |
| `out_of_scope`（摘要里没这个概念） | 加判据也救不回来 |

判据账会按原因分组，并在多数某一类时直接说现在该做什么。原因存 `causes.json`，
**不进 gold.csv**——原因属于分析过程，不属于金标。

### 时间窗口：能直接写进检索

```json
{
  "dateWindow": { "since": "2021-01-01", "until": "2026-12-31" }
}
```

放在 `pack.json` 顶层。它会变成 OpenAlex filter 的 `from_publication_date` / `to_publication_date`，
**不是检索完再筛**。

不给也行，但那时时间只能后处理——校验器会警告，并把这句话写在输出里，
不让工具假装管了这件事：

```
warn  my-pack: 没有 dateWindow：检索语句里不带日期，「近三年」只能检索完再筛。
```

起草阶段也能给：`node bench/start.mjs ... --since 2021-01-01`，
这个窗口会记进 `provenance.json` 的「按什么筛」。

## 这份清单从哪来的、按什么筛的

```bash
node bench/provenance.mjs --pack cof-h2o2
```

每份产物（草案、队列、漏检账）旁边都记着三样东西：

| | 回答什么 |
|---|---|
| `builtFrom` | 输入是什么（哪几篇正例、哪几篇反例、哪些种子） |
| `filteredBy` | 按什么筛的（查询条数、时间窗口、上限、池子大小、丢了几个词） |
| `notIncluded` | **明确没做什么**（没取全文、没查引文网络、非英文不召回） |

第三项最容易省，也最容易误导人：**「找不到」和「没找」是两件事。**

> 一位使用者说，这句话比他拿到的三个工具加起来有用——他就是在这一句上栽的，而且是他先栽的。

## 提示项：判据说「算」，顺便告诉你该看哪一眼

`pack.json` 里可以声明 `noteTerms`，它们生成 `note` 判据——**只给证据，不参与判定**：

```json
"noteTerms": [
  { "id": "in-situ", "label": "原位 / operando 表征",
    "terms": ["in situ", "operando"],
    "why": "阳性 3/6 出现、池子 52%。读之前值得知道它是「推测机理」还是「看见中间体」。" }
]
```

跑 `try` 时它长这样：

```
· 10.1021/jacs.6c00731  …
    共现证据：「aerobic oxidation」 与 「benzyl alcohol」
    看一眼｜原位 / operando 表征：出现 1 处
    看一眼｜牺牲剂：以肯定形式出现 1 处（需人工判断）
```

它解决的是「结论对了，但你不知道这篇凭什么」——比如那篇用了牺牲剂，
判据仍然说算（因为它同时产出了苯甲醛），但这个事实必须让人看见。

哪些信号值得装，用 `node bench/note-audit.mjs` 量：

```
原位 / operando 表征         3/6    62/120 ✓ 已装
同位素标记                    0/6    2/120  阳性里太少
定量产率数据                  5/6    60/120 ✓ 已装
```

判据是「阳性里 ≥2 篇，且池子里不到 60%」。**金集不到 10 篇时，0/N 只是样本不足，
不能拿来定词表**——脚本会把这句话直接打出来。

## 区分词到底在区分什么

```bash
node bench/term-audit.mjs --draft <draft.json> --gold <gold.csv> \
  --gold-works <金集题录> --pool-works <背景池题录>
```

```
photosynthesis       33%        36%        0.93   ← 不区分
```

`lift = 阳性覆盖率 ÷ 背景池覆盖率`。lift ≈ 1 表示这个词在阳性和背景里一样常见——
**它不是判据，是这个领域的常识。** 脚本只给数，删不删由人定。

背景池必须是**与候选词无关**的那份；拿「命中任一候选词」的池子当分母会失真
（实测同一个词，有偏池子算出 31.9，无关池子 0.93）。

## 没有金集也能自查召回

```bash
node bench/run.mjs --probe doi1,doi2,doi3 --quiet
```

拿你手上认识的任何一批论文当种子，逐条查询报「召回了其中几篇」，并给每阶段并集。
不需要金标——新领域一上手就能用。

## 换领域之前：先做一次轴产出体检

多轴召回是本项目唯一一条被数据钉死的结论，但那条结论是在 COF 上测出来的。换领域之前，先确认那个领域的轴是不是真的分得开：

```bash
node bench/axis-yield.mjs --pack packs/cv-finance-esg
npm run axes                            # 同上
```

它**不需要金集**，只报三件事：

1. **槽体检**——每个槽单独命中多少、AND 之后还剩多少。交叉率低于 1% 说明两个槽在真实摘要里几乎不共现，此时叠多少条轴都只是在一个很小的池子里打转。
2. **每条轴的产出**——命中总数、实收、**独有**（去掉它并集就变小）、新贡献。
3. **有金集时**——这条轴独有的阳性数。那才是真正承重的轴。

`cv-finance-esg` 的实测结果就是个例子：两个槽各自 40 万+ / 70 万+ 篇，AND 之后只剩 **350 篇（0.1%）**，六条轴产出 0–33 篇。原因不在词表——**这个领域论文写的是任务名（表格抽取、图表理解），不写学科名（computer vision）**。同一个现象在 COF 那边也出现过：真正对的那几篇，摘要里根本不出现 "COF"。

## 换一个领域：packs

引擎里**没有任何领域词**。一个领域所需的全部内容都在一个 pack 目录里：

```
packs/cof-h2o2/
├── pack.json    # 对象槽、检索轴、修正查询、阶段、金集路径
├── gold.csv     # 人工判定（只存 DOI + 标签 + 依据）
└── rules.md     # 判据与警示词，给人看的
```

换领域只需要改四个概念：

| 字段 | 含义 | 本 pack 的值 |
|---|---|---|
| `object.terms` | 每篇候选都必须涉及的对象 | `hydrogen peroxide` / `H2O2` |
| `dimensions[]` | **检索轴，每轴单独查询再合并**（合并成一个 OR 就失去了“哪条轴贡献了什么”） | COF / CMP / PHI / 碳氮 / CdS / 铋系 |
| `extraQueries[]` | 因漏掉某篇而加的修正，必须写 `why` | 空格版化学式、去掉产物词 |
| `stages[]` | 报哪几段、每段用哪些轴 | A 单轴 / B 全轴 / C 全轴+修正 |

新建一个领域：

```bash
cp -r packs/_template packs/your-field
# 改 pack.json；写 gold.csv（没有金集就把 gold 设为 null，只能 search，不能 bench）
node bench/validate-pack.mjs packs/your-field
node bench/run.mjs --pack packs/your-field
```

**不要为了跑绿基准去编标签。** 没有金集的 pack 允许存在，`validate-pack` 会标成 retrieval-only。

## 对账：把分歧变成问题

覆盖率和准确性都只是**结果**。真正让这套东西变好的，是把「判据的结论」和「人的判断」对上，只看两边不一致的地方——**分歧就是该问研究者的问题**。

```bash
node bench/contradictions.mjs --refresh   # 首次：拉一次摘要进本地缓存
node bench/contradictions.mjs             # 之后：离线对账
```

输出四类分歧，每一类都带一句要问的话：

| 类型 | 含义 | 该问的 |
|---|---|---|
| 判据太宽（误伤） | 判据报警，但人判「算」 | 它凭什么算？ |
| 判据太窄（漏判） | 判据没报警，但人判「不算」 | 是哪一点让它不算？ |
| 线没画（严的一侧） | 判据报警，人也说不好 | 这条线你打算划在哪边？ |
| 线没画（松的一侧） | 判据没报警，人也说不好 | 缺了哪一条判据？ |

两条设计约束：

- **仓库里不存摘要。** 金集只有 DOI 与标签；摘要单独缓存在 `.cache/abstracts/`（gitignore 覆盖），用时才拉。
- **引擎里依然没有领域词。** 判定全部来自 pack 的 `checks`，其中 `absent` 字段用于表达「摘要里从没出现某种说法」这类缺失判据——没有它，`coupling-language-absent` 这种检查根本无法写成一条正向正则。

### 这是怎么长出来的

`coupling-language-absent` 这条判据本身就是被对账打出来的。最初只匹配 `simultaneous` 一个词，跑金集一看：**7 篇阳性被打掉 5 篇**。实测这 7 篇里 `coupled` 出现 3 次、`concurrent` 2 次、`simultaneous` 只有 1 次。改成一组词之后，只在甲烷制乙醇那篇上命中——而它恰好是最难解释的一篇（摘要里根本不提 H₂O₂，靠「底物 + 产物」那条 `extraQueries` 才捞回来）。

判据不是想出来的，是被数据打出来的。`bench/` 里这三个脚本合起来就是「打」的动作。


默认用哪个 pack 由 `packs/default.json` 决定——代码里不写死包名，`validate-pack` 会扫 `packages/*/src`
里是否出现了任何 pack 的词汇，出现就判失败。

## 快速开始

```bash
# 1) 拿一个免费 API key（10 倍额度，且匿名额度是全出口 IP 共享的）
#    方式一：https://openalex.org/signup -> Settings -> API key
#    方式二：让 agent 代申请（用户只需点邮件里的链接）
#      curl -X POST https://api.openalex.org/api-keys \
#        -H "Content-Type: application/json" -d '{"email":"you@example.com"}'
export OPENALEX_API_KEY=...          # Windows: $env:OPENALEX_API_KEY="..."

# 2) 跑基准（无需安装任何东西）
node bench/run.mjs

# 只跑一段（几十秒内出结果，适合先验证环境）
node bench/run.mjs --stage A --cap 200

# 3) 机器可读
node bench/run.mjs --json

# 4) 开发
pnpm install
pnpm test
pnpm build
```

结果会缓存在 `.cache/openalex/`，第二次跑同一条查询是瞬时的。

> **关于 429**：OpenAlex 的额度按美元算、按出口 IP 共享，`mailto` 已经不提供额外预算。
> 遇到 `daily budget exhausted` 就是当天用完了，要么配 `OPENALEX_API_KEY`，要么等 UTC 午夜重置。
> runner 会在 60 秒内明确报错，不会挂死。

## 接入 DSH

两层，按需选择。

**Skill（零安装）**：把 `skills/criteria-compiler/` 拷到 `~/.dsh/skills/`，重启即可。
Agent 会在"文献综述 / 搜不到 / 同义表述"这类请求上自动加载。

**MCP 工具（结构化接口）**：把 `integrations/dsh/cordis.patch.yml` 的内容合并进
`$DSH_HOME/cordis.patch.yml`，再把 `command`/`args` 指到你构建出的 `packages/mcp/dist/server.js`。

> Windows 提示：DSH 直接 spawn、不经 shell，`npx` 会失败。用 `npx.cmd`，或直接 `node <path>`。

三个工具：

| 工具 | 作用 |
|---|---|
| `search_candidates` | 按材料族并行召回（**不要单族**，召回上限由维度决定） |
| `check_paper` | 单篇体检：归一化、规则触发、材料归属 |
| `coverage_report` | 复跑基准，返回覆盖率表 |

## 仓库结构

```
packages/core/   纯函数：归一化、pack 加载、OpenAlex 客户端、覆盖率。无领域词、无 LLM、可单测
packages/cli/    criteria-compiler bench | search | families
packages/mcp/    MCP server（三个工具）
packs/           领域包：pack.json + gold.csv + rules.md（引擎不读领域词，只读这些）
skills/          DSH Skill：教 agent 何时用、怎么读结果
bench/           runner 与 pack 校验（零依赖）
docs/decisions/  架构决策记录
```

## 它不是什么

- **不是搜索引擎**，不追求全学科覆盖。
- **不替代人工终判**，只提示证据与陷阱。
- **不抓付费墙**，不绕过任何反爬或人机验证；元数据全部来自公开 API（OpenAlex、Crossref）。
- **v0.1 不调用任何 LLM**；基于模型的判定在 v0.2，且必须是显式选配。

## 已知边界

- 金集只有 7 篇正例 + 2 篇负例，由领域研究者逐篇读全文判定；百分比只作同口径横向比较。
- 候选池规模每次运行会有小幅波动（OpenAlex 索引持续更新），所以基准里记录日期与 cap。
- OpenAlex 不含作者关键词字段，且覆盖预印本与非英文文献，与 Web of Science 口径不同，不作大小比较。

## 路线图

- [x] v0.1 确定性管线：六族召回、归一化、覆盖率基准
- [ ] v0.2 判据库：把口头判据编译成判据 + 判例，判定结果附理由
- [ ] v0.3 证据提示：图 / `simultaneous` / 溶剂 / 收率的可机检提示
- [ ] v0.4 判据文件格式与版本化（口径变更留痕）

## 许可

MIT。数据来自 OpenAlex（开放元数据），仓库内**不存储论文摘要**。
