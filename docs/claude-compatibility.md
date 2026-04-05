# Claude 兼容性

## 当前已覆盖

- 基于已存储 `sessionId` 的 session 续接
- 静态段与动态段结合的结构化 system prompt 组装
- `plan mode` 的进入与退出审批链路
- `AskUserQuestion` 到 pending interactions 的桥接
- `AskUserQuestion` 的单选 / 多选答案解析与飞书卡片回填
- 主 `result` 之后的 sub-agent drain
- tool summary、task updates 与 agent 生命周期渲染

## 当前缺口

- system prompt 虽然已经按 Claude Code 的结构分段重建，但还没有做到逐字贴近上游文案。
- 权限策略目前仍是简化兼容实现，还不是 CLI 那套完整的 Bash AST / 文件安全管线。
- 飞书渲染仍以 turn 卡片为主，还没有覆盖 Claude Code transcript 的全部细节。
- session 状态变化虽然已做标准化处理，但 mode-change 事件目前还没有暴露给 renderer。

## 已确认的兼容性决策

- `query().isSingleUserTurn = false` 仍保留为 runtime 兼容补丁，用来确保子 agent 通知能在 SDK stream 关闭前排空。
- Agent runtime 目前基于 Agent SDK v1-compatible 行为实现，v2 preview 不是首版的硬依赖。
- `CLAUDE.md` 会作为动态 prompt section 加载，查找顺序是 workspace，再到用户作用域。
