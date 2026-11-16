# ForkRecheck 验证记录

运行时间为 2026 年 11 月 17 日（UTC+8）。环境为 macOS ARM64、Node 24.22.1、npm 11.6.2、Python 3.9.6。通过 npm 打包安装、TypeScript 类型检查、14 项自动化测试和 CLI 演示。测试包含真实 Pi SDK 对模拟流式响应的处理、GitHub REST 路由模拟和 Git worktree 运行。以下产物路径相对于项目目录。

## 实时 verl #8676

- 01:39（UTC+8）匿名运行真实只读 GitHub 采集。PR 为 open，REST 返回 head `9a75bbb573f32599d56dc154f79a9f98ab0b112e`、base `8c94a12d7811030413cd85e2bba6db863e0913c8`，交付前复核一致。参见 [PR](https://github.com/verl-project/verl/pull/8676)。
- 采集结果为 `request-authorization`。八个抽查的当前 Actions 运行页面给出了同一 PR 的维护者批准提示。CLA 和 CodeRabbit 返回成功。可查看 [GPU 工作流样本](https://github.com/verl-project/verl/actions/runs/43275927333) 和另行访问的 [pre-commit 工作流](https://github.com/verl-project/verl/actions/runs/43275927157)。
- REST 返回的临时合并候选 `4e048ff19d2fd61f21bb5ec936e0e487e3e2e36b` 的第一父提交是 `ca439aa5afcfe913c075570a9cb3f0f83730904d`，与 PR REST 的 base 不同。报告保留两者，标记临时合并归属无法核实。头提交关联的批准状态不代表工作流实际运行了测试。
- 保留了 3 条旧 inline 评审的原始 SHA。实时匿名 REST 无法给出 resolved 状态。另行查阅的 GitHub 连接器返回其中两条已解决，分隔符线程当次显示未标记解决。旧分隔符评审的原始提交为 `b8d3946`，匹配到的当前 diff 上下文只表示值得复查。参见 [分隔符评审](https://github.com/verl-project/verl/pull/8676#discussion_r4554055009)。
- 实时 CLI 停在授权判断。随后在独立 worktree 检出准确的当前 head `9a75bbb`，运行相同的 CPU 回归，四例全部通过，记录见 `.fork-recheck/final/current-head-cpu.json`。上游本地 checkout 保持干净。真实失败日志在当前 PR 中没有适用样本。自动化测试覆盖按运行 attempt 请求日志、令牌留在 GitHub API 域名和日志绑定的行为。

实时报告位于 `.fork-recheck/final/live/run-LV95Fw/report.md`，同目录有原始快照、JSON 报告和版本复核记录。

## 真实历史离线回放

- 回放证据时点为 2026-11-13 01:37:38（UTC+8）。挑选了 `b8d3946` 上的分隔符评审和此前 `1f39792` 上的变量格式评审摘要。代码、测试和许可证用本地 Git 对象导出并校验 blob。未使用随后 `9a75bbb` 的提交内容作为模型输入。参见 [历史提交](https://github.com/verl-project/verl/pull/8676/commits/b8d3946cce40920605c6d9d92528d5f2214d116a)。
- 衍生测试脚本与固定提案是为项目编写的回放材料。原始评审示例和两条构造的组合反例在修复前都产生误判，目标命令退出 42。补丁应用后，同一脚本的四条回归用例及 16 个历史用例函数通过，两项命令均退出 0。
- 独立 `verify` 对补丁、配置、用例和 checkout 进行匹配，从新 worktree 再次得到 (42, 0, 0) 的退出码。另在完整 verl 仓库的原始 `b8d3946` worktree 重做基线、补丁和相关用例，得到同一补丁哈希和相同退出码。执行记录见 `.fork-recheck/final/original-history-cpu.json`。隔离的 CPU 评分范围之外还包括完整 pytest 集成、远程 CI 和 GPU/NPU。

历史报告和补丁位于 `.fork-recheck/final/demo/run-iA6GNQ/`，独立复验位于 `.fork-recheck/final/verify/run-WRHAaH/`。其他五条固定回放记录位于 `.fork-recheck/final/cases/`。

## 对照评测

一次固定的六例对照，每组各六次。一个重建的真实历史案例加五个合成案例。两组用同一套确定性模拟提案及同样的可读证据和源码工具。评测产物位于 `.fork-recheck/final/evaluation/run-Nv29WK/`。

| 指标 | 直接应用提案 | Harness |
| --- | ---: | ---: |
| 下一步分类正确 | 2/6 | 6/6 |
| 不应启动编辑的四例中，实际启动候选编辑 | 4/4 | 1/4 |
| 交付的候选通过独立复验 | 4/6 | 2/2 |
| 两个应修复的案例通过独立复验 | 2/2 | 2/2 |

直接组的 4 个复验通过中有 2 个源自不适合触发修复的场景。Harness 在版本更新案例里完成了隔离的尝试，交付前发现 base 漂移并扣留补丁，因此该案例计入错误编辑触发一次。模拟提案有意在不可修样本也尝试编辑。结果衡量这个策略下门禁的作用，样本不适合估计真实模型质量或泛化率。

真实 Pi 单独尝试 `openai/gpt-5.4`，环境未提供可用模型凭证，流程在模型选择阶段停止。运行记录位于 `.fork-recheck/final/real-pi/run-Py7Zrt/`。拿到模型凭证后可用同一评测入口重新比较。
