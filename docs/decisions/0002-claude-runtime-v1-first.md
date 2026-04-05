# 0002: Claude Runtime Uses V1-Compatible Behavior First

## Decision

The first implementation targets the stable Agent SDK behavior that already works in the old bridge, while keeping a future-facing facade for v2.

## Why

- v2 preview is incomplete and unstable for bridge fidelity work.
- Existing production knowledge and debug logs already validate the v1-style query/resume path.
- The highest-risk compatibility issue is not API aesthetics, it is turn completion and child-agent drain correctness.

## Consequences

- The runtime wrapper exposes a stable `RuntimeSession` API to the bridge.
- When v2 becomes usable, migration happens inside `packages/runtime-claude`.
