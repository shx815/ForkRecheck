# ForkRecheck

ForkRecheck 是面向开源贡献者的本地 CLI。它读 GitHub Fork PR 的版本、diff、评审和 CI，给出下一步。在用户显式开启修复时，它让 Pi 提出回归目标和源码编辑，然后在独立 Git worktree 中复现、验收并交付本地补丁。

## 安装

需要 Node.js 24.12+、npm 和支持 worktree 的 Git。verl 历史回放还需要 Python 3.9+。当前验证环境为 macOS ARM64。

```sh
cd ForkRecheck
npm ci
npm run build
node dist/cli.js --help

# 如需把 fork-recheck 安装到 PATH
npm pack
npm install -g ./fork-recheck-0.1.0.tgz
fork-recheck --help
```

以下命令可用 `node dist/cli.js` 替换 `fork-recheck`。

## 检查 GitHub PR

```sh
fork-recheck check https://github.com/verl-project/verl/pull/8676 --repo ../verl
```

公共 PR 可匿名读取。可通过 `GH_TOKEN` 或 `GITHUB_TOKEN` 提供已有只读访问权限。认证后 CLI 会尝试查询评审线程的 resolved 状态。Actions 日志仍取决于仓库、运行和凭证的可见性。

ForkRecheck 用 head SHA 和 base SHA 夹住采集窗口。只有验证了两个父提交，才把 GitHub 的临时合并提交用作当前版本的证据。Actions API 报告的 `head_sha` 用于归属判断。工作流实际 checkout 由其配置决定。对于旧评审，报告保留原始 SHA，并检索当前 diff 是否还有相应上下文。旧锚点匹配后仍需要用例复现。

维护者授权结论要求当前 Actions 运行元数据匹配 PR，并找到运行页面上指向此 PR 的批准提示。单独的 `action_required`、权限错误或不可访问的日志会留下证据缺口。当前 CI 失败会报告运行结论和日志可见性。只有本地基线用例达到预先声明的失败条件，才会执行源码编辑。

## 触发修复和复验

先给仓库准备一份由自己维护的配置。示例使用随附的 [verl CPU 配置](fixtures/verl/config.json) 和已登录的 Pi 模型。把 `PROVIDER/MODEL` 替换为本机实际可用的模型 ID。

```sh
# 如本地缺少确切 PR head，可从上游仓库获取这个 PR 的 ref
git -C ../verl fetch origin refs/pull/8676/head

fork-recheck check https://github.com/verl-project/verl/pull/8676 \
  --repo ../verl --fix --config ./fixtures/verl/config.json \
  --model PROVIDER/MODEL

# 用上一条命令输出的运行目录
fork-recheck verify /path/to/run-folder --repo ../verl --config ./fixtures/verl/config.json
```

Pi SDK 固定为 `@earendil-works/pi-coding-agent@1.5.2`。使用 Pi 自己的凭证或供应商环境变量。SDK 会收到截取后的评审、日志和 diff，也可通过受控工具读取当前 worktree 内的受 Git 跟踪文本。模型返回目标 ID、证据 ID 和精确文本替换。Harness 运行配置里的命令，写入允许修改的文件，并记录执行结果。使用自己信任的仓库版本、Pi 配置和测试命令。Git worktree 隔离检出和编辑，测试进程仍使用本机权限。

可从这份 [完整配置](fixtures/verl/config.json) 开始。

- `hardware` 声明本机使用 CPU 或 GPU。GPU 目标在 CPU 配置下会记入未覆盖范围。用 `setup` 检查实际设备或依赖。
- `editable` 列出 Pi 可修改的现有仓库相对文件。每次替换要求旧文本唯一匹配。
- `targets[].argv` 和可选的 `setup` 为参数数组，直接启动进程。`{configDir}` 指向配置文件目录，`{node}` 指向 CLI 使用的 Node。工作目录为被测 worktree。
- `targets[].paths` 将评审文件绑定到回归目标。`requires` 声明依赖。`inputs` 列出要做 SHA-256 保护的配置相对文件，例如独立回归脚本。`timeoutMs` 分别限制预检和测试进程。
- 回归目标同时要求 `fail.exitCode` 和一整行 `fail.marker` 确认预期故障。通过要求退出码 0 与独立的整行 `passMarker`。测试入口应在确认具体断言结果后打印标记。相关目标也要求通过标记。
- `uncovered` 记录本地配置未覆盖的检查。

Harness 在干净检出上先确认预期故障，再于新 worktree 应用候选补丁，运行同一个回归及适用的相关测试。复验使用另外两个 worktree，校验补丁、配置和脚本哈希。采集或交付前发现版本变化时，会保留对应旧快照的记录并提供重跑命令。工作流以本地补丁和报告为终点。

## 离线演示

无需 GitHub 登录或模型凭证。默认响应来自固定的模拟提案。

```sh
fork-recheck replay verl
# 示例输出
# patch-verified | reproduce
# .../run-XXXXXX/report.md
# .../run-XXXXXX/report.json

fork-recheck verify /path/to/run-folder
fork-recheck replay fix
fork-recheck replay authorization
fork-recheck replay old-failure
fork-recheck replay missing-dependency
fork-recheck replay updated
```

历史回放锁定 [CodeRabbit 的分隔符评审](https://github.com/verl-project/verl/pull/8676#discussion_r4554055009) 和当时的 `b8d3946`。三个历史文件来自该提交并核验 Git blob ID。回放仓库的 Git 提交与原 PR SHA 分别记录。独立测试脚本复验评审示例及自行编写的 LaTeX 混合文本、花括号下标和希腊变量组合。基线命中三个误判，补丁后四个用例通过。同一回放同时运行历史测试文件里的 16 个用例函数。历史用例通过精简的参数化装饰器适配器运行，覆盖范围是隔离的 CPU 评分函数。

真实模型需要单独显式开启。保留 `--out` 区分两类演示。

```sh
fork-recheck replay verl --model PROVIDER/MODEL --out .fork-recheck/real-pi
```

## 测试与评测

```sh
npm run typecheck
npm test
fork-recheck eval --out .fork-recheck/evaluation
fork-recheck eval --model PROVIDER/MODEL --out .fork-recheck/model-evaluation
```

评测两组共享任务、证据、工作区文件、Pi 工具和每次调用预算。直接组应用模型提案，Harness 组先做证据判断、故障复现和交付前版本核对。相同的独立复验程序评分，按样本统计下一步判断、错误编辑触发以及复验通过率。[实测记录](docs/validation.md) 包含样本量、限制和证据。

## 运行产物

每次运行在 `--out` 中建立自己的子目录，默认位于 `.fork-recheck/`。

| 文件 | 内容 |
| --- | --- |
| `snapshot.json` | 原始版本、diff、评审、检查、日志可见性及采集缺口 |
| `events.jsonl` | 阶段、命令执行记录、交付前版本复核 |
| `agent.jsonl` | 模型文本、工具事件和结构化提案 |
| `report.md` / `report.json` | 人可读和机器可读报告，包括下一步、校验命令和覆盖范围 |
| `patch.diff` / `patch.json` | 通过验收且版本有效的补丁及校验清单 |

固定输入回放的 SHA 与 GitHub 实时快照分开记录。自动化评测会生成 `evaluation.json` 和 `evaluation.md`，并保留每组报告与复验记录。
