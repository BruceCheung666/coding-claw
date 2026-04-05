# Coding Claw 架构

## 目标

`coding-claw` 是一个在 IM 渠道中尽量保留原生 Agent 行为的 bridge kernel。当前首条落地链路是：

`Feishu channel -> bridge core -> Claude runtime`

仓库结构为后续扩展预留了明确边界：

- 新渠道：企业微信、Matrix
- 新运行时：Claude Code compatible、Codex compatible

## 包结构

- `packages/core`
  定义稳定契约：`AgentRuntime`、`RuntimeSession`、`RenderSurface`、各类 store、bridge events 与 orchestrator。
- `packages/runtime-claude`
  实现 Claude 兼容的 session 行为：system prompt 组装、权限/交互处理、session resume 与 sub-agent drain。
- `packages/channel-feishu`
  实现飞书入站、交互回调与卡片渲染。
- `apps/bridge`
  负责组装当前可部署服务。

## 事件流

1. `FeishuChannelAdapter` 将飞书文本入站事件转换为 `InboundChatMessage`。
2. bridge 级控制层判断当前文本是保留控制命令还是 runtime prompt。
3. `BridgeOrchestrator` 为 runtime prompt 获取或创建 workspace binding 与 runtime session。
4. `ClaudeRuntimeSession` 执行 prompt，并发出标准化的 `BridgeEvent`。
5. `TranscriptStore` 记录 turn 过程中产生的事件。
6. `FeishuRenderSurface` 将事件归约为一个 turn 级进度卡片，以及必要的交互卡片。
7. 卡片动作回流到 `BridgeOrchestrator.resolveInteraction`，继续等待中的 runtime 权限/提问流程。

## 设计规则

- channel 包不能依赖 Claude SDK 私有类型。
- runtime 包不能依赖飞书 payload 结构。
- bridge 控制命令，如 `/shell`、`/reset`，不能硬编码为 channel 私有行为。
- SDK 原始消息仅允许通过 `runtime.raw` 事件暴露，用于调试。
- 兼容性补丁、已知偏差与恢复出来的行为都必须先写文档，再做重构。
