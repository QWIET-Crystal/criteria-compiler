# 判据与警示词

本文件是从一次真实综述检索中沉淀下来的规则，用来给 agent 提供“领域常识”。
它不是产品文档，是给人看的判据表；代码实现见 `packages/core`。

## 一、耦合的四种型

| 型 | 定义 | 判据 | 代表 |
|---|---|---|---|
| A 载流子耦合 | 电子端产 H₂O₂、空穴端氧化底物，同体系同时进行 | 同图两产物 / `simultaneous` | BT-COF、sp²-COF-CN |
| B H₂O₂ 介导 | H₂O₂ 本身作氧化剂 | H₂O₂ 消耗量与产物量对应 | Fe-CdS |
| C H₂O₂→ROS | H₂O₂ 先转 •OH 再氧化 | H₂O₂≈0 但 •OH 强 | Cu-PCN |
| D 附加/级联 | 产 H₂O₂ 时伴随有机转化，允许非同体系 | 有产率 + 有产物（可仅定性） | TTT-COF |

**D 型引用红线**：产物没测收率的，只能定性说“伴随氧化”，不许给数字。

## 二、H₂O₂ 的四种身份（决定归到哪一章）

| 身份 | 含义 | 章节 |
|---|---|---|
| ① 目标产物 | 只产不用，只报产率 | 3.1 |
| ② 原位氧化剂 | 直接氧化底物，有收率 | 3.2(1) |
| ③ 活性氧前驱体 | 先变 •OH 再氧化，H₂O₂ 不积累 | 3.2(2) |
| ④ 并行半反应的产物 | 双产物共生 | 3.2(3) |

## 三、原文用词

| 用词 | 判定 |
|---|---|
| `in situ` / `one-pot` / `simultaneous` / `synchronous` | ✅ 进 3.2 |
| `occurring at the oxidation and reduction ends` | ✅ 强证据 |
| `In addition` / `furthermore` / `we also investigated` | ❌ 另起实验的典型转折词 |
| `series` / `two-step` / `tandem` / `stepwise` / `sequential` | ❌ 最多算 1.3 / 4.3.4 |
| `sacrificial agent` / `hole scavenger` / `TEOA` / `EtOH` / 异丙醇 / 苯甲醇 | ⚠️ 降级，可进 3.2(1)，不可进 3.2(3) |
| `without sacrificial agent` / `pure water` / `from water and air` | ✅ 高价值，优先收 |

## 四、引用红线

1. 最高产率 ≠ 耦合数据：头条常来自牺牲剂体系。
2. 同一篇可能并存两种范式：归档时一篇拆两条记录。
3. 单位不可比：`μmol g⁻¹ h⁻¹` 与 `mM h⁻¹` 不能直接换算比较。
4. 机翻摘要不可引：中文摘要存在漏译，引述回原文英文摘要。
5. 被引数各家不同：正文要么不写，要么统一口径。

## 五、检索与清洗

- 化学式在接口里常带空格，匹配前统一 squash 空格与下标。
- `anie.` 与 `ange.` 互转去重。
- 摘要缺失的记录检索接口不返回，需按 DOI 直查。
- 单材料口径会系统性漏掉姊妹体系：CMP / PHI / 碳氮 / CdS / 铋系。
