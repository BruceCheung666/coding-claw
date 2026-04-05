# 项目目标与约束

## 项目目标

- 当前目标是实现一个“用飞书承载 Claude Code 风格工作流”的 TypeScript 项目。
- 长期目标是演进为通用桥接内核，使不同 IM（如飞书、企业微信、Matrix）可接入不同 Agent Runtime（如 Claude Code 风格、Codex 风格）。
- 当前阶段只落地“飞书接入 Claude 风格 Agent Runtime”，但架构必须为多 IM、多 Runtime 预留清晰边界。

## 参考基线

- 历史实现参考（本地自定义，可按需替换）：
  `<local-history-reference-path>`
- 行为观察与实验性参考实现（本地自定义，可按需替换）：
  `<local-experimental-reference-path>`
- 行为分析日志参考：
  `${HOME}/.claude/debug/<debug-session-id>.txt`
- 官方参考文档：
  - `https://platform.claude.com/docs/en/agent-sdk/typescript-v2-preview`
  - `https://open.feishu.cn/document/server-docs/im-v1/introduction`

## 核心实现原则

- 这是一个重新设计的项目，没有历史包袱，优先系统化设计，不要只做最小改动。
- 优先对齐 Claude Code 的真实行为，而不是只让功能“看起来能用”。
- 建议按 Claude Code 模块逐个逼近实现：
  - system prompt
  - session / resume
  - plan mode
  - AskUserQuestion
  - 权限审批
  - sub-agent drain
  - 渲染与交互
- 历史实现中已验证的兼容逻辑，尤其是 `query` 流与子 agent 排空处理，不能轻易删除。

## SDK 与版本策略

- `@anthropic-ai/claude-agent-sdk` v2 不稳定或能力缺失时，优先采用 v1 兼容方案逼近 v2/Claude Code 行为。
- 行为一致性优先于追新版本。
- 对默认运行链路不要做过度假设，能显式配置的路径、版本、环境应尽量显式化。

## 文档与协作规范

- 所有沟通使用中文，文档默认写中文版。
- 每完成一个大的开发节点，都要更新 `docs/development-stages.md`，记录：
  - 本阶段完成内容
  - 当前已知问题
  - 下一阶段待办
- 阶段文档更新后应配套一次 git 提交。
- 讨论中形成的约定、边界条件、排障结论要写入 `docs/`，不能只留在对话里。
- 重要错误与踩坑要写入 `docs/errors/` 或阶段文档，避免重复犯错。

## 当前已确认的具体约束

- 对重复消息问题，优先使用“持久化 `message_id` 去重”，不要依赖启发式同 prompt 拦截。
- 不再做“同 prompt 短窗口自动屏蔽”这类强策略。
- 子 agent drain 可以做兜底，但超时应保持较长，当前约定为 10 分钟。
- IM 默认权限策略按“工作区内常规开发操作默认放行、仅高风险动作审批”设计，不再把 Claude Code CLI 的保守授权语义原样照搬到飞书主链路。
- `plan mode` 在 IM 场景下主要承担计划约束与高风险提醒，不再默认退化成“只读模式”。
- `dist/` 属于构建产物：允许在本地和 CI 中生成，但不纳入版本控制，也不作为源码评审对象。
- 运行依赖 `dist` 的入口（例如 `pnpm start`）必须先经过 `pnpm build`，不要假设仓库里预置了构建产物。
- CI 与发布前校验默认从源码安装、检查并构建，不依赖仓库中携带的 `dist` 目录。
- 如果某次改动改变了运行方式、依赖方式或关键行为，必须同步更新文档。
- 如果开发中发现新的平台约束、协议限制或 schema 规范缺口，必须同时做三件事：
  - 修复当前代码路径
  - 增加最小回归测试
  - 把约束和排障结论补到 `docs/errors/` 或相关设计文档，持续完善文档基线
