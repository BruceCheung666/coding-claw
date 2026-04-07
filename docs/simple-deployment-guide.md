# Coding Claw Windows 部署 SOP

## 1. 目标与适用范围

本文档用于在 Windows 环境部署 `coding-claw`，完成最小验收，并在出现问题时按固定顺序排障。

当前项目定位：

- 主链路：`Feishu Channel -> Bridge Core -> Claude Runtime`
- 当前更适合：本机自用、联调、内部演示
- 不适合直接视为“完全等同原生 Claude Code CLI 的产品化机器人”

## 2. 部署前先理解的最小背景

### 2.1 当前是飞书 WebSocket 长连接模式

本项目使用飞书 **WebSocket 长连接** 接收事件，不是 HTTP webhook。

这意味着：

- 本机**不需要公网暴露**
- 本机**不需要内网穿透**
- 只需要本机能正常出站访问飞书

### 2.2 workspace 与 chat 的关系

当前默认是 **每个飞书 chatId 绑定一个 workspace**：

- 不同飞书群 / 会话可以绑定不同项目
- 同一个 chat 里切项目，使用 `/reset <绝对路径>`

## 3. Windows 前置依赖

至少准备：

- Node.js 22+
- pnpm 10.x
- Claude CLI
- Git Bash
- 已创建并发布的飞书应用 / 机器人
- 本机可访问目标项目目录

建议先在仓库根目录执行：

```bash
pnpm install
pnpm build
```

## 4. 环境变量与模板

当前版本**不要假设会自动加载 `.env`**。最稳妥的方式仍然是显式 `export` 后启动，或者自己在启动脚本里先加载 `.env`。

仓库提供两套模板：

- 官方 / 直连模板：`docs/deployment/env.official.example`
- 代理 / 本地网关模板：`docs/deployment/env.proxy.example`

### 4.1 最少必填项

```bash
export FEISHU_APP_ID=<your-app-id>
export FEISHU_APP_SECRET=<your-app-secret>
export CODING_CLAW_WORKSPACE_ROOT=D:/coding-claw-workspaces
export CODING_CLAW_CLAUDE_PATH=C:/Users/your-user/.local/bin/claude.exe
export CLAUDE_CODE_GIT_BASH_PATH=D:\DEVELOP\Git\usr\bin\bash.exe
```

### 4.2 推荐项

```bash
export CLAUDE_MODEL=claude-sonnet-4-6
export CODING_CLAW_LANGUAGE=zh-CN
export CODING_CLAW_SHELL=bash
export CODING_CLAW_ENABLE_AGENT_TEAMS=1
export CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1
```

### 4.3 `/agent model` 默认 alias 映射

```bash
export ANTHROPIC_DEFAULT_SONNET_MODEL=claude-sonnet-4-6
export ANTHROPIC_DEFAULT_OPUS_MODEL=claude-opus-4-6
export ANTHROPIC_DEFAULT_HAIKU_MODEL=claude-haiku-4-5-20251001
export ANTHROPIC_DEFAULT_SONNET_1M_MODEL=claude-sonnet-4-6
export ANTHROPIC_DEFAULT_OPUS_1M_MODEL=claude-opus-4-6
```

当前项目中：

- `sonnet` / `opus` / `haiku` 是 alias
- `sonnet[1m]` 和 `opus[1m]` 作为 1M 上下文 alias 使用
- runtime 默认模型来自 `CLAUDE_MODEL`
- chat 级覆盖来自 `/agent model <name>`

### 4.4 代理模式额外配置

如果你不是直连默认 Claude 配置，而是走本地代理 / 自定义网关，再补：

```bash
export ANTHROPIC_BASE_URL=http://127.0.0.1:15721
export ANTHROPIC_AUTH_TOKEN=<your-token>
```

## 5. 飞书侧配置

### 5.1 订阅方式

选择：**长连接（WebSocket）**

### 5.2 建议权限

至少核对：

- `im:chat:readonly`
- `im:message.group_msg`
- `im:message.p2p_msg:readonly`
- `im:message:send_as_bot`
- `im:message:send_sys_msg`
- `im:message:update`
- `cardkit:card:write`

注意：

- 权限变更后通常需要重新发布应用
- 卡片渲染失败时，优先先查权限是否真的生效

## 6. 启动方式

### 6.1 开发态启动

```bash
export FEISHU_APP_ID=<your-app-id>
export FEISHU_APP_SECRET=<your-app-secret>
export CODING_CLAW_WORKSPACE_ROOT=D:/coding-claw-workspaces
export CODING_CLAW_CLAUDE_PATH=C:/Users/your-user/.local/bin/claude.exe
export CLAUDE_CODE_GIT_BASH_PATH=D:\DEVELOP\Git\usr\bin\bash.exe
export CLAUDE_MODEL=claude-sonnet-4-6
export CODING_CLAW_ENABLE_AGENT_TEAMS=1
export CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1
cd D:/Projects/coding-claw/apps/bridge
node --import tsx ./src/main.ts
```

### 6.2 构建态启动

```bash
cd D:/Projects/coding-claw
pnpm build
export FEISHU_APP_ID=<your-app-id>
export FEISHU_APP_SECRET=<your-app-secret>
export CODING_CLAW_WORKSPACE_ROOT=D:/coding-claw-workspaces
export CODING_CLAW_CLAUDE_PATH=C:/Users/your-user/.local/bin/claude.exe
export CLAUDE_CODE_GIT_BASH_PATH=D:\DEVELOP\Git\usr\bin\bash.exe
cd apps/bridge
node ./dist/main.js
```

## 7. 启动成功的判断方式

控制台至少应看到：

```text
[coding-claw] Feishu bridge started
[ws] ws client ready
```

如果已有旧实例，建议先停掉旧 bridge 再重启，避免多个实例同时占用飞书长连接。

## 8. 部署后最小验收

### 8.1 先测控制命令

在飞书发送：

- `/help`
- `/chat status`
- `/agent status`
- `/shell status`

如果这些都正常，说明：

- 飞书 <-> bridge 文本链路正常
- bridge 进程正常
- 基础状态查询正常

### 8.2 再绑定项目

优先使用文本命令：

```text
/reset D:\Projects\YourProject
```

然后再发：

- `/chat status`
- `/agent status`

确认 `cwd` / `workspace` 已切到目标项目。

### 8.3 再测普通自然语言

例如：

```text
看下当前项目状态
```

如果普通文本能进入 runtime，后台日志通常会依次看到：

- `[feishu] inbound message`
- `[bridge] start turn`
- `[runtime] llm query input`
- `[runtime] llm output message`

## 9. 常见问题与排障

### 9.1 `/agent status` 显示 `session: not-started`

这**不一定表示 bridge 挂了**。

更常见的含义是：

- 当前 chat 还没有一次成功的 runtime turn
- 控制命令可用，但普通文本还没真正把 Claude session 建起来

### 9.2 普通文本发了，但 Claude 没拉起来

优先看后台日志是否经过：

1. `[feishu] inbound message`
2. `[bridge] start turn`
3. `[runtime] llm query input`
4. `[runtime] turn error` 或 `[runtime] llm output message`

### 9.3 Claude CLI 在 Windows 上退出

优先检查：

- `CODING_CLAW_CLAUDE_PATH` 是否正确
- `CLAUDE_CODE_GIT_BASH_PATH` 是否指向真实存在的 Git Bash
- `CLAUDE_CODE_GIT_BASH_PATH` 是否使用 Windows 路径格式

### 9.4 卡片一直停在“任务已开始，正在整理上下文…”

先不要直接判断为 bridge 卡死。

需要继续看日志：

- 如果只有初始卡片，没有后续 `llm output message`，要查 Claude CLI 启动
- 如果持续出现 `api_retry`，要查 API 网关 / 上游模型服务
- 如果最终返回 `model_not_found`，要查模型映射，而不是查飞书链路

### 9.5 代理 / 本地网关返回 503

如果日志最终类似：

```text
API Error: 503 {"error":{"code":"model_not_found",...}}
```

说明：

- bridge 和 Claude CLI 已经启动成功
- 问题在你当前的 API 代理/网关配置
- 常见根因是：当前模型名在网关里没有可用 distributor

### 9.6 Windows 路径注意事项

在 Windows 上，workspace 建议直接使用绝对路径，例如：

```text
D:\Projects\CommonProject
```

排障时建议：

- 优先用文本命令 `/reset D:\Projects\...`
- 不要把“卡片手输路径问题”和“runtime 拉不起”混在一起判断

## 10. 推荐排障顺序

建议固定按这个顺序查：

1. bridge 进程是否在跑
2. 启动日志是否正常
3. 飞书控制命令是否可用
4. `/reset` 后 workspace 是否正确
5. 普通文本是否进入 `[bridge] start turn`
6. `llm query input` 里的模型、Claude 路径、Git Bash 路径是否正确
7. Claude CLI 本机是否可直接运行
8. 代理模式下，当前网关是否真的支持目标模型

## 11. 相关文档

如需更多背景，可继续看：

- `README.md`
- `docs/local-deployment-record.md`
- `docs/project-architecture-summary.md`
- `docs/claude-compatibility.md`
- `docs/errors/known-pitfalls.md`
