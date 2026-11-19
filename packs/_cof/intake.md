# _cof · 起步记录

**你要搜的是**：COF 光催化里真正同时发生的水氧化与双氧水生成

## 你给的例子

正例 3 篇（这些算）：
- 10.1002/adfm.202510257 — Customized Covalent Organic Frameworks with in‐Plane and Intramolecular Asymmetric Polarization for Superior Hydrogen Peroxide Photosynthesis and Aerobic Oxidation of Alcohol
- 10.1021/jacs.6c00731 — Extending Asymmetric π-Conjugation of Vinylene-Linked Covalent Organic Frameworks with Remodeled Redox Active Sites for H 2 O 2 Photosynthesis and Aerobic Oxidations
- 10.1002/adfm.202316773 — Self‐Floating Photocatalytic System for Highly Efficient Hydrogen Peroxide Production and Organic Synthesis on Carbon Dots Decorated Conjugated Microporous Polymer

反例 1 篇（这些不算）：
- 10.1016/j.apcatb.2026.127309 — High-yield electrocatalytic production of hydrogen peroxide by zeolite-loaded dual-atom catalysts coupled with TS-1 zeolite for phenol hydroxylation

## 脚本从例子里读出来的

区分性词：[object Object]、[object Object]、[object Object]、[object Object]、[object Object]、[object Object]、[object Object]、[object Object]、[object Object]、[object Object]

反例独有词：high-yield electrocatalytic、electrocatalytic production、zeolite-loaded dual-atom、phenol hydroxylation、dual-atom catalysts、catalysts coupled、electrocatalytic、zeolite-loaded

## 待你拍板

- 27 个候选词在背景池里太常见、已自动丢弃（例如 photocatalysts、synthesis、reactions）。如果有你眼里的关键术语被丢了，说明它喊得不够响——那本身就是个信息。
- 3 个词按声明被排除在判定之外：production rate、photosynthesis、sacrificial。它们在正例和同领域背景里一样常见（lift≈1），当证据只会放大误报；它们仍参与拼查询。
- 极性词 sacrificial 已做成「只提示」判据：它不参与判定，只把「有没有用牺牲剂」摆给你看。要不要因此判不算，取决于它有没有同时产出有价值的东西——这个判断机器做不了。
- 槽位怎么切，脚本不替你决定。下面这几篇边界论文标完，再回来定。

> 这份文件是存档。判据草案在 `draft.json`，待标清单在 `review-queue.csv`。
