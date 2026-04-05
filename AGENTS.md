# 仓库指南

## 项目结构与模块划分

本仓库是一个基于 `pnpm` workspace 的飞书优先 Agent Bridge。

- `apps/bridge`：可执行入口与运行时装配。
- `packages/core`：共享契约、事件类型、编排器与内存存储。
- `packages/runtime-claude`：Claude 运行时兼容层、会话、权限与提示词组装。
- `packages/channel-feishu`：飞书消息接入、卡片渲染、交互处理与入站去重。
- `tests`：Vitest 测试，覆盖 reducer、提示词、drain 逻辑与持久化辅助模块。
- `docs`：架构、兼容性、设计决策、协议、错误记录与开发阶段文档。

## 项目目标与参考基线

- 当前目标是用 TypeScript 实现“飞书承载 Claude Code 风格工作流”的新版 bridge，并逐步逼近原生体验。
- 长期目标是演进为通用桥接内核：允许不同 IM（如飞书、企业微信、Matrix）接入不同 Agent Runtime（如 Claude Code / Codex 风格）。
- 当前阶段只实现“飞书接入 Claude 风格 Agent Runtime”，但设计上必须为多 IM、多 Runtime 预留清晰边界。
- 历史实现参考路径（本地自定义，可按需替换）：
  `<local-history-reference-path>`
- 行为观察与实验性参考实现路径（本地自定义，可按需替换）：
  `<local-experimental-reference-path>`
- 行为分析日志参考路径：
  `${HOME}/.claude/debug/<debug-session-id>.txt`
- 参考官方文档：
  `https://platform.claude.com/docs/en/agent-sdk/typescript-v2-preview`
  `https://open.feishu.cn/document/server-docs/im-v1/introduction`
- 更完整的长期目标、实现约束与协作约定见：
  [docs/project-constraints.md](docs/project-constraints.md)

## 构建、测试与开发命令

- `pnpm dev`：启动本地飞书 Bridge。
- `pnpm build`：使用 TypeScript project references 构建整个 workspace。
- `pnpm typecheck`：执行严格的 TypeScript 类型检查。
- `pnpm test`：运行一次 Vitest 测试。
- `pnpm lint`：运行 ESLint 基线检查。
- `pnpm format:check`：检查 Prettier 格式一致性。
- `pnpm verify:repo-hygiene`：检查仓库索引中没有被错误纳入版本控制的构建产物。
- 仓库已接入 GitHub Actions CI：对 `push` / `pull_request` 自动执行 `pnpm verify:repo-hygiene`、`pnpm install --frozen-lockfile`、`pnpm format:check`、`pnpm lint`、`pnpm typecheck`、`pnpm test`、`pnpm build`。

常用组合：

```bash
pnpm typecheck && pnpm test
```

提交前如果改动影响运行逻辑、类型契约或构建链路，默认应先在本地跑通：

```bash
pnpm install --frozen-lockfile
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm verify:repo-hygiene
```

运行与构建产物相关的约束：

- `dist/` 属于本地或 CI 生成的构建产物，可以生成，但不应提交到 Git。
- `pnpm start` 依赖已生成的 `dist`，因此启动前应先执行 `pnpm build`。
- CI 始终从源码安装并构建，不依赖仓库中预置的 `dist`。

## 编码风格与命名约定

- 语言为 TypeScript ESM，运行环境为 Node 22+。
- 缩进使用 2 个空格；除非文件本身已有 Unicode，否则默认使用 ASCII。
- 类名使用 `PascalCase`，变量和函数使用 `camelCase`，文件名保持语义清晰，例如 `BridgeOrchestrator.ts`。
- 优先保持模块边界清晰，避免跨包泄漏实现细节；通道层不要依赖 Claude SDK 私有类型。
- 仓库已配置 ESLint 与 Prettier，提交前请优先通过 `pnpm lint` 与 `pnpm format:check`。

## 测试规范

- 测试框架使用 `vitest`。
- 测试文件放在 `tests/*.test.ts`。
- 改动 reducer、会话状态、提示词组装、持久化或消息去重时，必须同步补充或更新测试。
- 修复回归问题时，优先先写最小复现测试。

## 提交与合并请求规范

- 提交信息遵循当前历史风格：简短、祈使句，例如 `Harden Feishu interaction flow`。
- 尽量让一次提交只对应一个清晰的修改主题。
- 每完成一个大的开发节点，都要更新 `docs/development-stages.md`，记录完成内容、已知问题和下一阶段计划，再连同代码一起提交。
- 合并请求应说明用户可见变化、配置变化、风险点与未完成事项。

## 开发规范补充

- 所有沟通默认使用中文，新增文档也默认使用中文版。
- 这是一个重新设计的项目，优先做系统化设计，不要只追求最小改动或兼容旧结构。
- 设计和实现优先对齐 Claude Code 风格工作流的真实行为，建议结合历史实现、实验性参考实现与调试日志逐模块比对实现。
- 实现顺序优先按 Claude Code 模块逐个逼近，例如：system prompt、session/resume、权限模式、AskUserQuestion、plan mode、sub-agent drain、渲染与交互。
- 讨论中形成的约定、设计决策和边界条件，要及时沉淀到 `docs/`，不要只留在对话里。
- 遇到的错误、排障结论和已知陷阱，要更新到 `docs/errors/` 或阶段文档，避免重复踩坑。
- 如果某次改动明显改变开发流程、运行方式或约束，需要同步更新本文件。
- 如果 `@anthropic-ai/claude-agent-sdk` v2 不稳定或能力缺失，优先采用 v1 兼容实现去逼近 v2/Claude Code 行为，不要为了追新版本牺牲行为一致性。
- 对 `query` 消息流、turn 结束、子 agent 排空等问题，优先参考历史实现中已验证的特殊处理，不要轻易删掉这类兼容逻辑。
- 更细的约束、边界与当前确认规则，统一维护在：
  [docs/project-constraints.md](docs/project-constraints.md)

## 安全与配置提示

- 运行依赖飞书和 Claude 相关环境变量，禁止将密钥硬编码进源码。
- 工作区目录由 `CODING_CLAW_WORKSPACE_ROOT` 控制，本地默认使用 `${HOME}/.feishu-claude`。
- 如果 Claude 运行时启动失败，优先检查 `CODING_CLAW_CLAUDE_PATH` 是否指向正确的 Claude Code 原生可执行文件。
