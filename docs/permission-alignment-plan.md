# 权限逻辑对齐开发计划

## 文档状态

- 本文是权限系统重构前期形成的阶段性计划，保留作为设计演进参考。
- 其中“默认更保守”“写工具和 Bash 默认进入 ask/deny 管线”等策略，已经被后续 [docs/development-stages.md](./development-stages.md) 中的 `Phase 07: IM Permission Relaxation` 部分更新。
- 阅读本文时，应优先把它理解为“历史设计草案 + 未完成事项清单”，而不是当前运行行为的权威说明。
- 如与当前实现或阶段文档冲突，以 `docs/development-stages.md`、`docs/project-constraints.md` 和代码实际行为为准。

## 当前仍然有效的关注点

- 继续提升 Bash 风险判断精度，减少启发式正则带来的误放行与误拦截。
- 继续完善工作区边界、敏感路径和目录授权的语义一致性。
- 继续校准 `plan mode`、`ExitPlanMode`、权限建议项与 Claude Code 真实行为的差异。
- 继续设计子 agent / MCP 工具的权限传播模型，但不在当前阶段强行引入过度复杂的状态机。

## 背景

- 当前 `packages/runtime-claude/src/permissions/PermissionPolicy.ts` 只实现了简化版授权逻辑，能够支撑飞书审批卡片和基本的 `canUseTool` 决策，但与历史实现以及 Claude Code 真实行为仍有明显差距。
- 已确认的主要差距包括：
  - 缺少完整的 `allow / deny / ask` 规则管线。
  - 缺少文件路径安全检查、工作区边界检查、敏感路径保护。
  - Bash 权限仍是简化前缀匹配，不支持复合命令、子命令拆分和更细规则。
  - `plan mode` 对 Bash 和计划文件的处理仍过粗。
  - 子 agent 权限传播、模式模型、权限状态持久化仍未对齐。

## 目标

- 先把新版 bridge 的权限决策能力补到“至少覆盖历史实现的稳定能力”。
- 再逐步向 Claude Code 的权限模型逼近，尤其是 Bash / 文件系统安全和子 agent 权限传播。
- 保持 `core -> runtime-claude -> channel-feishu` 边界清晰，避免把权限规则重新塞回 channel 层。

## 非目标

- 本阶段不追求一次性完整复刻 Claude Code 全部权限子系统。
- 本阶段不引入与飞书渲染强耦合的权限逻辑。
- 本阶段不把 bridge 控制平面的 `/sx` 风险拦截与 runtime `canUseTool` 权限决策混为一层。

## 实现原则

- 先吸收历史实现中已验证的权限判定结构，再增量吸收 Claude Code 的行为细节。
- 每一阶段都必须附带最小回归测试，避免再次回到“线上观察驱动修修补补”。
- 模式切换、规则来源、审批建议必须有明确的数据结构，不能继续堆在临时 if/else 上。
- 默认策略应以当前产品形态为准：在 IM relaxed 主链路下尽量减少无意义审批，但不能放松高风险边界。

## 阶段拆分

### Phase A: 权限内核重构

### 目标

- 用可扩展的 `PermissionEngine` 替换当前单文件 `PermissionPolicy` 的顺序判断。

### 主要改动

- 在 `packages/runtime-claude/src/permissions/` 引入明确分层：
  - `RuleStore`
  - `ToolClassifier`
  - `ModeHandler`
  - `PathProtection`
  - `BashProtection`
  - `PermissionEngine`
- 保留现有 `PendingInteraction` / `InteractionResolution` 协议，避免先打破飞书审批链路。
- `ClaudeRuntimeSession` 改为依赖新引擎，而不是直接依赖简化 `PermissionPolicy`。

### 验收标准

- 默认模式下的审批行为与当前主链路约束一致，并具备清晰、可扩展的数据结构。
- `AskUserQuestion`、`EnterPlanMode`、`ExitPlanMode` 仍然可工作。
- 旧有测试不回归。

### Phase B: 文件系统安全补齐

### 目标

- 补齐工作区边界、敏感路径和危险文件保护，至少达到当前设计目标要求。

### 主要改动

- 为文件工具增加以下检查：
  - 设备路径 / UNC 路径拦截
  - 工作区外路径 ask
  - 敏感文件和敏感目录保护
  - Claude/bridge 自身配置目录保护
- 为 `acceptEdits` 增加“可 auto-allow 的前提是路径安全”这一约束。
- 为 session 级目录授权补齐显式判定，而不只是作为建议项存在。

### 首批保护范围

- `.git`、`.claude`、`.vscode`、`.idea`
- shell rc 文件和常见配置文件
- `.env`、私钥、`~/.ssh`、`~/.gnupg`
- 工作区外路径

### 验收标准

- 不能再出现“`acceptEdits` 直接放过敏感路径写入”的行为。
- 对工作区外读写操作能稳定进入审批，而不是静默放行。

### Phase C: Bash 权限对齐

### 目标

- 从“命令前缀判断”升级到“子命令 / 复合命令感知”的 Bash 权限模型。

### 主要改动

- 把 Bash 检查拆成三层：
  - 危险模式和代码执行模式检测
  - 只读 Bash 识别
  - 规则匹配和建议生成
- 支持以下行为：
  - `ls && git status` 之类复合命令按子命令判断
  - `Bash(git status)`、`Bash(git:*)` 一类更细规则
  - 复合命令中存在危险子命令时不能被宽规则绕过
- `acceptEdits` 与 IM relaxed 主路径都必须继续受高风险边界约束，不能扩大成“任意 Bash 都可通过”。

### 验收标准

- 复合命令和管道命令不再被单个前缀规则错误覆盖。
- 常规开发 Bash 与高风险 Bash 的分界更稳定，且在默认 / `plan mode` 下都符合当前主链路预期。

### Phase D: Plan Mode 与模式状态机修正

### 目标

- 修复当前 `plan mode` 过于粗暴的问题，并明确模式状态机。

### 主要改动

- 调整 `plan mode` 行为：
  - 允许常规探索与低风险工作
  - 对计划文件写入提供受控豁免
  - 高风险执行走审批，而不是简单全 deny
- 显式维护 `prePlanMode` 和模式切换事件。
- 排查 `ExitPlanMode` 在非 plan mode 下被调用的根因：
  - 工具暴露是否过宽
  - system prompt 是否错误引导
  - SDK 兼容层是否需要额外防护

### 验收标准

- `ExitPlanMode` 不再主要依赖当前的 no-op 降噪。
- `plan mode` 下的常规探索与高风险提醒语义与真实使用预期一致。

### Phase E: 权限规则来源与持久化

### 当前状态

- 本阶段当前不作为主线目标。
- 仓库当前明确不考虑“服务重启后恢复上下文”的产品语义，因此这里保留为未来如需引入恢复能力时的设计草案。

### 目标

- 把权限授权从“进程内临时记忆”升级到“有来源、可恢复、可审计”的状态。

### 主要改动

- 为权限规则区分来源：
  - session
  - local/project
  - user
- 持久化以下状态：
  - 已允许目录
  - session 级 allow/deny/ask 规则
  - 模式变更
- 定义重启恢复语义，明确哪些状态保留，哪些状态只在当前 turn 或当前 session 有效。

### 验收标准

- bridge 重启后，权限行为不再全部回到冷启动状态。
- 用户能区分“本次允许”和“会话/本地长期允许”。

### Phase F: 子 Agent 与 Claude Code 细节对齐

### 目标

- 向 Claude Code 进一步逼近，补齐当前缺失的权限传播和内部模式细节。

### 主要改动

- 设计子 agent 权限传播模型：
  - 何时继承父级 mode
  - 何时使用更保守模式
  - 是否需要引入类似 `bubble` 的内部模式
- 评估是否需要引入 `auto` / classifier 相关模式占位，但不强依赖其全部能力。
- 对 MCP 工具、Agent 工具、异步子任务补齐更细粒度规则。

### 验收标准

- 子 agent 不再简单复用主 agent 的扁平权限判断。
- 模式模型能承接后续更高保真对齐，而不是再次推倒重来。

## 测试计划

### 单元测试

- 新增 `tests/permission-engine.test.ts`
  - allow / deny / ask 规则优先级
  - mode 决策顺序
  - 目录授权生效范围
- 扩展 `tests/permission-policy.test.ts` 或迁移为新引擎测试
  - Bash prefix / wildcard / compound command
  - 敏感路径写入
  - 工作区外路径访问
  - `plan mode` 下只读 Bash

### 集成测试

- 在 runtime session 层覆盖：
  - `canUseTool` -> interaction -> resolve -> resume
  - `ExitPlanMode` 批准 / 拒绝
  - 多轮 session resume 后权限状态是否延续
- 在 Feishu adapter 层覆盖：
  - 权限卡片建议项结构
  - 审批后的完成态卡片
  - 错误 resolution payload 的兜底行为

### 回放测试

- 选取历史实现与调试日志中的真实样例，补成固定回归 case：
  - 非 plan mode 下异常 `ExitPlanMode`
  - 复合 Bash 命令
  - 子 agent 晚到通知期间的权限审批

## 交付顺序

1. 先完成 Phase A + Phase B。
2. 然后完成 Phase C + Phase D。
3. Phase E 仅在产品重新引入“恢复/可审计持久状态”需求后再评估。
4. Phase F 单独作为高保真兼容阶段推进，不阻塞前面主链路加固。

## 里程碑定义

- M1: 新权限内核替换完成，基础行为达到当前设计目标。
- M2: 文件系统和 Bash 安全边界补齐，可上线做真实环境联调。
- M3: `plan mode`、规则持久化、模式状态机进入稳定态。
- M4: 子 agent 权限传播和 Claude Code 细节对齐。

## 当前建议的第一批落地任务

1. 继续提升 Bash 风险判断，从简单模式匹配逐步收敛到“命令类别 + 目标路径”联合判断。
2. 继续补齐目录授权、敏感路径与工作区边界的回归测试。
3. 继续校准 `plan mode` 与 `ExitPlanMode` 的真实触发语义。
4. 在需要更高保真时，再推进子 agent / MCP 工具的权限传播建模。
