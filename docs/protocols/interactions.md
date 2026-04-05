# Interaction Protocol

## Types

- `permission`
- `question`
- `plan-approval`

## Question Resolution Shape

- `question` 类型的 resolution 使用 `answers: Record<string, string | string[]>`。
- 单选题或纯文本题：
  - 返回 `string`
  - 例如：`{ frontend: "React + TypeScript" }`
- 多选题：
  - 返回 `string[]`
  - 例如：`{ stack: ["React", "Node.js"] }`
- 若题目提供“其他”输入框：
  - 单选题优先返回用户填写的补充文本
  - 多选题会把补充文本并入结果数组，而不是保留中间态占位值

## Lifecycle

1. Runtime emits `interaction.requested`.
2. The bridge persists the interaction in `ApprovalStore`.
3. The channel adapter renders a destination-specific UI.
4. The callback is translated into `InteractionResolution`.
5. `BridgeOrchestrator.resolveInteraction` forwards the resolution to the waiting runtime session.

## Non-Goals

- Channel packages do not decide policy.
- Runtime packages do not format destination-specific UI payloads.
