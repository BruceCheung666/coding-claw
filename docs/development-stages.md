# Development Stages

本文件用于记录每个“大开发节点”的阶段性产出、已知偏差和下一阶段待办。

说明：本文件按时间顺序保留历史阶段记录。各阶段中的“当前已知问题”和“下一阶段待办”只代表当时状态；若与后续阶段记录或 `docs/project-constraints.md` 的当前约束冲突，以较新的阶段记录和约束文档为准。

## 维护规则

- 每完成一个可独立回顾的大节点，都在本文件追加一个新阶段。
- 每个阶段至少包含：完成内容、当前已知问题、下一阶段待办。
- 阶段记录完成后，立即做一次 git 提交，确保代码与阶段文档对应。
- 如果某次开发引入新的兼容性偏差或踩坑，同时更新相关的 `docs/errors/` 或兼容性文档。

## Phase 01: Bridge Kernel Skeleton

### 完成内容

- 建立 pnpm monorepo，拆分为 `core`、`runtime-claude`、`channel-feishu`、`apps/bridge` 四层。
- 建立统一 `BridgeEvent`、`AgentRuntime`、`RuntimeSession`、`RenderSurface`、`ApprovalStore`、`TranscriptStore`、`WorkspaceBindingStore` 接口。
- 实现 `BridgeOrchestrator`，打通 `Feishu -> orchestrator -> Claude runtime -> render surface` 主流程。
- 实现 Claude runtime 首版兼容层：
  - 模块化 system prompt 组装
  - sessionId 续接
  - AskUserQuestion 桥接
  - plan mode / ExitPlanMode 审批
  - sub-agent drain 控制器
- 实现 Feishu 首版适配层：
  - WebSocket 事件接入
  - turn 级卡片渲染
  - permission / question / plan approval 交互卡片
  - 卡片回调到 runtime interaction resolution
- 建立架构文档、兼容性文档、错误文档、协议文档。
- 增加基础测试，覆盖 render model、system prompt、sub-agent drain。

### 当前已知问题

- Claude Code system prompt 目前是按架构分段重建，不是完整逐字对齐。
- 权限策略还是简化版，没有对齐 CLI 的完整 Bash AST 和文件安全规则。
- Feishu 卡片流目前是基础实现，还没有完成复杂节流、时序冲突规避和更细的 UI 表达。
- 还没有做真实飞书 + Anthropic 环境下的端到端联调。
- interaction callback 的 question 表单解析仍是首版实现，后续需要按真实 payload 校准。

### 下一阶段待办

- 用真实飞书和 Claude runtime 跑通一轮端到端冒烟验证。
- 对照历史实现与调试日志，逐项补齐 system prompt、权限行为、plan mode 附件、tool summary、agent tree 细节。
- 把工作区绑定、转录、审批状态从内存存储升级为可恢复存储。
- 完善 Feishu 渲染层的流式节流、终态覆盖、错误卡片和去重。
- 增加更多兼容回归测试，尤其是 `AskUserQuestion`、`ExitPlanMode`、多轮 resume、子 agent 晚到通知。

## Phase 02: Feishu Interaction Hardening

### 完成内容

- 修复多类飞书卡片 schema 问题，统一使用兼容的 `schema: 2.0` 结构。
- 修复 `AskUserQuestion` 提交链路，问题卡片可正确回填 answers 并继续运行。
- 增加“开始确认”专用按钮卡片；若用户改发新消息，则将该卡片锁定为“未开始/已转为补充需求”。
- 交互卡片现在优先 reply 到当前进度卡片对应的消息链，减少进度卡片和问答卡片分离。
- 给 runtime 增加关键节点日志：turn start、sdk message、canUseTool、interaction requested、result received、task started/completed、turn completed。
- 给 bridge / Feishu adapter 增加入站日志和 `message_id` 去重日志。
- 入站消息按飞书 `message_id` 做去重，重复消息会被直接丢弃并记录日志。
- 对“相同 prompt 但不同 `message_id`”增加显式日志，便于区分事件重放和用户真的再次发起相同请求。
- 对 `ExitPlanMode` 的异常调用做了排查：目前非 plan mode 下改为 no-op allow，并记录警告，不再把当前对话打断。
- sub-agent drain 增加 10 分钟无进展超时兜底，并记录未完成 task id。

### 当前已知问题

- 工作区绑定、sessionId、已处理 messageId 仍然是内存态，服务重启后无法保留。
- “相同 prompt 不同 message_id”目前只记录日志，不做启发式拦截；重复消息治理以持久化 `message_id` 去重为准。
- `ExitPlanMode` 的根因还没有彻底消除，目前是通过 no-op 降噪，而不是从工具暴露或提示词层根治。
- 飞书卡片交互已经基本可用，但卡片回调和消息更新流程仍需更多端到端覆盖。

### 下一阶段待办

- 将 `message_id` 去重和 workspace/session 绑定升级为可恢复持久化。
- 深挖为什么模型会在非 plan mode 下调用 `ExitPlanMode`，优先从工具暴露和提示词上下文排查。
- 继续完善日志落盘，让用户可以直接查看 bridge 运行日志文件。

## Phase 03: Control Command Redesign

### 完成内容

- 对照历史 listener.ts，梳理了 `/shell`、`/agent`、`/reset` 的真实语义与状态模型：
  - `/shell` / `/agent` 本质上是输入模式切换
  - `/reset` 本质上是“保留 cwd 的 Agent Session reset”
  - 当时的 shell 只有 `cwd` 被伪持久化，并不是真正的持久 shell 环境
- 明确了早期设计目的：把 bridge 自身控制从模型对话中剥离，并为 IM 场景提供直接 shell 通道。
- 输出新版控制命令设计决策文档 [0003-control-commands](./decisions/0003-control-commands.md)，确定以下原则：
  - 引入独立的 bridge 控制平面
  - 将 chat 控制状态从 Feishu adapter 中抽离
  - 控制命令按状态域命名，避免继续使用语义含混的顶层 `/reset`
  - 单 `/` 统一作为命令前缀，`//` 及以上通过“去掉一个 `/`”实现 slash 文本逃逸
  - `/agent reset`、`/shell reset`、`/chat reset` 三类 reset 语义显式拆开
  - 文本短别名属于 core 协议，不属于某个 IM 私有能力
- 已落地第一版控制命令实现：
  - `core` 新增命令注册表、slash 解析和 chat 控制状态存储
  - `FeishuChannelAdapter` 先走 `dispatchInbound()`，控制命令直接回文本，runtime prompt 再进入原有卡片流
  - `AgentRuntime` 增加 `dropSession(chatId)`，打通 `/agent reset`
  - `ShellExecutor` 已升级为持久 shell session，实现环境变量和 cwd 跨多次 `/sx` 保留
  - 新增 `/shell status` (`/ss`) 以查询当前 shell session 状态
  - 明确 shell 的产品边界是“持久命令上下文”，不是远程终端；不做命令名级静态拦截，实际行为由非 TTY shell 环境决定
  - shell 启动不再假设 `zsh`；只认显式配置 `CODING_CLAW_SHELL`，未配置时直接回退到 `/bin/sh`
  - Claude 可执行路径不再硬编码到当前开发机的个人目录；未配置 `CODING_CLAW_CLAUDE_PATH` 时交给 runtime 默认行为
- 更新 `docs/architecture.md`，补充“控制命令不应是 channel 私有逻辑”的架构约束。

### 当前已知问题

- 当前 shell session 基于持久 shell subprocess，而非 PTY；命令环境可以保留，但终端特性和全屏程序不在目标能力范围内。
- 控制命令事件是否并入现有 `BridgeEvent` 体系，仍需在实现阶段最终拍板。
- 顶层 `/reset` 是否保留 deprecated alias，也要等实现时再决定，不再预设为正式命令。
- 短别名集合需要控制规模，避免后续 alias 过多反而破坏可记忆性。

### 下一阶段待办

- 在 `packages/core` 中补控制命令注册表、解析器与 chat 控制状态存储接口。
- 决定 shell session 是否要继续升级到 PTY，还是保持 subprocess 方案并只支持非交互命令。
- 为控制命令补更多测试，覆盖 `/chat reset`、`/shell status`、shell 进程异常退出与并发场景。
- 评估控制命令是否需要纳入统一 `BridgeEvent` / transcript 体系。

## Phase 04: Feishu Card Workflow Hardening

### 完成内容

- 将飞书入站处理拆成“快速 ACK + 后台处理”，避免长耗时 turn 阻塞飞书长连接回执。
- 增加更完整的运行日志：
  - Claude runtime 输入、system prompt、`query` 参数、`canUseTool` 决策、SDK 原始消息、turn 结束信息
  - Feishu WebSocket 原始事件、入站去重结果、控制命令分发、消息/卡片 API 请求与响应
  - 日志统一做基础脱敏，避免直接打印常见 secret/token 字段
- 修复 turn 卡片上下文迁移时丢失前文的问题：
  - `RenderModel` 拆分为固定 `prompt` 与累积 `body`
  - 迁移后的新卡片保持完整 `User + Claude` 上下文
  - 被迁移的旧 turn 卡片更新为无标题的“已迁移”占位卡
- 梳理并统一飞书卡片标题与颜色：
  - turn 卡片使用灰色标题
  - 提问卡片使用蓝色标题，标题改为通用文案
  - 权限申请卡片使用橙色标题，批准/拒绝结果分别使用绿色/红色标题
  - 敏感操作待确认卡片使用橙色标题，确认/取消/失败结果分别使用绿色/红色标题
  - `plan-approval` 待审批卡片使用紫色标题，结果卡片使用绿色/红色标题
- 为敏感控制命令增加飞书卡片二次确认：
  - `/agent reset`、`/shell reset`、`/chat reset`
- 为 `/sx` 增加“仅危险命令确认”的保护：
  - 危险递归删除、磁盘/文件系统破坏、关机/重启、批量杀进程、fork bomb 等命令需要先确认
  - 普通 `/sx pwd`、`/sx mkdir test` 继续直接执行
- 针对以上行为补充回归测试，覆盖：
  - ACK 前移
  - turn 卡片迁移
  - 敏感 reset 二次确认
  - 危险 `/sx` 二次确认与普通 `/sx` 直执行

### 当前已知问题

- turn 卡片仍然通过 reply 绑定到原消息链；这符合当前交互预期，但在飞书里会继续体现为回复消息关系。
- 日志量现在明显增加，适合排障，但后续需要评估是否增加按级别开关或日志采样，避免长期运行时噪声过大。
- `plan-approval` 和提问类卡片虽然已补标题，但线上仍需继续做更多真实事件回放验证，确保不同客户端都能正确展示。
- 危险 `/sx` 检测目前基于高风险模式匹配，属于保守启发式，不等于完整 shell 安全模型。

### 下一阶段待办

- 对照线上真实使用情况，继续校准危险 `/sx` 规则，减少漏拦截和误拦截。
- 评估是否需要给详细日志增加环境变量开关，区分默认日志与排障日志。
- 为 `plan-approval`、提问完成态和更多交互回调补更细的卡片结构测试。
- 继续对齐历史实现中的卡片视觉细节与消息链时序，减少飞书客户端上的展示偏差。

## Phase 05: Permission Engine And Scope-Aware Cards

### 完成内容

- 将 runtime 权限逻辑从单文件 `PermissionPolicy` 重构为分层实现：
  - 新增 `PermissionEngine`
  - 新增 `BashPermissionUtils`
  - 新增 `PathSafety`
  - 新增 `PermissionPresentation`
- 权限决策不再只靠扁平 `if/else`：
  - 补上工作区外路径审批
  - 补上敏感写入保护
  - `acceptEdits` 不再无条件放过敏感写入
  - 只读 Bash 默认放行
  - `plan mode` 下允许只读 Bash，变更型 Bash 走审批
- Bash 授权范围从简单命令前缀记忆升级为更接近 Claude Code / 历史实现的规则表达：
  - 支持 `Bash(xxx:*)` 风格 session 规则
  - 复合命令按子命令拆分匹配
  - 危险命令和代码执行模式单独识别
- 权限交互从“工具导向”升级为“动作导向”卡片：
  - 展示动作名称、触发原因、风险等级
  - 展示可选授权范围，而不是只给固定的“允许一次/记住会话”
- 权限卡现在支持 scope-aware session allow：
  - resolution 增加 `scopeKey`
  - 用户点不同按钮时，只应用被选中的规则 / 目录 / mode 建议
  - 不再把所有 suggestion 一次性记进会话
- 修复两类真实飞书 schema 问题，并补文档沉淀：
  - 同卡片多按钮 `name` 重复
  - button `name` 长度超过飞书限制
- 补充回归测试，覆盖：
  - 权限引擎范围选择
  - 工作区外目录授权
  - `plan mode` 下 Bash 行为
  - 权限卡多 scope 按钮唯一性
  - 按钮 `name` 长度限制
- turn 卡片渲染从扁平 `prompt/body/toolSummary/tasks/agents` 升级为结构化 section 模型：
  - `RenderModel` 现在保留按时序累积的文本块、工具折叠组、任务块、agent 块和 agent 完成通知
  - `turn.tool.started` 重新参与 reducer，用于恢复 search/read/list 折叠组，而不是只消费最终 `tool summary`
  - Feishu turn 卡不再固定输出 `User / Claude / Tool summary / Tasks / Agents` 五段模板，而是按 section 顺序投影
- 保留“迁移占位卡 + 新卡续写”机制，同时补齐迁移后的上下文继承：
  - 交互后新卡首帧基于完整结构化状态重建
  - 已经出现在旧卡里的文本、工具组、tasks、agents 会完整带到新卡继续续写
  - `tasks` 和 `agents` 的展示回到更接近既有语义样式，而不是简单列表摘要
- 补充 turn 卡片回归测试，覆盖：
  - 工具折叠组切分与完成态
  - 迁移后新卡继承旧卡已展示内容
  - task / agent section 的结构化渲染

### 当前已知问题

- permission resolution 仍沿用现有 `accept-once / accept-session / reject` 主结构，只是在 `accept-session` 上补了 `scopeKey`，还没有完全升级成独立 scope 协议。
- 飞书权限卡已经能表达多个范围，但还没有做“同一 turn 权限请求聚合”，复杂任务里仍可能弹出多张卡。
- 当前 scope-aware 卡片仍是 reply 到原消息链，交互碎片度比理想状态高。
- 目录 scope 和工具 scope 已可用，但持久化权限来源（session/local/project/user）还没有落地。
- turn 卡片虽然已经恢复结构化内容，但还没有完全补回既有 system/status/tool_progress 细节。
- 当前结构化 section 仍以内存 reducer 为主，后续若要做 transcript 恢复或跨进程续写，需要把 section 重建规则继续和 transcript/persistence 对齐。

### 下一阶段待办

- 将 permission interaction/resolution 进一步结构化，减少对旧 `accept-session` 语义的复用。
- 为权限请求增加聚合策略，降低复杂任务中的卡片碎片化。
- 将 session 规则、附加目录和 mode 变更从内存升级为可恢复存储。
- 继续校准飞书卡片 schema 约束，并把新发现的平台限制沉淀成固定测试和错误文档。
- 继续对齐既有 turn 卡片里尚未恢复的状态块，特别是 `status` / `tool_progress` / 更细的 agent 生命周期提示。

## Phase 06: Claude Team Capability Alignment

### 完成内容

- 对照真实 Claude Code 运行日志、实验性参考实现中的工具定义与历史实现，会同定位了 team/swarm 能力来源：
  - Claude Code 的 Team 能力来自 `TeamCreate` / `TeamDelete` / `SendMessage`
  - 这些工具受 `isAgentSwarmsEnabled()` feature gate 控制
  - 仅有 `Agent` 而没有 TeamCreate 时，模型若直接使用 `team_name` 会得到 `Team "... " does not exist` 错误
- `runtime-claude` 已补齐 team 对齐基础设施：
  - 默认工具集加入 `SendMessage`
  - 开启 agent teams 时，额外请求 `TeamCreate` / `TeamDelete`
  - 通过 SDK `env` 向底层 Claude Code 透传 `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`
  - `--agent-teams` 目前不作为默认透传路径：此前实测在当前环境里带该 flag 会报错，因此文档和实现统一按 env feature gate 记录
  - 在 init 消息里记录“请求工具 vs 实际可用工具”缺口，便于判断 feature gate 是否真的生效
- system prompt 由固定静态段升级为“按工具能力约束”：
  - 有 Team 工具时，明确要求先 `TeamCreate`，再用 `Agent + team_name`
  - 没有 Team 工具时，明确禁止在 `Agent` 上使用 `team_name`
- 补充回归测试，覆盖：
  - team tool 可用时的 prompt 约束
  - team tool 不可用时的降级约束
  - runtime 开启 agent teams 后的工具请求与 env 透传
- 将“Agent team feature gate”沉淀到错误文档，方便后续排障。

### 当前已知问题

- 即使 bridge 已请求 Team 工具，底层 Claude Code 仍可能因为 server-side GrowthBook killswitch 不返回这些工具；这种情况下 init 会继续缺失 Team 工具。
- 当前 system prompt 只能基于“桥请求的工具集”提前约束模型，无法在首个 turn 开始前就 100% 感知 init 返回的真实工具差异。
- 目前仍未真正桥接 `SendMessage` / Team 生命周期事件的更细 UI 表达，首版重点是先把能力暴露和错误归因对齐。

### 下一阶段待办

- 继续对齐 TeamCreate / TeamDelete / SendMessage 的运行时事件与飞书渲染语义。
- 若 init 缺失 Team 工具，考虑在首轮内增加更强的自动降级策略，避免模型重复尝试 `team_name`。
- 进一步研究 Claude Code 的 dynamic system prompt section，补齐按真实 tool pool 生成的条件性 guidance。

## Phase 07: Repository Hygiene Guardrails

### 完成内容

- 明确了 `dist/` 的仓库卫生规则：构建产物允许在本地和 CI 生成，但不应提交到 Git。
- 在 `.gitignore` 与仓库指南中补充了生成产物不入库的说明，避免把“不提交”误解成“不生成”。
- 新增仓库卫生检查脚本，用于识别 Git 索引中被错误纳入版本控制的 `dist/**` 文件。
- 在现有 CI 中接入轻量 hygiene guard：
  - install 前先检查仓库索引里没有 tracked `dist`
  - build 后再次确认 tracked 工作树未被污染
- 保持现有运行链路不变：`pnpm build` 继续生成 `dist`，`pnpm start` 仍然依赖本地 build 产物。

### 当前已知问题

- 当前仓库虽然已明确 `dist` 不入库，但 `apps/bridge` 的 `start` 与 workspace 包导出仍依赖本地先 build，开发者仍需理解这一区别。
- 这一步只解决“仓库卫生与防回归”问题，没有处理 workspace 开发链路是否应进一步减少对预构建产物的依赖。
- 如果将来要把包入口从 `dist` 改到 `src`，那将是独立的开发/发布链路重构，不属于本阶段范围。

### 下一阶段待办

- 观察实际协作中是否还会出现误提交构建产物的情况，必要时再增加更严格的仓库保护措施。
- 评估 `pnpm dev` 是否也应显式文档化其对本地构建状态的要求，或后续优化为更直接的源码开发链路。
- 如后续引入发布流程，补充 release 前校验，确保发布构建与仓库卫生规则保持一致。

## Phase 08: CI Baseline And Quality Gates

### 完成内容

- 新增 GitHub Actions 基础 CI workflow，覆盖 `pull_request` 与主分支 `push`。
- CI 统一固定 `Node 22` 与 `pnpm 10.30.2`，并启用 pnpm 依赖缓存。
- 自动校验链路现已覆盖：
  - `pnpm install --frozen-lockfile`
  - `pnpm typecheck`
  - `pnpm test`
  - `pnpm build`
- 将 CI 约束同步写入仓库指南，明确提交前应优先本地跑通质量门禁。

### 当前已知问题

- 当前 CI 仍是单工作流、单 job 的最小实现，还没有区分 lint、集成测试、发布前校验或矩阵版本测试。
- 仓库尚未引入 formatter / linter，因此 CI 暂时只能防住安装、类型、测试与构建回退，不能统一风格问题。
- 目前还没有在 GitHub 分支保护规则层面强制要求 CI 通过后才能合并，仍需要在仓库设置中补齐。

### 下一阶段待办

- 继续补齐 ESLint / Prettier，并纳入 CI。
- 视需要拆分更细的 job（如 verify / build / release-precheck），减少重复执行时间。
- 在 GitHub 仓库设置中启用分支保护，将 CI 设为必过检查。

## Phase 09: IM Permission Relaxation

### 完成内容

- 将 runtime 默认权限主路径从“工具首次使用先审批”调整为“工作区内常规开发操作默认放行，只有高风险才审批”：
  - 工作区内 `Read` / `Write` / `Edit` / `MultiEdit` / `NotebookEdit` / `TodoWrite` 默认通过
  - 普通开发类 `Bash` 默认通过，不再把 `pnpm test`、`node scripts/build.js` 之类命令视为需要审批
  - `WebFetch` / `WebSearch` / `Glob` / `Grep` 继续默认通过
- 收紧“真正需要卡片”的触发条件：
  - 工作区外读写仍走审批
  - `.env`、私钥、shell rc、`.git`、`.claude`、`.vscode`、`.idea` 等敏感路径仍走审批
  - `sudo`、`ssh`、远程脚本管道执行、删除操作、`git clean -f`、`mkfs`、`dd`、关机/重启、强杀进程等危险 Bash 仍走审批
- `plan mode` 改为“高风险附加确认”而不是“默认只读”：
  - `plan mode` 下允许常规工作区编辑和普通开发命令
  - 仅高风险动作继续进入审批
  - `~/.claude/plans` 计划文件写入豁免保持可用
- 权限卡建议项和提示词同步转向 IM 语义：
  - 默认文案不再强调“工具未授权”，而是强调“超出默认放行范围/存在高风险”
  - 工作区外路径审批优先建议目录级授权
  - 危险命令审批可记住当前精确命令，而不是直接升级成更宽的默认模式
  - system prompt 明确“常规工作区编辑和普通开发命令可直接执行，高风险动作再确认”
- 补充回归测试，覆盖：
  - 工作区内编辑默认放行
  - 普通开发命令默认放行
  - 危险 Bash 审批与 exact rule 记忆
  - 工作区外读取审批
  - 敏感路径写入审批
  - `plan mode` 下常规工作保持可执行

### 当前已知问题

- 当前 Bash 风险识别仍是启发式模式匹配，还没有做到按 shell AST 和路径解析精确判断“是否越出工作区”。
- 默认放行的 `Bash` 范围已经大幅放宽，后续仍需要结合真实 IM 使用日志继续校准误放行和误拦截。
- MCP 工具仍未按 IM 默认策略分层；当前变更主要覆盖本地文件工具和 Bash 主路径。

### 下一阶段待办

- 继续把 Bash 风险检测从简单正则升级为“命令类别 + 目标路径”联合判断，减少删除/移动类命令的误判。
- 为权限请求增加聚合策略，降低复杂任务下的多张高风险审批卡片。
- 评估是否需要显式引入“Claude strict / IM relaxed”可配置策略层，便于未来支持多 runtime、多产品形态。

## Phase 10: Turn Queue Recovery Hardening

### 完成内容

- 修复同一 chat 串行 turn 队列的失败污染问题：
  - 前一个 turn 失败后，后续 turn 现在仍可继续执行并返回自己的真实结果
  - `chatLocks` 在 turn 完成后会及时清理，避免长期保留已完成 promise
- 修复“开始确认”补充需求分支的重复处理问题：
  - 当用户在开始确认卡片出现后直接发送新消息时，该消息只会回填到原 pending question
  - 不再同时把同一条消息当作新的 runtime turn 再执行一次
- 修复 interaction resolution 在无活跃 runtime session 时被直接吞掉的问题：
  - approval resolution 现在会先落到 store
  - 若当前进程里没有活跃 session，会记录告警而不是静默丢失 resolution
- 补齐 `AskUserQuestion` 的多选题落地能力：
  - `multiSelect=true` 的问题在飞书卡片中改为使用多选控件，而不是继续伪装成单选
  - 交互回调现在会按协议返回 `string[]`，不再把多选结果压扁成逗号拼接字符串
  - “其他”补充内容在多选场景下会并入结果数组，单选场景继续返回单个字符串
- 补充回归测试，覆盖：
  - 失败 turn 后继续处理后续 turn
  - start-confirm 转补充需求时不再开启新 turn
  - approval 在无 session 时仍会被标记 resolved
  - 多选问题卡片结构与多选回调解析

### 当前已知问题

- 仍然不考虑服务重启后的上下文恢复；workspace binding、control state、approval 和 transcript 依旧是进程内状态。
- 若 bridge 在等待 `AskUserQuestion` / permission / plan approval 期间重启，当前约定就是中断该上下文，不做自动恢复。

### 下一阶段待办

- 若后续重新引入恢复能力，需要先单独设计 turn-level recovery 语义，而不是直接把当前内存等待点外置持久化。
- 继续清理协议文档与实现漂移，特别是未真正落地的事件类型和恢复语义说明。
- 继续校准飞书问答卡片在更多真实 payload 下的表现，特别是多选 + 其他补充内容的边界情况。

## Phase 11: Unified Reset Workspace Picker

### 完成内容

- 将原先拆开的 `/agent reset`、`/shell reset`、`/chat reset` 合并为统一的 `/reset` 控制入口：
  - `/reset` 不再直接执行，而是先返回一张飞书交互卡，要求用户明确选择新的工作区目录。
  - 当前实现提供四种来源：默认位置、当前 `cwd`、当前 workspace、手动输入绝对路径。
- 重构 reset 的执行语义为“完整 reset + workspace 重绑”：
  - 中止当前 Agent turn，并丢弃 runtime session / pending approvals
  - 销毁当前 shell session
  - 将选中的目录同时写回 `WorkspaceBinding.workspacePath` 和 `ChatControlState.cwd`
  - 新目录不存在时会自动创建
  - reset 只重绑工作区，不删除任何现有文件
- 飞书侧新增 reset 工作区选择卡与结果卡：
  - 卡片会显式展示默认位置、当前 `cwd`、当前 workspace 分别对应的绝对路径
  - 支持直接点击使用默认位置 / 当前 `cwd` / 当前 workspace
  - 支持手动输入其他绝对路径并立即执行 reset
- 补充回归测试，覆盖：
  - `/reset` 返回工作区选择器
  - `/reset <path>` 会完整重置并重绑 workspace
  - 飞书 reset 卡片的默认 / cwd / workspace / 手动输入四类路径选择

### 当前已知问题

- 旧的 `/agent reset`、`/shell reset`、`/chat reset` 已不再保留兼容入口；仍按旧命令使用时会落到未知命令提示。
- 手动输入路径目前要求绝对路径；尚未支持“相对当前 `cwd`”或“浏览现有目录后选择”这类更强交互。
- reset 工作区的选择与结果目前只存在于当前交互卡片中，还没有单独的审计事件模型。

### 下一阶段待办

- 评估是否需要给 `/reset` 增加“最近使用过的工作区”快捷项，减少频繁在多个目录间切换时的输入成本。
- 评估是否要为 reset/workspace 重绑补一层显式审计事件，方便后续恢复、排障和行为回放。
- 继续清理控制命令设计文档，消除旧 reset 三分模型与当前实现之间的漂移。
