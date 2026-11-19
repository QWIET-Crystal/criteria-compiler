# bench

两个脚本，一个原则：**引擎不认识任何领域词**。

| 脚本 | 作用 | 需要网络 |
|---|---|---|
| `validate-pack.mjs` | 校验所有 pack 的结构与金集 | 否 |
| `run.mjs` | 用某个 pack 跑覆盖率基准 | 是 |

## 校验 pack

```bash
node bench/validate-pack.mjs          # packs/ 下所有 pack（跳过 _template）
node bench/validate-pack.mjs packs/cof-h2o2
```

检查项：必填字段、id 与目录名一致、dimension 是否重复/缺 terms/缺 scope、
extraQuery 是否写清 `why`、stage 引用的 id 是否存在、金集列是否齐全、label 是否只有 0/1/2。

单 term 的 dimension 会告警——不是错，但通常意味着同义词没列全。

## 跑基准

```bash
export OPENALEX_API_KEY=...          # 免费 key，10 倍额度
node bench/run.mjs                   # 默认 packs/cof-h2o2
node bench/run.mjs --pack packs/你的包
node bench/run.mjs --stage A --cap 200   # 冒烟
node bench/run.mjs --no-cache            # 忽略 .cache/openalex
```

不需要 `pnpm install`。

## 多源（--sources）

```bash
node bench/run.mjs --sources openalex            # 默认
node bench/run.mjs --sources openalex,crossref
```

| 源 | 接口 | 是否需要 key | 查询语义 |
|---|---|---|---|
| openalex | `api.openalex.org` | 否（免费 key 额度 ×10） | 布尔表达式，支持槽位 |
| crossref | `api.crossref.org` | 否 | 自由文本相关性排序，**不支持布尔** |

Crossref 适配器会先剥掉 `AND/OR/NOT` 与括号，把词交给它的 bibliographic 检索。
所以两个源吃的不是同一种查询，**结果不能逐条对比，只能比池子与覆盖率**。

### 实测：多源为什么几乎不增量

自由文本源**不遵守 AND**。初版 adapter 直接把结果并进池子，CV 包 B 段（cap 1000）从 93 涨到 1559，
但里面大量是纯 CV 论文——金融/ESG 那半边被当成了“加分项”而不是“必须项”。

给 adapter 加上**本地复核槽位**（每条记录必须在标题+摘要里同时命中所有槽位）之后：

| 源 | 池子 |
|---|---|
| openalex | 93 |
| openalex + crossref（过滤后） | 94 |

Crossref 丢弃了 2994 条不满足全部槽位的记录，净贡献 1 条。

结论：**查询本身是 AND 结构时，布尔源已经把约束做完了；自由文本源在严格复核后增量接近零。**
Crossref 的价值在元数据补全（缺 DOI、缺年份、缺摘要），不在召回。

> Google Scholar 没有公开 API，抓取违反其条款且会触发验证码，本项目不做。
> Semantic Scholar 有 API，但无 key 时极易 429（实测直接返回 429），如需接入要单独申请 key。

`--cap` = **每个查询最多取多少条**，默认 1000，实现上限是 10 页 × 100 条。

- `--cap 200` 时 A 段只覆盖 1/7；
- `--cap 1000` 时 A 段覆盖 2/7。

**覆盖率必须连 cap 一起报**。README 里的 2/7 → 7/7 是 cap 1000 的结果。

**失败过的一轮不能当结果用**：任何一条查询失败，`run.mjs` 会以退出码 3 结束并列出失败的查询。
池子不完整时召回一定偏低，那不是「这领域文献少」。

## 金集

在 pack 目录里，由 `pack.json` 的 `gold` 字段指向。列：

```
doi,label,coupling_type,material_scope,has_abstract,note
```

- `label`：`2` 正例 / `1` 部分 / `0` 负例
- `note` 写**判定依据**，不写“相关”
- **不要**存标题、摘要或全文

没有金集的 pack 把 `gold` 设为 `null`，只能用 `search` 模式，不能跑 bench——
也不要为了方便去编标签。

## 加一条金集

1. 读全文，按 pack 的 rules 给 `label`；
2. 填 `note`（为什么这样判）；
3. 重跑 `node bench/run.mjs`，如果覆盖率变化，在 PR 描述里说明原因。

新增金集条目属于**数据变更**，PR 里要附判定依据；单纯调参不改数据的 PR 不需要。
