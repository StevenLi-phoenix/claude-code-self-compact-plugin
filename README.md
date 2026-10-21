# self-compact

A Claude Code mod that lets Claude decide when to compact its own context.

Claude Code has no built-in way for the model to compact: `/compact` is a `local` command the Skill tool refuses, and model-scheduled prompts skip slash commands. This mod adds a tool, `compact_context`, that Claude calls at a natural breakpoint; the mod compacts once that turn ends.

## How it behaves

- **Size gate.** Only accepted when the live context holds **more than the idle-compaction size**: `CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS`, held to at least 100k, else 200k (the engine's own rule in 2.1.296). Below that the call is refused and Claude is told the current size and the threshold.
- **Deferred.** The engine refuses `$.session.compact` mid-turn, so the tool only queues the request; it runs on `turn.complete`. If a new turn is already running, it retries 5× at 2 s, then waits for the next turn end.
- **Re-checked.** Right before compacting, the size is read again; if auto-compaction already shrank the context, the request is dropped.
- **Focus.** The tool's `focus` argument becomes the summary instructions (what `/compact <text>` would pass).
- **Main loop only.** A subagent cannot call it, and a subagent's turn end does not fire it. An interrupted (Esc) or failed turn drops the request.
- `DISABLE_COMPACT` refuses the tool.

Status line shows `compact queued …` / `compacting …`; a toast reports `before → after` tokens. Lines are logged to the transcript and to `claude --debug`.

## Run

```sh
claude --plugin-dir /path/to/self-compact
```

Or every session: add the folder to `CLAUDE_CODE_PLUGIN_DIRS` in the `env` block of `~/.claude/settings.json`.

## Test

```sh
claude plugin validate ./self-compact
claude plugin test ./self-compact
```
