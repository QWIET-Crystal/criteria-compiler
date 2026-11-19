# 耦合短语判据：从 2/7 到 5/7（2026-11-19）

> 起因：四篇金集阳性被判成「疑似」。逐篇读完之后发现，
> **不是判据不够多，是判据缺了一整个类型——「论文自己说它耦合了」。**

## 一、那四篇到底怎么说的

| 论文 | 型 | 原文怎么说 |
|---|---|---|
| `adfm.202316773` | A | `…8542.6 µmol g−1 h−1 and **concurrent** furoic acid production…` |
| `adfm.202510323` | A | `H 2 O 2 Production **Coupled with** Glycerol Green Oxidation`（标题） |
| `aenm.71443` | B | `In‐Situ Synthesis of Hydrogen Peroxide **Coupled With** Organic **Valorization**` |
| `s41467-019-08454-0` | C | `manage generation and in situ decomposition of H2O2 to produce ·OH` |

前三篇都有一句**明确的耦合声明**；第四篇是 C 型（H₂O₂ 当场转 ·OH），摘要里没有耦合句式。

## 二、为什么原来的判据看不见

原来的共现对是从**种子几篇**里统计出来的：A 词和 B 词在种子的同一句里一起出现，
才成为判据。问题在于——**别的论文用别的词说同一件事**。

`concurrent`、`coupled with`、`valorization` 在种子里不出现，所以永远长不成判据。
实测：

```
coupled with    阳性 2/6   池子  9/120    ← 信噪比最高
concurrent      阳性 1/6   池子  7/120
valorization    阳性 2/6   池子 14/120
simultaneous    阳性 3/6   池子 44/120    ← 太泛
in situ         阳性 3/6   池子 65/120    ← 更泛（而且两种意思都用它）
```

## 三、修法：词从人来，位置由机器找

这些词不是我猜的，来自 `skills/criteria-compiler/references/rules.md`
第三节「原文用词」——课题组自己沉淀的规则。

做法：包里声明 `couplingPhrases`，生成 `co-occur([短语, 对象词])` 判据。
**同句出现才算**——「H₂O₂ … coupled with X」是真声明，两段各说各的不算。

## 四、过程中踩的两个坑

### 坑 1：一次塞 5 个词，永远不命中

`co-occur` 的语义是「**所有**词落在同一句」。我一开始把
`[coupled with, hydrogen peroxide, H2O2, H 2 O 2]` 放进一条判据，
结果阳性 0/6、池子 0/120——还以为是「这条路不通」。

改成两两组合之后立刻见效。**判据的语言先读清楚再写。**

### 坑 2：`H 2 O 2` 带空格

前两篇阳性的摘要里，化学式被接口渲染成 `H 2 O 2`（带空格），
而对象词表里只有 `hydrogen peroxide` 和 `H2O2`。共现判据因此永远凑不齐两项。

这正是项目最开始那三条修正里的第一条——**同一条坑，换了个位置又踩了一次。**

## 五、收紧：去掉泛词

| 版本 | 金集 | 池子「算」 |
|---|---|---|
| 含 `simultaneous` / `synchronous` | 5/7 | **20**/120 |
| 去掉这两个 | 5/7 | **12**/120 |

`simultaneous` 会被「同时去除污染物」这类用法蹭到（池子里有一篇 `water disinfection`
就是这样被判成算的）。去掉之后**召回零损失，误判少 8 篇**。

留下的四个：`coupled with`、`concurrent`、`integrated with`、`valorization`。

## 六、结果与边界

```
金集：算 5/7 ｜疑似 1 ｜取不到文本 1
池子：算 12/120 ｜疑似 74 ｜不算 34
```

**仍认不出的一篇是 C 型**（`s41467-019-08454-0`：H₂O₂ 当场转 ·OH，摘要不提「耦合」）。
C 型的判据在 `rules.md` 里写的是「H₂O₂≈0 但 •OH 强」——**那需要数值，不是词**。
这是判据形式的边界，不是词表能补的。

## 七、两篇阴性判不了

`apcatb.2026.127309` 和 `mser.2025.101117` **都没有摘要**，工具拿不到文本。

> 这不是「没有误报」，是「没法验证」。**数据缺口必须说成数据缺口，
> 不能悄悄算成通过。**
