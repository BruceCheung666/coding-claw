# 决策 0003: 重新设计 Bridge 控制命令

## 状态

- 提议中

## 背景

- 历史版本的 bridge 在飞书 listener 内直接实现了 `/shell`、`/agent`、`/reset`、`/status`、`/model`、`/plan`、`/mode` 等斜杠命令。
- 当前新版已经拆成 `channel-feishu -> core -> runtime-claude` 三层，但还没有独立的“聊天控制平面”。所有文本消息都会直接进入 `BridgeOrchestrator.handleInbound()`。
- 用户已经形成了既有命令心智，尤其是：
  - `/shell`：临时脱离 Agent，直接执行 shell 操作。
  - `/agent`：退出 shell，回到 Agent 对话。
  - `/reset`：重置 Agent 会话，但继续沿用当前工作目录。

目标不是照搬旧实现，而是在新版边界内重新定义这些命令的职责。

## 历史实现分析

### 实现方式

历史版本核心逻辑集中在 `bridge/src/feishu/listener.ts`：

- 收到飞书文本消息后，先解析 `chatId -> ChatState`。
- 若消息以 `/` 开头，则直接在 listener 中执行 `handleSlashCommand()`。
- 若当前 `ChatState.mode === "shell"`，则把后续普通文本当作 shell 命令执行。
- 若当前 `mode === "agent"`，则把普通文本送给 Claude Session。

当时的 `ChatState` 只有两项：

- `mode: "agent" | "shell"`
- `cwd: string`

当时 `/shell`、`/agent`、`/reset` 的真实语义分别是：

- `/shell`
  - 仅修改 `ChatState.mode = "shell"`。
  - 不创建独立 shell 会话，只回复一段 prompt 样式文本。
- `/agent`
  - 仅修改 `ChatState.mode = "agent"`。
  - 不影响 Claude Session、模型、权限模式。
- `/reset`
  - 调用 `sessionManager.remove(chatId)` 删除 Agent Session。
  - 保留 `ChatState.cwd`，因此下次会话会在当前 shell 所在目录重新开始。

当时的 shell 执行不是持久 PTY，而是“单次 exec + marker 回写”：

- 每条 shell 文本都包成 `cd <cwd> && <command>; echo cwd marker; echo git marker`。
- 命令结束后从 stdout 解析新的 `pwd` 和 git branch。
- 因此只有 `cwd` 被伪持久化，`export`、`alias`、`source venv/bin/activate` 等 shell 环境不会保留。

### 设计目的

这组命令解决了三个问题：

- 把“桥自身控制”从模型对话中剥离，避免把 `/reset` 这类输入当成自然语言 prompt。
- 提供一个不经 Agent 推理、可直接落地的运维通道，适合在 IM 中快速执行 shell 操作。
- 允许“重置 Agent 会话”与“保留当前工作目录”解耦，避免每次 reset 都回到工作区根目录。

### 主要问题

- 控制命令、Feishu 协议解析、shell 执行、Claude Session 生命周期都耦合在 listener 一处。
- shell 模式是 channel 私有状态，core 和 runtime 不知道它的存在。
- `/reset` 实际只重置 Agent Session，但这个语义没有被显式建模。
- shell 执行绕过了 runtime 的权限/转录体系，审计能力弱。
- 所有 `/...` 都被桥吃掉，无法区分“桥命令”和“Claude 原生命令/自定义 slash command”。

## 决策

### 1. 引入独立的聊天控制平面

新增一个独立于 channel 和 runtime 的控制命令层，职责是：

- 识别并处理 bridge 保留命令。
- 管理 chat 级控制状态。
- 协调 Agent Session reset、Shell Session 生命周期和状态查询。
- 执行统一文本协议解析，包括命令识别、alias 展开和 slash 文本逃逸。

推荐结构：

- `packages/core`
  - 新增 `ControlCommandRouter`
  - 新增 `ChatControlStateStore` 接口
  - 新增 `BridgeControlService`
- `apps/bridge` 或后续独立包
  - 提供本地 shell 执行实现
- `packages/channel-feishu`
  - 只负责把文本消息交给 `ControlCommandRouter`，不再自己硬编码 `/shell` 等逻辑

### 2. 显式建模 chat 控制状态，不再复用临时 listener 内存

新增 `ChatControlState`，与 `WorkspaceBinding` 并列，而不是塞进 `metadata` 字符串字典。

建议字段：

```ts
interface ChatControlState {
  chatId: string;
  inputMode: 'agent' | 'shell';
  cwd: string;
  shellSessionId?: string;
  shellStatus: 'inactive' | 'ready' | 'running';
  lastAgentResetAt?: string;
  createdAt: string;
  updatedAt: string;
}
```

职责拆分：

- `WorkspaceBinding`
  - 保存 runtime 相关状态，例如 `sessionId`、`model`、`permission mode`、`workspacePath`
- `ChatControlState`
  - 保存 bridge 控制状态，例如 `inputMode`、`cwd`、`shell session`

这样旧版 `/reset` 对应的“保留 cwd 重开 Agent”语义、`/agent` 的输入模式切换语义、`/shell` 的本地 shell 语义，就都有明确归属。

### 3. `/shell` 保留，但升级为真正的控制命令而不是 listener hack

新版保留 `/shell` 和 `/agent` 这组心智，但语义重新定义为“输入模式切换 + shell 会话管理”。

#### 推荐命令语义

- `/shell`
  - 若无参数：进入 shell 输入模式。
  - 若当前不存在 shell session：创建一个新的本地 shell session，并初始化到当前 `cwd`。
  - 回复当前 shell 状态、cwd、git branch。
- `/shell <command>`
  - 在当前 shell session 中执行一次命令。
  - 默认不切换当前输入模式，适合偶发执行。
- `/agent`
  - 把 `inputMode` 切回 `agent`。
  - 不销毁 shell session，只是退出 shell 输入模式。
- `/shell reset`
  - 显式销毁并重建 shell session。
- `/shell exit`
  - 销毁 shell session，并保持 `inputMode = "agent"`。

#### 为什么不再使用“单次 exec + marker”

旧方案只能持久化 `cwd`，不能持久化 shell 环境。新版建议改为 PTY 或长期存活的 shell subprocess：

- `cd`、`export`、`source`、虚拟环境切换可以真实保留。
- shell 模式语义更符合用户直觉。
- 可以更清楚地区分“进入 shell 会话”“执行一次 shell 命令”“销毁 shell 会话”。

#### Shell 的产品边界

bridge 中的 shell 能力应定义为：

- 持久命令执行上下文
- 支持 `cwd`、环境变量、虚拟环境等状态连续性
- 面向非交互命令

bridge 中的 shell 不应定义为：

- 远程终端
- TTY 仿真层
- 可承载全屏/光标/raw mode 程序的交互式 shell

这意味着：

- bridge 不承诺支持需要 TTY 的交互式程序
- 但也不应只根据命令名静态拦截，因为某些命令在带特定参数或重定向时仍可在非 TTY 环境下工作
- 实际行为应由“持久 shell subprocess + 非 TTY 环境”自然决定，bridge 只负责清晰暴露这一边界
- bridge 也不应假设用户 shell 固定为 `zsh`；shell 类型只应来自显式配置，未配置时使用保守默认值 `/bin/sh`
- 其他运行时 fallback 也不应依赖当前开发机的个人环境或个人路径，默认值必须是通用的、可移植的

如果首版不想引入 PTY，可先做兼容降级：

- `/shell <command>` 先保留单次执行模式。
- `/shell` 无参数仍切换 `inputMode = "shell"`。
- 但文档上明确这是临时兼容层，后续必须升级为持久 shell session。

### 4. 取消顶层歧义命令 `/reset`，改为按域命名

从系统建模看，顶层 `/reset` 语义不清晰：

- 它可能指 Agent Session reset
- 也可能指 Shell Session reset
- 也可能指整个 chat 控制状态回到默认值

因此新版不应再把 `/reset` 作为主命令，而应改成按状态域命名：

- `/agent reset`
- `/shell reset`
- `/chat reset`

其中：

- `/agent reset`：只重置 Agent Session
- `/shell reset`：只重置 Shell Session
- `/chat reset`：重置当前 chat 的 bridge 控制状态与运行时状态，但不删除工作区文件

如确有兼容需要，`/reset` 只能作为过渡 alias，且必须在帮助文档里标注为 deprecated；不应再作为正式语义中心。

### 5. `/agent reset` 的正式语义

`/agent reset` 的默认语义应为：

- 若当前 Agent turn 正在运行，先 abort。
- 清掉 chat 对应的 runtime session 对象缓存。
- 清空 `WorkspaceBinding.sessionId`，确保下一轮从新 session 开始。
- 清理该 chat 的 pending interactions。
- 保留：
  - `workspacePath`
  - `ChatControlState.cwd`
  - shell session（默认）
  - 模型与权限模式（默认）

也就是说，`/agent reset` 的真实含义是：

- 重开 Agent
- 不重置工作区
- 不重置 shell cwd

默认值必须保守，优先保留用户当前工作现场。

### 6. `/chat reset` 负责整组状态复位

如果需要一个“从 bridge 视角恢复默认聊天状态”的命令，应单独定义为 `/chat reset`，而不是 `/reset --all`。

`/chat reset` 建议执行：

- `dropSession(chatId)`，丢弃 Agent Session
- 清理 pending interactions
- 销毁 shell session
- `inputMode` 回到 `agent`
- `cwd` 回到 `workspacePath`
- 视需要恢复默认模型/权限模式

注意：

- `/chat reset` 只重置 bridge 管理的会话态，不删除文件。
- 如果未来确实需要“清空工作目录”之类更强行为，应该再单独定义显式命令，不能塞进 reset 默认语义。

### 7. 单 `/` 是命令前缀，`//` 及以上用于转义 slash 文本

新版采用严格文本协议：

- 以单个 `/` 开头：按 bridge 命令解析
- 以两个及以上 `/` 开头：去掉最前面的一个 `/`，剩余完整文本原样发给 Agent
- 不以 `/` 开头：按普通文本发给 Agent

示例：

- `/agent reset`
  - 作为 bridge 命令处理
- `//agent reset`
  - 发给 Agent 的文本是 `/agent reset`
- `///agent reset`
  - 发给 Agent 的文本是 `//agent reset`
- `////foo`
  - 发给 Agent 的文本是 `///foo`

因此：

- 单 `/` 前缀属于 bridge 控制协议
- 双 `/` 及以上提供稳定的 slash 文本逃逸能力
- bridge 不再承担“未知 slash command 自动透传”的职责

这样协议更稳定，也避免 bridge 命令空间与 Agent slash 文本混淆。

### 8. 保留命令和文本短别名都属于 core 协议

只要某种快捷方式纯粹基于输入文本，就应属于 `core` 命令协议，而不是某个 IM 私有增强。

推荐分成两层：

Canonical commands：

- `/agent mode [default|acceptEdits|bypassPermissions|plan|dontAsk]`
- `/agent model [model-name]`
- `/agent reset`
- `/agent status`
- `/shell open`
- `/shell exec <command>`
- `/shell reset`
- `/shell close`
- `/chat status`
- `/chat reset`

Text aliases：

- `/ar` = `/agent reset`
- `/as` = `/agent status`
- `/so` = `/shell open`
- `/sx <command>` = `/shell exec <command>`
- `/sr` = `/shell reset`
- `/sc` = `/shell close`
- `/cs` = `/chat status`
- `/cr` = `/chat reset`

要求：

- alias 必须在统一注册表中定义
- alias 只映射 canonical command，不能拥有独立语义
- help、审计、测试都以 canonical command 为准，alias 只是输入层糖衣

补充说明：

- 权限模式切换属于 agent runtime 状态，因此应归到 `/agent mode`。
- `/agent mode` 无参数时用于查看当前生效 mode；带参数时更新当前 chat binding 的 mode，并对后续 turn 生效。
- 模型切换属于 agent runtime 状态，因此应归到 `/agent model`，而不是恢复旧版顶层 `/model`。
- `/agent model` 无参数时用于查看当前生效模型；带参数时用于切换模型，并同时重置当前 Agent Session，避免旧 `sessionId` 继续沿用原模型。
- 在支持卡片交互的 IM 中，`/agent mode` 和 `/agent model` 无参数时优先返回交互卡片，而不是只回纯文本。
- 当前模型列表采用 bridge 侧内置白名单；若后续需要按账号、环境或可用 feature gate 动态暴露，再单独升级为配置化或运行时探测方案。

### 9. channel 只负责交互增强，不负责文本协议

文本命令、短别名、slash 转义规则都属于 core。

channel 负责的是增强能力，例如：

- 按钮确认
- 卡片操作
- reply-based 局部上下文
- 更强的状态展示

能力不足的 IM 可以降级为：

- 纯文本命令
- 纯文本确认
- 无卡片状态展示

但不能改变核心文本协议。

### 10. 控制命令需要进入统一的审计/转录链路

旧版 shell 执行和 reset 基本是 listener 内副作用，缺少标准化记录。新版应补齐控制面审计。

建议新增控制事件：

```ts
type ControlEvent =
  | {
      type: 'control.command.received';
      chatId: string;
      command: string;
      args: string[];
    }
  | {
      type: 'control.mode.changed';
      chatId: string;
      from: 'agent' | 'shell';
      to: 'agent' | 'shell';
    }
  | { type: 'control.cwd.changed'; chatId: string; cwd: string }
  | { type: 'control.agent.reset'; chatId: string; preservedCwd: string }
  | { type: 'control.chat.reset'; chatId: string; restoredCwd: string }
  | {
      type: 'control.shell.completed';
      chatId: string;
      exitCode: number;
      output: string;
    };
```

是否与现有 `BridgeEvent` 合并，可以在实现阶段再定；但设计上必须保证：

- reset 类控制命令有日志
- `/shell` 执行有审计
- cwd 变化可追踪

## 影响到的接口与模块

### `packages/core`

- 新增 `ChatControlStateStore`
- 新增 `BridgeControlService`
- 新增统一 `CommandRegistry`
- `BridgeOrchestrator` 需要暴露：
  - `resetChat(chatId, options)`
  - `getChatSnapshot(chatId)`
  - 清理 session cache 的显式方法

### `packages/runtime-claude`

- `AgentRuntime` 需要支持删除/重建 chat session，而不只是 `getOrCreateSession()`
- 建议补一个接口：

```ts
interface AgentRuntime {
  getOrCreateSession(binding: WorkspaceBinding): Promise<RuntimeSession>;
  dropSession(chatId: string): Promise<void>;
}
```

否则 reset Agent Session 时只能改 `binding.sessionId`，但 runtime 内存里的旧 session 仍然会被复用。

### `packages/channel-feishu`

- 适配器只负责：
  - 文本提取
  - 交给控制路由
  - 渲染控制命令结果
- 不再自己维护 `chatStates`
- 不再自己写 `/shell` `/agent` / reset 类命令的 switch 分支

## 实施顺序

1. 先补 `CommandRegistry`、`ChatControlStateStore` 和 `BridgeControlService`，把控制状态从 Feishu adapter 中剥离。
2. 实现 slash 文本解析规则：单 `/` 命令，双 `/` 及以上去掉一个 `/` 后透传。
3. 实现 `/agent reset`，打通 runtime `dropSession()`、binding `sessionId` 清空、pending interaction 清理。
4. 实现 `/shell exec` 的一次性执行版本，并补 `/sx` 等文本 alias。
5. 实现 `/shell reset` 与 `/chat reset`，把三类 reset 语义彻底拆开。
6. 再升级为持久 shell session，使 `/shell` 模式支持 `cd` / `export` / `source` 等环境延续。
7. 最后再补 `/status`、`/help` 和 channel 侧增强交互。

## 不采用的方案

### 方案 A: 继续把命令硬编码在 `FeishuChannelAdapter`

不采用，原因：

- 与新版多 IM、多 runtime 目标冲突。
- 同样的问题以后会在企业微信、Matrix 再复制一遍。

### 方案 B: 完全删除 `/shell` `/agent`，只保留 Agent 对话

不采用，原因：

- IM 场景下直接 shell 操作是高频需求。
- 旧版用户已经形成稳定心智。
- 这不是 Claude Code 原生能力，但它是 bridge 场景下有价值的扩展能力。

### 方案 C: 把所有 `/...` 都直接透传给 Claude

不采用，原因：

- reset 类命令、`/status`、`/shell` 是 bridge 自身控制，不应该由模型解释。
- 会丢失“桥管理自身会话”的能力。

### 方案 D: 单 `/` 未命中命令时自动透传给 Agent

不采用，原因：

- 用户已经显式使用了命令前缀，桥应给出确定反馈。
- 这会让命令协议变得不稳定，用户无法判断某条输入是桥处理还是 Agent 处理。
- 已经有 `//` 作为统一逃逸规则，不需要再靠 fallback 透传兜底。

## 结论

新版应采用按域命名的控制命令，而不是继续使用语义模糊的顶层 `/reset`。控制命令要从 Feishu listener 里的特殊分支，升级为 bridge 内独立、可持久化、可审计的控制命令系统。

最关键的行为定义是：

- `/shell`：桥级本地 shell 控制，不属于 Claude prompt。
- `/agent`：输入模式切回 Agent，不重置现场。
- `/agent reset`：只重置 Agent Session，默认保留 cwd、shell、workspace。
- `/shell reset`：只重置 Shell Session。
- `/chat reset`：重置 chat 级 bridge 状态与运行时状态，但不删除工作区文件。
- 单 `/...`：桥命令协议。
- `//...`：slash 文本逃逸，去掉一个 `/` 后原样发给 Agent。
