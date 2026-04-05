# Contributing to Coding Claw

感谢你愿意为 Coding Claw 做贡献。

这个项目当前仍处于早期演进阶段，重点不是“快速堆功能”，而是 **持续对齐 Claude Code 行为、保持分层边界清晰，并把兼容性偏差沉淀成文档与测试**。

## 在开始之前

建议先阅读这些文档，理解项目边界与设计约束：

- [`README.md`](./README.md)
- [`docs/architecture.md`](./docs/architecture.md)
- [`docs/claude-compatibility.md`](./docs/claude-compatibility.md)
- [`docs/project-constraints.md`](./docs/project-constraints.md)
- [`docs/development-stages.md`](./docs/development-stages.md)

如果你的改动涉及控制命令、交互协议、权限行为或 runtime 对齐，请同步阅读：

- [`docs/protocols/interactions.md`](./docs/protocols/interactions.md)
- [`docs/protocols/bridge-events.md`](./docs/protocols/bridge-events.md)
- [`docs/decisions/0003-control-commands.md`](./docs/decisions/0003-control-commands.md)

## 环境准备

### 要求

- Node.js >= 22
- pnpm 10.30.2

### 安装依赖

```bash
pnpm install
```

### 配置环境变量

复制示例环境文件并按需填写：

```bash
cp .env.example .env
```

至少需要准备：

- `FEISHU_APP_ID`
- `FEISHU_APP_SECRET`

其余变量请参考 `.env.example` 与 `README.md`。

## 本地开发

启动 bridge：

```bash
pnpm dev
```

构建：

```bash
pnpm build
```

## 提交前检查

提交前请至少执行：

```bash
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm verify:repo-hygiene
```

说明：

- `verify:repo-hygiene` 会阻止将 `dist/` 等构建产物作为 tracked files 提交。
- 请不要提交 `.env`、日志、临时状态文件或本地产生的 `.claude/` 工作目录内容。

## 贡献原则

### 1. 优先保持架构边界

请尽量遵守当前分层：

- `packages/core`：稳定契约、orchestrator、状态存储接口、控制命令、render model
- `packages/runtime-claude`：Claude 运行时适配、system prompt、session、权限模型
- `packages/channel-feishu`：飞书消息接入、卡片渲染、回调处理
- `apps/bridge`：应用装配与启动入口

避免：

- 在 channel 层写 runtime 私有逻辑
- 在 runtime 层直接依赖飞书 payload 结构
- 为了一个局部需求破坏 bridge core 的抽象边界

### 2. 优先对齐真实行为，而不是“看起来能用”

如果你在修复或新增 Claude Code 兼容能力，请优先关注：

- 行为是否接近真实 Claude Code
- 是否与现有 prompt / tool / interaction 约束一致
- 是否会影响 plan mode、approval、question、sub-agent 等链路

### 3. 变更要附带测试或文档

以下类型的改动，至少补其一，最好两者都补：

- **行为改动**：补测试
- **兼容性偏差 / 平台限制**：补文档
- **架构决策**：补 `docs/decisions/`
- **阶段性里程碑**：补 `docs/development-stages.md`

### 4. 不要提交构建产物

仓库禁止跟踪 `dist/` 等构建目录。

如果你发现提交里混入了构建结果，请先清理再提交。

## 提交规范

当前仓库没有强制的 commitlint 规则，但建议：

- 提交标题简洁、明确
- 说明“为什么改”，而不只是“改了什么”
- 一次提交聚焦一个相对独立的变更

示例：

- `fix feishu question card answer mapping`
- `refactor permission engine scope resolution`
- `docs record agent teams feature gate behavior`

## Pull Request 建议

建议 PR 描述至少包含：

- **Summary**：这次改动解决了什么问题
- **Why**：为什么需要这次改动
- **Test plan**：你如何验证它
- **Docs updated**：是否同步更新了相关文档

如果改动会影响以下链路，请在 PR 中明确说明：

- Feishu 卡片交互
- 权限审批
- `AskUserQuestion`
- `ExitPlanMode`
- 控制命令
- sub-agent / team 能力

## 文档更新建议

遇到以下情况时，建议同步更新文档：

- 新发现一个真实平台限制或坑：更新 `docs/errors/known-pitfalls.md`
- 新完成一个阶段性大节点：更新 `docs/development-stages.md`
- 新增或调整核心决策：更新 `docs/decisions/`
- 调整协议结构：更新 `docs/protocols/`

## 安全与敏感信息

请不要：

- 提交任何 token、app secret、cookie、日志脱敏前原文
- 把本地绝对路径、个人机器特定配置硬编码到仓库
- 提交包含敏感工作区内容的测试快照或调试输出

如果你发现了安全问题，请不要直接公开提交利用细节。建议私下联系维护者处理，并在问题修复后再决定如何公开披露。

## 讨论风格

欢迎提交：

- bug 修复
- 兼容性改进
- 文档完善
- 测试补齐
- 小步、清晰、可验证的重构

相比“大而全”的一次性改造，这个项目更偏好：

- 小步提交
- 明确边界
- 有据可依的对齐
- 可回归验证的演进

感谢你的贡献。
