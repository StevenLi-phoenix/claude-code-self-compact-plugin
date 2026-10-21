# Changelog

## [0.1.0] - 2026-10-16

### Added
- `compact_context` tool (`mcp__self-compact__compact_context`, in the prompt's tool list) with optional `focus` and `reason`.
- Size gate: accepted only above the idle-compaction size (`CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS`, floor 100k, default 200k).
- Deferred compaction on `turn.complete`, with busy retries, a size re-check, and drop on interrupted/failed turns.
- Tests for the gate, deferral, busy classification and no-retry on other failures (`claude plugin test`).
