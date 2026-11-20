# 四型分型：给「算」的论文定章节（2026-11-20）

> 判据说「算」之后，人还要知道它进哪一章。
> 分型就是章节骨架——定错一章，整篇结构就歪。

## 一、四型从哪来

不是我发明的，是课题组自己沉淀在 `skills/criteria-compiler/references/rules.md`：

| 型 | 定义 | 原判据 |
|---|---|---|
| A 载流子耦合 | 电子端产 H₂O₂、空穴端氧化底物，同体系同时进行 | 同图两产物 / `simultaneous` |
| B H₂O₂ 介导 | H₂O₂ 本身作氧化剂 | H₂O₂ 消耗量与产物量对应 |
| C H₂O₂→ROS | H₂O₂ 先转 ·OH 再氧化 | H₂O₂≈0 但 ·OH 强 |
| D 附加/级联 | 产 H₂O₂ 时伴随有机转化，允许非同体系 | 有产率 + 有产物（可仅定性） |

工具做的是把右列那几句「人话判据」变成可执行的检测。

## 二、第一版踩的两个坑

### 坑 1：`\bOH\b` 把材料名当成了羟基自由基

`TTPh–OH`、`TT-COF-OH` 这些是材料名，不是自由基。第一版用 `\bOH\b`，
于是那篇 tandem 论文被判成 C 型（H₂O₂→ROS）。

**改成必须带自由基标记**：`·OH` / `•OH` / `hydroxyl radical` / `DMPO` / `Fenton`。

### 坑 2：`furthermore / moreover / in addition` 被当成级联

这些词几乎每篇都有，它们只表示「下文还有内容」，不表示「分两步做」。

**D 型只认明确阶段词**：`tandem` / `stepwise` / `two-step` / `sequential`。

## 三、A 型的判定要多一条

只出现 `simultaneous` 不够——「同时提高了稳定性和选择性」也含这个词。

所以 A 型要求：**同时性说法 + 同一句里出现产物或氧化词**。放宽的代价由这一条兜住。

产物词表刻意留宽（`cinnam\w*`、`value-added` 等）：实测摘要里拼写常有出入，
卡死整词会把本该命中的句子漏掉（`cinnamonaldehyde`、`cinnamonmic acid`）。

## 四、跑出来 4/7，然后发现一个错标

在 8 篇阳性上跑（1 篇无题录）：

| 论文 | 标注 | 工具建议 |
|---|---|---|
| adfm.202510257 | A | A ✓ |
| jacs.6c00731 | A | 未定（摘要无依据） |
| anie.202423368 | A | A ✓ |
| s41467-026-71137-0 | A | 未定（摘要无依据） |
| **anie.7073224** | **A** | **D** ✗ |
| anie.9931408 | A | A ✓ |
| anie.2408330 | A | A ✓ |

**`anie.7073224` 的 A 是我填的占位符，工具是对的。**

那篇标题是 `Tandem Photocatalytic H₂O₂ Production and In Situ Upgrading`，
摘要里写 `a tandem catalytic strategy that integrates H₂O₂ generation with its
in situ utilization in organic synthesis`——**tandem，D 型，没有争议。**

已改 `gold.csv`：`A → D`，并注明「型由 tandem 证据定为 D」。

## 五、两篇「未定」不是失败

`jacs.6c00731` 和 `s41467-026-71137-0` 的摘要里没有任何一型的信号词。

工具输出的是：

```
可归入：未定（摘要里没有分型依据，需看正文）
```

**这不是「它不属于任何型」**，是「摘要里没有依据」。两者必须分开——
前者会让人把论文漏掉，后者只是提醒你去看正文。

`jacs.6c00731` 的型其实定得下来（人工备注写着 `coupled run is 24 mM`，
说明全文里有耦合实验），但**摘要里没有**。所以工具说未定是对的。

## 六、多型同时命中时

按「机制优先于组织方式」取：

```
C（H₂O₂→ROS） > B（H₂O₂ 介导） > A（载流子耦合） > D（附加/级联）
```

理由：B/C 说的是**机制**，A/D 说的是**怎么组织**。机制更具体，定章节时更硬。
多型命中时置信度降为 `medium`，提醒人复核。

## 七、它不写回 gold.csv

**只给建议和证据，不落盘。**

分型决定章节骨架，而这个决定得由了解领域的人做。工具的位置是：
把「哪一型的信号出现在哪一句」摆出来，让人一眼判断——不是替他定。

## 八、现在能跑

```bash
node bench/type.mjs --pack cof-h2o2 --works <题录快照>
```

账本里也接上了——判据说「算」的时候，顺手给一句可归入的章节：

```
✓ 10.1002/anie.7073224
    依据：必要条件都满足（material+object），但摘要里没找到耦合原句
    证据：「Covalent Organic Frameworks」 与 「H 2 O 2」
    可归入：D 附加/级联（伴随有机转化，允许非同体系）——「Tandem Photocatalytic H 2 O 2 Production and In Situ Upgrading…」
```
