import type { EngineInterface, Register } from 'claude-code'

// Lets Claude decide when to compact: it calls compact_context at a natural
// breakpoint, and the compaction runs once that turn ends (the engine refuses
// $.session.compact while a turn runs). Only accepted past the idle-compaction
// size, so a small context is never summarized away.

const NAME = 'compact_context'
const TOOL = 'mcp__self-compact__compact_context'

// The engine's idle-compaction size (2.1.296): CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS
// held to at least 100k, else 200k. Its server-side flag (tengu_sunny_locket
// minTokens) can't be read from a mod, so only the env override is followed.
const IDLE_MIN_DEFAULT = 200_000
const IDLE_MIN_FLOOR = 100_000

// A compaction asked for right at turn end can still meet a turn in flight
// (a queued prompt starting); retry a few times, then wait for the next turn end.
const RETRY_MS = 2_000
const MAX_RETRIES = 5

const SCHEMA = {
  type: 'object',
  properties: {
    focus: {
      type: 'string',
      description:
        'What the summary must keep in detail: open tasks, file paths, decisions and why, unresolved errors, the latest user instructions.',
    },
    reason: {
      type: 'string',
      description: 'One line: why this is a good breakpoint.',
    },
  },
  additionalProperties: false,
}

type Pending = { instructions?: string; reason?: string; tokens: number }

let pending: Pending | undefined
let isCompacting = false

const fmt = (n: number | undefined): string =>
  n === undefined ? 'unknown' : `${Math.round(n / 1000)}k`

// The engine's "not between turns" rejections (2.1.296): worth a retry. Anything
// else (summarizer failure, thin client) is not retried, as each try costs a model call.
export const isBusy = (message: string): boolean =>
  /turn is running|turn is in flight|compacts between turns/i.test(message)

async function idleMinTokens($: EngineInterface): Promise<number> {
  const raw = (await $.env.get('CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS'))?.trim()
  const n = raw ? Number(raw) : NaN

  return Number.isFinite(n) ? Math.max(IDLE_MIN_FLOOR, n) : IDLE_MIN_DEFAULT
}

async function isCompactDisabled($: EngineInterface): Promise<boolean> {
  const raw = (await $.env.get('DISABLE_COMPACT'))?.trim().toLowerCase()

  return raw !== undefined && !['', '0', 'false', 'no', 'off'].includes(raw)
}

function describe(min: number): string {
  return [
    'Compact (summarize) this conversation once the current turn ends, freeing context for the work ahead.',
    'Call it at a natural breakpoint: a subtask is done and verified, and what comes next does not need the raw detail of what came before (long tool outputs, dead ends, superseded drafts).',
    `Accepted only when the context holds more than ${fmt(min)} tokens (the idle-compaction size); below that it is refused, so carry on without compacting.`,
    'After calling it, finish your reply: compaction runs after this turn, and your next turn starts from the summary.',
  ].join(' ')
}

function schedule($: EngineInterface, job: Pending, attempt: number): void {
  $.clock.after(attempt === 0 ? 0 : RETRY_MS, () => void compact($, job, attempt))
}

async function compact($: EngineInterface, job: Pending, attempt: number): Promise<void> {
  if (pending !== job || isCompacting) return
  isCompacting = true

  try {
    // Re-check: auto-compaction may have run since the tool call.
    const min = await idleMinTokens($)
    const tokens = (await $.session.usage()).context.tokens
    if (tokens !== undefined && !(tokens > min)) {
      pending = undefined
      $.ui.status(undefined)
      $.ui.log(`dropped, the context is already ${fmt(tokens)} tokens (needs > ${fmt(min)})`)
      return
    }

    $.ui.status('compacting at Claude’s request…')
    const done = await $.session.compact(job.instructions ? { instructions: job.instructions } : {})
    pending = undefined
    $.ui.status(undefined)

    if (done.skip !== undefined) {
      $.ui.log(`compaction skipped: ${done.skip}`)
      return
    }
    const line = `compacted at Claude’s request: ${fmt(done.tokensBefore ?? job.tokens)} → ${fmt(done.tokensAfter)} tokens`
    $.ui.toast(line)
    $.ui.log(line, { to: 'debug' })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const busy = isBusy(message)

    if (busy && attempt < MAX_RETRIES) {
      $.ui.log(`busy, retry ${attempt + 1}/${MAX_RETRIES}: ${message}`, { to: 'debug' })
      isCompacting = false
      schedule($, job, attempt + 1)
      return
    }
    if (busy) {
      // Keep it queued: the next turn end tries again.
      $.ui.status('compact queued (waiting for an idle moment)')
      $.ui.log(`still busy after ${MAX_RETRIES} retries; trying again when the next turn ends`)
      return
    }
    pending = undefined
    $.ui.status(undefined)
    $.ui.log(`compaction failed: ${message}`)
  } finally {
    isCompacting = false
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const min = await idleMinTokens($)
    await $.tool.register({ name: NAME, description: describe(min), inputSchema: SCHEMA, isDeferred: false })
    $.ui.log(`${TOOL} registered, threshold > ${fmt(min)} tokens`, { to: 'debug' })

    return next(e)
  })

  on('tool.call', { tool: TOOL }, async ($, e) => {
    if (e.agentId !== undefined) {
      return { deny: 'compact_context compacts the main conversation; a subagent cannot call it.' }
    }
    if (await isCompactDisabled($)) {
      return { deny: 'Compaction is switched off in this session (DISABLE_COMPACT).' }
    }

    const min = await idleMinTokens($)
    const tokens = (await $.session.usage()).context.tokens
    if (tokens === undefined || !(tokens > min)) {
      $.ui.log(`refused at ${fmt(tokens)} tokens (needs > ${fmt(min)})`, { to: 'debug' })
      return {
        deny: `Not compacting: the context holds ${fmt(tokens)} tokens and this tool needs more than ${fmt(min)} (the idle-compaction size). Carry on; auto-compaction still runs at its usual threshold.`,
      }
    }

    const focus = typeof e.focus === 'string' ? e.focus.trim() : ''
    const reason = typeof e.reason === 'string' ? e.reason.trim() : ''
    pending = { instructions: focus || undefined, reason: reason || undefined, tokens }
    $.ui.status(`compact queued (${fmt(tokens)} tokens)`)
    $.ui.log(`Claude queued a compaction at ${fmt(tokens)} tokens${reason ? ` (${reason})` : ''}`)

    return {
      result: `Compaction queued: it runs once this turn ends (context ${fmt(tokens)} tokens > ${fmt(min)}). Finish your reply now; your next turn starts from the summary.`,
    }
  }).catch(() => ({ deny: 'self-compact failed while checking the context; not compacting.' }))

  on('turn.complete', async ($, e, next) => {
    const answered = await next(e)
    if (e.agentId !== undefined || pending === undefined) return answered

    if (e.reason !== 'answer') {
      // Interrupted or failed turn: the person takes over, so drop the request.
      $.ui.log(`turn ended (${e.reason}); the queued compaction is dropped`)
      pending = undefined
      $.ui.status(undefined)
      return answered
    }

    schedule($, pending, 0)
    return answered
  })
}
