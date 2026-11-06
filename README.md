# self-compact

A Claude Code mod that lets Claude decide when to compact its own context.

Claude Code has no built-in way for the model to compact: `/compact` is a `local` command the Skill tool refuses, and model-scheduled prompts skip slash commands. This mod adds a tool, `compact_context`, that Claude calls at a natural breakpoint; the mod compacts once that turn ends.

## How it behaves

- **Size gate.** Only accepted when the live context holds **more than the idle-compaction size**: `CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS`, held to at least 100k, else 200k (the engine's own rule in 2.1.296). Below that the call is refused and Claude is told the current size and the threshold.
- **Deferred.** The engine refuses `$.session.compact` mid-turn, so the tool only queues the request; it runs on `turn.complete`. If a new turn is already running, it retries 5× at 2 s, then waits for the next turn end.
- **Stop hooks.** A Stop hook such as `/goal` can refuse to let the turn end, which would hold the compaction back until its condition holds. With a compaction queued, a block ends the turn instead. The block stays in the answer, so a goal check is still recorded, and a hook that passes lets the turn end as usual. The engine shows `Goal paused · a hook ended the turn` until the work resumes. If that compaction does not run, later requests wait for a real turn end until one does, as each forced round costs a model call.
- **Re-checked.** Right before compacting, the size is read again; if auto-compaction already shrank the context, the request is dropped.
- **Focus.** The tool's `focus` argument becomes the summary instructions (what `/compact <text>` would pass).
- **Carrying on.** `next` names the work that remains. Once the compaction is done (or auto-compaction got there first) it goes to Claude (“Compacted at your request. Carry on with what is not done yet: …”), so Claude picks the work back up from the summary instead of the session sitting idle. The engine starts what it had queued as the compaction ends, and a plugin's prompt only runs once idle, behind a notification. So whatever reaches Claude first carries it: the next prompt, notifications included, or the running turn's next tool result. Only an idle session gets a prompt of its own, a second after the compaction. Without `next`, or after a skipped or failed compaction, the user speaks next, unless the turn ended over a Stop hook: then the work resumes on what the hook asked for, or a goal would sit paused. Esc during the compaction always leaves the next word to the user. A request that had to wait past a later turn drops its `next`, as that turn may have changed course.
- **Main loop only.** A subagent cannot call it, and a subagent's turn end does not fire it. An interrupted (Esc) or failed turn drops the request.
- `DISABLE_COMPACT` refuses the tool.
- **Reminder past 300k.** When the context crosses 300k tokens (or the idle-compaction size, if that is higher), Claude gets a note: the size, and to watch for a good breakpoint to call `compact_context` (a phase finished and verified). It is Claude's judgment, not an order: until such a point comes, it carries on. The note rides on the next prompt or tool result, whichever comes first, and comes back only after every further 100k, not on every prompt. No note while a compaction is queued, on `/compact`, in a subagent, or under `DISABLE_COMPACT`; after a compaction the next crossing reminds again.

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
