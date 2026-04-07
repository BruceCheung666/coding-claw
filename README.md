# Coding Claw

一个以飞书为首个落地点、尽量对齐 Claude Code 原生行为的 Agent Bridge / Bridge Kernel。

当前主链路是：

> Feishu Channel -> Bridge Core -> Claude Runtime

项目目标不是只做一个“飞书机器人”，而是先实现 **Feishu 接入 Claude Code**，再逐步演进为支持 **多 IM 渠道** 与 **多 Agent Runtime** 的通用桥接内核。

## 特性

- **Claude Code 兼容导向**：围绕 system prompt、session resume、plan mode、AskUserQuestion、权限审批、sub-agent drain 等行为持续逼近原生体验。
- **清晰的分层边界**：拆分为 `core`、`runtime-claude`、`channel-feishu`、`apps/bridge`，便于后续扩展新渠道或新 runtime。
- **飞书交互支持**：支持 turn 级进度卡片、提问卡片、权限审批卡片、plan approval 卡片等交互流程。
- **控制命令体系**：内置 `/agent`、`/shell`、`/chat`、`/help` 等 bridge 级命令，避免把控制逻辑混进模型对话。
- **权限与风险控制**：对高风险 Bash、工作区外路径、敏感写入等场景进行范围化审批。
- **测试与 CI 基线**：内置 Vitest、ESLint、Prettier，并通过 GitHub Actions 执行格式、类型、测试和构建校验。

## 当前状态

项目目前处于 **早期可用 / 持续对齐阶段**：

### 已覆盖能力

- 基于 `sessionId` 的 session 续接
- 结构化 system prompt 组装
- `plan mode` 的进入与退出审批
- `AskUserQuestion` 到飞书交互卡片桥接
- 单选 / 多选问题答案回填
- 主结果之后的 sub-agent drain
- tool summary、task updates 与 agent 生命周期渲染

### 当前缺口

- system prompt 还未做到逐字贴近上游 Claude Code 文案
- 权限策略仍是兼容实现，尚未完整复刻 CLI 级 Bash AST / 文件安全管线
- 飞书渲染还未覆盖全部 transcript 细节
- 部分 mode-change / 更细粒度事件尚未完全暴露给 renderer

如果你希望它像一个“可研究、可演进的 Claude Code bridge 内核”来看待它，而不是一个已经完全产品化的 bot，那么你会更容易理解这个仓库当前的定位。

## 架构概览

```text
Feishu Channel
    ↓
Bridge Core
    ↓
Claude Runtime
```

仓库采用 `pnpm workspace` monorepo：

```text
apps/
  bridge/                # 可执行入口与运行时装配
packages/
  core/                  # 稳定契约、BridgeOrchestrator、stores、render reducer
  runtime-claude/        # Claude 兼容 runtime、session、权限、system prompt
  channel-feishu/        # 飞书消息接入、卡片渲染、交互回调
docs/                    # 架构、协议、兼容性、阶段记录、错误文档
tests/                   # Vitest 测试
```

更详细的设计可以参考：

- `docs/architecture.md`
- `docs/claude-compatibility.md`
- `docs/project-constraints.md`
- `docs/protocols/interactions.md`
- `docs/development-stages.md`

## 内置控制命令

当前已实现的 bridge 级命令包括：

- `/agent mode [default|acceptEdits|bypassPermissions|plan|dontAsk]`
- `/agent model [model-name]`
- `/agent status` 或 `/as`
- `/reset`
- `/shell exec <command>` 或 `/sx <command>`
- `/shell status` 或 `/ss`
- `/chat status` 或 `/cs`
- `/help` 或 `/h`

说明：

- 普通文本默认进入 runtime 对话流。
- 以 `//` 开头的文本会做 slash escape，按普通文本处理。
- `/shell` 提供的是 **持久命令上下文**，不是完整 PTY 终端。

## 技术栈

- **Language**: TypeScript (ESM)
- **Runtime**: Node.js 22+
- **Workspace**: pnpm workspace
- **Testing**: Vitest
- **Lint / Format**: ESLint + Prettier
- **Channel**: Feishu / Lark Open Platform SDK
- **Agent Runtime**: `@anthropic-ai/claude-agent-sdk`

## 环境要求

- Node.js >= 22
- pnpm 10.30.2（建议与仓库保持一致）
- 可用的飞书应用配置
- 可用的 Claude Code / Claude Agent Runtime 环境

## 快速开始

### 1. 安装依赖

```bash
pnpm install
```

### 2. 配置环境变量

至少需要准备以下环境变量：

```bash
FEISHU_APP_ID=your_feishu_app_id
FEISHU_APP_SECRET=your_feishu_app_secret

# 工作区根目录；未配置时默认使用 <repo>/.claude/workspaces
CODING_CLAW_WORKSPACE_ROOT=/absolute/path/to/workspaces

# 可选：指定 Claude 模型
CLAUDE_MODEL=claude-sonnet-4-6

# 可选：桥接默认语言，默认 zh-CN
CODING_CLAW_LANGUAGE=zh-CN

# 可选：指定 Claude Code 可执行文件路径
CODING_CLAW_CLAUDE_PATH=/absolute/path/to/claude

# Windows 下建议显式指定 Git Bash 路径
CLAUDE_CODE_GIT_BASH_PATH=C:\\Path\\To\\Git\\usr\\bin\\bash.exe

# 可选：指定 shell，未配置时回退到 /bin/sh
CODING_CLAW_SHELL=/bin/bash

# 可选：启用 Agent Teams 能力
CODING_CLAW_ENABLE_AGENT_TEAMS=1
```

> 注意：不要把密钥、token 或其他凭据硬编码进源码，也不要提交到仓库。
>
> Windows 部署、双 env 模板与排障流程见：
> - `docs/simple-deployment-guide.md`
> - `docs/deployment/env.official.example`
> - `docs/deployment/env.proxy.example`

### 3. 启动开发环境

```bash
pnpm dev
```

启动后会运行 `apps/bridge`，装配 Claude runtime、bridge core 与 Feishu channel adapter。

### 4. 生产启动

```bash
pnpm build
pnpm --filter @coding-claw/bridge start
```

> `pnpm start` 依赖已生成的 `dist`，因此启动前必须先执行 `pnpm build`。
>
> Windows 用户更建议使用仓库脚本：
>
> ```powershell
> powershell -ExecutionPolicy Bypass -File .\scripts\windows\start-bridge.ps1 -Prod
> powershell -ExecutionPolicy Bypass -File .\scripts\windows\logs-bridge.ps1 -Wait
> powershell -ExecutionPolicy Bypass -File .\scripts\windows\stop-bridge.ps1
> ```

## 常用命令

```bash
pnpm dev                # 启动本地 bridge
pnpm build              # 构建整个 workspace
pnpm typecheck          # TypeScript 类型检查
pnpm test               # 运行测试
pnpm lint               # ESLint 检查
pnpm format:check       # Prettier 检查
pnpm verify:repo-hygiene
```

推荐在提交前执行：

```bash
pnpm install --frozen-lockfile
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm verify:repo-hygiene
```

## CI

仓库已配置 GitHub Actions，在 `push` / `pull_request` 时执行：

- `pnpm verify:repo-hygiene`
- `pnpm install --frozen-lockfile`
- `pnpm format:check`
- `pnpm lint`
- `pnpm typecheck`
- `pnpm test`
- `pnpm build`

## 设计原则

- **行为一致性优先**：优先对齐 Claude Code 的真实行为，而不是只实现表面功能。
- **边界清晰优先**：channel 不依赖 runtime 私有结构，runtime 不依赖渠道 payload 细节。
- **文档先行沉淀**：重要约束、兼容性偏差、排障结论优先写入 `docs/`。
- **面向扩展**：当前只落地 Feishu + Claude，但架构需为多 IM / 多 Runtime 留边界。

## 路线图

接下来重点包括：

- 继续对齐 Claude Code 的 system prompt 与权限行为
- 完善 TeamCreate / TeamDelete / SendMessage 等 team 能力语义
- 将 workspace/session/approval 等状态从内存升级为可恢复存储
- 补齐更多飞书端到端交互与卡片渲染细节
- 增加更多兼容回归测试与真实环境联调

## 文档索引

- [架构说明](docs/architecture.md)
- [Claude 兼容性说明](docs/claude-compatibility.md)
- [项目约束](docs/project-constraints.md)
- [交互协议](docs/protocols/interactions.md)
- [开发阶段记录](docs/development-stages.md)
- [已知问题与坑点](docs/errors/known-pitfalls.md)

## 开源建议

当前仓库已经补齐这些基础开源文件：

- `.env.example`
- `CONTRIBUTING.md`
- `SECURITY.md`
- `CODE_OF_CONDUCT.md`
- `LICENSE`

如果你继续对外公开完善，下一步更建议补充：

- GitHub Releases / Changelog 说明
- 示例配置或最小可运行演示
- 更完整的 FAQ / Troubleshooting 文档

当前 README 先聚焦于项目定位、结构、运行方式与设计边界。

## License

本项目基于 [MIT License](./LICENSE) 开源。
