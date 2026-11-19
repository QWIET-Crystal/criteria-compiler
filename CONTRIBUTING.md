# Contributing

Thanks for looking. This project is small on purpose: a deterministic core, a benchmark,
and a thin CLI/MCP layer. Most useful contributions are **data**, not features.

## 最快的参与方式

跑一次基准，把你看到的数字和你的环境贴到 issue 里：

```bash
node bench/run.mjs --mailto you@example.com
```

如果数字和 README 不一致（比如覆盖率不是 2/6 → 6/6），那是一个有价值的 bug。

## 提交金集（最有价值的贡献）

金集 `bench/gold.csv` 是本项目唯一不能自动生成的东西。新增一条需要：

1. 读**全文**，不是摘要；
2. 按 `skills/criteria-compiler/references/rules.md` 给出 `label`（2 正例 / 1 部分 / 0 负例）；
3. 填 `coupling_type`、`material_scope`、`has_abstract`；
4. `note` 写**判定依据**（"苄胺偶联以 In addition 另起实验"），不要写"相关"；
5. PR 描述里说明：你怎么判的、和哪条判据冲突过、为什么最终这么判。

**不要**提交论文摘要或全文。仓库只存 DOI 与判定。

## 提交代码

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm build
```

> **Windows 用户**：仓库自带 `.npmrc`（`node-linker=hoisted`）。这不是偏好，是修复——
> pnpm 默认的软链布局在「store 在 C 盘、项目在 D 盘」时会报 `ERR_PNPM_SYMLINK_FAILED`。
> 装完之后 `node_modules` 是扁平结构，没有 `.pnpm` 目录，这是预期行为。
>
> **如果 `pnpm test` 报 `EPERM: operation not permitted, mkdir 'C:\Users\...\Temp\...'`**：
> 那是 `%TEMP%` 的权限问题，vitest 会在收集阶段中断并显示成「no tests」，很有迷惑性。
> 把临时目录临时挪进仓库再跑：
>
> ```powershell
> New-Item -ItemType Directory -Force .tmp | Out-Null
> $env:TEMP = "$PWD\.tmp"; $env:TMP = "$PWD\.tmp"
> pnpm test
> ```
>
> 只影响当前窗口。如果你确认自己的 `%TEMP%` 建不了目录，这就是解法。

- 核心逻辑放 `packages/core`，它必须保持**纯函数、无网络、无时钟、无随机**。
- 任何改变检索口径的改动，都要在 PR 里贴出基准前后对比。
- 提交信息用 `feat:` / `fix:` / `docs:` / `chore:` 前缀。

## 不要做的事

- 不要加爬虫、不要绕过任何反爬或人机验证、不要下载全文。
- 不要把 LLM 判定塞进 `core`；它属于 v0.2 的可选层。
- 不要在 `bench/run.mjs` 里加依赖——它是"零安装即可运行"的承诺。

## 报告问题

请附上：Node 版本、`node bench/run.mjs --json` 的输出（或失败信息）、以及是否设置了 `OPENALEX_API_KEY`。
如果是 `daily budget exhausted`，那是当日额度用完（按出口 IP 共享，UTC 午夜重置），不是 bug，
配一个免费 key 再试；不要为此开 issue。
