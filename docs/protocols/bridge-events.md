# Bridge Event Protocol

## Purpose

`BridgeEvent` is the only event contract shared across runtimes, stores, and render surfaces.

## Required Properties

- Every event carries `chatId` and `turnId`.
- Runtime-specific debug payloads must use `runtime.raw`.
- Human-facing renderers should prefer normalized events over `runtime.raw`.

## Current Emitted Event Families

- Turn lifecycle: `turn.started`, `turn.completed`
- Streaming text: `turn.text.delta`
- Tool lifecycle: `turn.tool.started`, `turn.tool.summary`
- Agent lifecycle: `turn.agent.updated`
- Task lifecycle: `turn.tasks.updated`
- Interaction lifecycle: `interaction.requested`, `interaction.resolved`
- Session lifecycle: `session.mode.changed`
- Debug payloads: `runtime.raw`

## Reserved But Not Yet Emitted

- 当前无额外保留但未发出的事件类型。

`turn.tool.updated` 已从当前共享事件协议中移除；若后续需要引入更细的工具中间态事件，应在明确语义后再重新加回。

## Rendering Rule

Renderers should reduce events into a single turn model, then project it into the destination channel. They should not try to reconstruct SDK message trees themselves.
