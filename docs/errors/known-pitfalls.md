# Known Pitfalls

## Sub-agent Drain

- Symptom: the main result arrives, but child agent notifications never render.
- Cause: Agent SDK query closes stdin early for single-turn string prompts.
- Current mitigation: patch `isSingleUserTurn = false` and explicitly close when child tasks finish, the session reports `idle`, or the drain timeout is hit.

## Permission Deadlock

- Symptom: the runtime waits on tool approval and the bridge appears frozen.
- Cause: interaction requests were produced inside `canUseTool`, but no bridge-visible event was emitted before awaiting approval.
- Current mitigation: runtime writes interaction events into its own async bridge queue, not directly into the SDK iterator.

## Prompt Drift

- Symptom: behavior differs from Claude Code even though tool wiring is correct.
- Cause: prompt content and dynamic sections drift over time and are easy to lose during refactors.
- Current mitigation: keep prompt assembly sectioned and document every intentionally omitted section.

## Agent Team Feature Gate

- 症状：日志里出现 `Team "xxx" does not exist. Call spawnTeam first to create the team.`，同时模型直接在 `Agent` 调用里带上 `team_name`。
- 原因：Claude Code 的 team/swarm 能力不是始终可用；它依赖 Team 工具族（`TeamCreate` / `TeamDelete` / `SendMessage`）和 `agent swarms` feature gate。若 bridge 未启用 team 能力、没把 Team 工具暴露给 SDK，或没给底层 `claude` 进程透传 `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`，模型就可能“想用 team_name，但没有建立 team 的能力”。当前代码路径不默认追加 `--agent-teams`，因为此前实测该 flag 在当前环境里会直接报错。
- 当前规避方式：
  - 配置上优先通过 `CODING_CLAW_ENABLE_AGENT_TEAMS=1` 开启 bridge 侧 team 能力；如需显式对齐上游或排查 feature gate，再同时确认 `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` 已透传到底层 Claude Code 进程。
  - 运行前显式确认 `llm query input.tools` 和 init 消息里的 `tools` 是否都包含 Team 工具。
  - system prompt 必须按当前工具集说明：有 Team 工具时先 `TeamCreate`，没有时禁止 `team_name`。
  - 若桥请求了 Team 工具但 init 返回里仍缺失，要优先检查底层 Claude Code feature gate，而不是只盯着渲染层或 sub-agent 状态机。
  - 需要区分“bridge 已请求 team 能力”和“底层 Claude Code 实际返回 Team 工具”这两个层次；前者成立并不自动保证后者成立。

## Feishu Card Schema Uniqueness

- 症状：发送或更新飞书交互卡片时收到 `400`，日志中出现 `ErrCode: 11310`、`duplicate` 或类似 schema 校验错误。
- 原因：同一张卡片内某些字段必须唯一，尤其是 button 的 `name`。当一张权限卡里渲染多个相同动作但不同 scope 的按钮时，如果仍复用同一个 `name`，飞书会直接拒绝整张卡片。
- 当前规避方式：
  - 卡片内所有交互按钮的 `name` 必须包含足够的上下文，至少能区分 `action + interaction_id + scope_key`。
  - 任何新增多按钮、多 scope 或批量操作卡片时，都要补“同卡片按钮名唯一性”测试。
  - 遇到新的飞书 schema 约束时，除了修代码，还要同步补到本文件并增加最小回归测试。

## Feishu Button Name Length Limit

- 症状：发送或更新飞书交互卡片时收到 `400`，日志中出现 `ErrCode: 11310`，并提示 `name exceed the default maximum 100`。
- 原因：飞书 button 的 `name` 有长度上限。若把完整目录路径、scope key 或其他长上下文直接拼进 `name`，很容易超过限制。
- 当前规避方式：
  - button `name` 只能使用短前缀加稳定短哈希，不能直接拼接完整路径或原始 scope 文本。
  - 多 scope 按钮场景必须补“按钮名长度不超过 100”测试。
  - 交互语义所需的完整信息继续放在 `value` 中，`name` 只承担唯一标识职责。
