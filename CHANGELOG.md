# Changelog

## [0.2.0] - 2026-10-20

### Added
- `next` argument: the work that remains, submitted as a prompt once the compaction is done, so Claude carries on instead of the session waiting idle. Not sent after a skipped or failed compaction, or when the request waited past a later turn.
- Reminder past 400k tokens: each prompt, and a tool result each time a long turn grows another 100k, tells Claude to watch for a good breakpoint (a phase finished and verified) to call `compact_context`; its judgment, not an order. Skipped while a compaction is queued, on `/compact`, in subagents and under `DISABLE_COMPACT`; never below the idle-compaction size.

## [0.1.0] - 2026-10-16

### Added
- `compact_context` tool (`mcp__self-compact__compact_context`, in the prompt's tool list) with optional `focus` and `reason`.
- Size gate: accepted only above the idle-compaction size (`CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS`, floor 100k, default 200k).
- Deferred compaction on `turn.complete`, with busy retries, a size re-check, and drop on interrupted/failed turns.
- Tests for the gate, deferral, busy classification and no-retry on other failures (`claude plugin test`).
