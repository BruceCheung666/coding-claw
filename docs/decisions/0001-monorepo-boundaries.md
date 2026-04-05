# 0001: Monorepo Boundaries

## Decision

Use a pnpm workspace with separate `core`, `runtime-claude`, `channel-feishu`, and `apps/bridge` packages.

## Why

- Multi-channel and multi-runtime support requires strict dependency direction.
- The old bridge mixed SDK behavior, channel rendering, and policy logic in the same process layer.
- Package boundaries make it easier to add OpenAI/Codex behavior without leaking Claude-specific event shapes into every adapter.

## Consequences

- Shared event and store types live in `packages/core`.
- Runtime compatibility patches live only in runtime packages.
- Channel-specific rendering must consume normalized bridge events.
