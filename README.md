# criteria-compiler

把一个课题组的**纳排标准**编译成可执行的判据与判例，再对文献候选池做多体系召回、归一化与覆盖率报告。

工具只给**证据提示与陷阱预警**，不给"相关 / 不相关"的终判——结论由研究者下。

```
$ node bench/run.mjs

criteria-compiler benchmark
gold: 9 records (7 positive / 2 negative)
cap per query: 1000

stage                             pool      positives     negatives
----------------------------------------------------------------------
A. COF only                       922       2/7           0/2
B. six material families          2877      5/7           0/2
C. six families + 3 fixes         2890      7/7           0/2

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

把材料槽扩展成六族并集，覆盖率从 2/7 升到 5/7；再加三条确定性修正，到 7/7。

## 三条修正（都是被数据打出来的，不是想出来的）

| 修正 | 为什么 | 验证 |
|---|---|---|
| 化学式空格归一 | 接口把下标渲染成空格：`H 2 O 2`、`Bi 2 O 2 S`、`CuInS 2` | 加空格变体后，目标文献在一次 23 条查询里被召回 |
| H₂O₂ 词改为可选 | C 型文献把 H₂O₂ 当场用掉，摘要根本不提 | 改用底物+产物词，14 条结果里命中 |
| DOI 兜底直查 | 部分记录无摘要，检索接口不返回 | 按 DOI 解析成功 |

以上三条不是写死在代码里的，它们在 `packs/cof-h2o2/pack.json` 的 `extraQueries` 里，每条都带 `why`。

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
