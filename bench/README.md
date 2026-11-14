# bench

可复现的覆盖率基准。目标只有一个：**任何人在三分钟内验证 README 里的数字**。

## 跑

```bash
export OPENALEX_API_KEY=...       # 免费 key，10 倍额度；匿名额度按出口 IP 共享
node bench/run.mjs                # 人类可读
node bench/run.mjs --json         # 机器可读
node bench/run.mjs --stage A --cap 200   # 冒烟：几十秒、只跑一段
node bench/run.mjs --no-cache     # 忽略本地缓存，强制重跑
```

不需要 `pnpm install`。需要访问 `api.openalex.org`，建议配 key。

## cap 是什么意思（重要）

`--cap` = **每个查询最多取多少条**，默认 1000，实现上限是 10 页 × 100 条。

- `--cap 200` 时 A 段只覆盖 1/7；
- `--cap 1000` 时 A 段覆盖 2/7。

**覆盖率必须连 cap 一起报**，否则不同的人跑出来的数字对不上。README 里的 2/7 → 5/7 → 7/7 是 cap 1000 的结果。

## 三段口径

| 段 | 含义 |
|---|---|
| A `cof-only` | 单一材料槽。这是基线，也是大多数人的默认做法 |
| B `six-families` | COF / CMP / PHI / 碳氮 / CdS / 铋系 六族并集 |
| C `six-families-with-fixes` | B + 三条修正（空格变体、去掉 H₂O₂ 硬约束、DOI 兜底） |

## 金集

`gold.csv`，9 行：

- `label=2`（7 行）：领域研究者读全文后判定为"真耦合"
- `label=0`（2 行）：看起来相关但不满足判据（电催化串联、双功能非耦合），用来测误召回

**只存 DOI 与判定注记，不存标题和摘要。** 摘要有版权；存进仓库既违法又会让基准撒谎。

`has_abstract` 列记录该记录在 OpenAlex 是否有摘要——没有摘要的记录不会被检索接口返回，
只能靠 DOI 兜底，这是第 C 段的一条修正。

## 读结果

- `positives` 是 `命中 / 总数`，分母**只算 label=2**。
- `negatives` 同理，分母是 label=0。负例出现在池子里不一定是错——它留在池子里正是为了测下游判定。
- 池子规模每次运行会有 ±2% 波动（OpenAlex 索引更新），比较不同时间的结果时请带上日期。

## 加一条金集

1. 读全文，按 `docs/` 里的判据给 `label`；
2. 填 `coupling_type`、`material_scope`、`has_abstract`、`note`（note 写"为什么这样判"，不要写"相关"）；
3. 重跑 `node bench/run.mjs`，如果覆盖率变化，在 PR 描述里说明原因。

新增金集条目属于**数据变更**，请在 PR 里附上判定依据；单纯调参不改数据的 PR 不需要。
