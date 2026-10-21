# self-compact

A Claude Code mod that lets Claude decide when to compact its own context.

Claude Code has no built-in way for the model to compact: `/compact` is a `local` command the Skill tool refuses, and model-scheduled prompts skip slash commands. This mod adds a tool, `compact_context`, that Claude calls at a natural breakpoint; the mod compacts once that turn ends.

## How it behaves

- **Size gate.** Only accepted when the live context holds **more than the idle-compaction size**: `CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS`, held to at least 100k, else 200k (the engine's own rule in 2.1.296). Below that the call is refused and Claude is told the current size and the threshold.
- **Deferred.** The engine refuses `$.session.compact` mid-turn, so the tool only queues the request; it runs on `turn.complete`. If a new turn is already running, it retries 5× at 2 s, then waits for the next turn end.
- **Re-checked.** Right before compacting, the size is read again; if auto-compaction already shrank the context, the request is dropped.
- **Focus.** The tool's `focus` argument becomes the summary instructions (what `/compact <text>` would pass).
- **Carrying on.** `next` names the work that remains. Once the compaction is done (or auto-compaction got there first) the mod submits it as a prompt (“Compacted at your request. Carry on: …”, read as the plugin's message), so Claude picks the work back up from the summary instead of the session sitting idle. Without `next`, or after a skipped or failed compaction, the person speaks next. A request that had to wait past a later turn drops its `next`, as that turn may have changed course.
- **Main loop only.** A subagent cannot call it, and a subagent's turn end does not fire it. An interrupted (Esc) or failed turn drops the request.
- `DISABLE_COMPACT` refuses the tool.
- **Reminder past 400k.** Once the context holds more than 400k tokens (or the idle-compaction size, if that is higher), every prompt carries a note Claude reads and the person never sees: the size, and to watch for a good breakpoint to call `compact_context` (a phase finished and verified). It is Claude's judgment, not an order: until such a point comes, it carries on. Inside a long turn a tool result carries the same note when the context crosses the line, then again every further 100k. No note while a compaction is queued, on `/compact`, in a subagent, or under `DISABLE_COMPACT`; after a compaction the next crossing reminds again.

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
