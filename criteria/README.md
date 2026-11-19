# 设计样例，不是生效的配置

这个目录里的 `pack.yml` 是 v0.2 的目标格式样本，**没有任何代码消费它**。

会被 `bench/validate-pack.mjs` 和 `bench/run.mjs` 读取的是 `packs/<名字>/pack.json`。

改这里的词不会有任何效果——如果你想改检索词，去 `packs/`。
