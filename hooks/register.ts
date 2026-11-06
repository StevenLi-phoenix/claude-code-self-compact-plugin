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

// Past this size Claude is reminded to look for a breakpoint to compact at (its
// judgment, not an order): once on crossing it, then each time the context grew
// another step, at a prompt or after a tool call, whichever comes first. Not on
// every prompt (2026-10-20). 2026-10-20: a session ran to 440k with nobody calling the tool.
const REMIND_TOKENS = 300_000
const REMIND_STEP = 100_000

// What a carry-on quotes of the Stop hook that held the work open.
const HELD_MAX = 2_000

// How long a finished compaction leaves the engine to start what it had queued,
// before an idle session gets a prompt of its own. The engine drains its queue as the
// compaction ends, and a chain's first hook runs within milliseconds of that.
export const SETTLE_MS = 1_000

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
    next: {
      type: 'string',
      description:
        'The work that remains, as an instruction to yourself (e.g. "run the full suite, then commit"). Sent as a prompt once the compaction is done, so you carry on by yourself; without it the session waits for the user, unless a Stop hook such as /goal still wants work done. Leave it out only when the work is finished.',
    },
  },
  additionalProperties: false,
}

type Pending = {
  instructions?: string
  reason?: string
  next?: string
  tokens: number
  // What a Stop hook answered the last time this turn tried to end: more work wanted.
  heldBy?: string
}

let pending: Pending | undefined
let isCompacting = false
// A compaction the mod ended a turn for did not run. Until one does, requests wait
// for a real turn end: each forced round costs a model call, so a summarizer that
// keeps failing must not loop them.
let isForcingOff = false
// The carry-on not yet handed over, and whether a main-loop turn could take it.
let owed: string | undefined
let isTurnRunning = false
// The context size at the last reminder; cleared once it is back under the line.
let remindedAt: number | undefined

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
    'After calling it, finish your reply: compaction runs after this turn. Pass `next` whenever work remains: the next turn then starts on it from the summary; without it the session waits for the user.',
    'A Stop hook such as /goal does not hold the compaction back: the turn still ends for it, and the work resumes after it.',
  ].join(' ')
}

// What the turn after the compaction starts on: the work Claude said remains. Without
// it the session sat idle until the user typed (2026-10-20). Undefined: nothing to do.
function carryOnText(job: Pending, didNotRun?: string): string | undefined {
  const { next, heldBy } = job
  if (!next && heldBy === undefined) return undefined
  return [
    didNotRun === undefined ? 'Compacted at your request.' : `The compaction did not run (${didNotRun}); you keep the context you had.`,
    next ? `Carry on with what is not done yet: ${next}` : 'Carry on with what the Stop hook below still asks for.',
    ...(heldBy === undefined ? [] : [`\n\nA Stop hook held this work open when the turn ended: ${heldBy.slice(0, HELD_MAX)}`]),
  ].join(' ')
}

// A carry-on riding beside something that got in first, once.
function takeOwed($: EngineInterface, on: string): string | undefined {
  const text = owed
  if (text === undefined) return undefined
  owed = undefined
  $.ui.log(`carrying on, beside ${on}`, { to: 'debug' })
  return `${text}\n\nThis comes beside something that reached you first: if that says otherwise, it wins.`
}

// An idle session needs a prompt to start a turn. A plugin's prompt only runs once
// idle and behind a notification, so it never goes out over a running turn: that turn's
// next tool result takes it, or this runs again when it ends. A session got it five
// minutes late as a new order, while it worked on the same thing (2026-11-06).
async function submitOwed($: EngineInterface): Promise<void> {
  if (owed === undefined || isTurnRunning) return
  const text = owed
  owed = undefined
  try {
    await $.prompt.submit({ text })
    $.ui.log('carrying on, with a prompt of its own', { to: 'debug' })
  } catch (err) {
    $.ui.log(`could not carry on after the compaction: ${err instanceof Error ? err.message : String(err)}`)
  }
}

function settleOwed($: EngineInterface): void {
  $.clock.after(SETTLE_MS, () => void submitOwed($))
}

// A compaction that did not run: the user speaks next, unless the mod ended the
// turn over a Stop hook. Then resuming is its job, or a /goal sits paused.
function afterNoRun($: EngineInterface, job: Pending, why: string): void {
  owed = undefined
  if (job.heldBy === undefined) return
  isForcingOff = true
  owed = carryOnText(job, why)
  settleOwed($)
}

// What Claude reads past the reminder size, or undefined: on crossing it, then
// only once the context grew a step past the last reminder.
async function reminder($: EngineInterface): Promise<string | undefined> {
  if (pending !== undefined || (await isCompactDisabled($))) return undefined

  // Never below the size the tool accepts, or the reminder points at a refusal.
  const min = Math.max(REMIND_TOKENS, await idleMinTokens($))
  const tokens = (await $.session.usage()).context.tokens
  if (tokens === undefined || !(tokens > min)) {
    remindedAt = undefined
    return undefined
  }
  if (remindedAt !== undefined && tokens < remindedAt + REMIND_STEP) return undefined

  remindedAt = tokens
  $.ui.log(`reminded Claude to compact at ${fmt(tokens)} tokens`, { to: 'debug' })
  return [
    `The context holds ${fmt(tokens)} tokens, past ${fmt(min)}.`,
    `Watch for a good breakpoint to call ${TOOL} with a specific focus (and next, when work remains): a phase finished and verified, and what comes next does not need the raw detail so far.`,
    'It is your call, not an order: until such a point comes, carry on.',
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
      owed = carryOnText(job)
      settleOwed($)
      return
    }

    $.ui.status('compacting at Claude’s request…')
    // Before the call: the engine starts what it had queued as the compaction ends,
    // ahead of the code after this await.
    owed = carryOnText(job)
    const done = await $.session.compact(job.instructions ? { instructions: job.instructions } : {})
    pending = undefined
    $.ui.status(undefined)

    if (done.skip !== undefined) {
      $.ui.log(`compaction skipped: ${done.skip}`)
      afterNoRun($, job, done.skip)
      return
    }
    isForcingOff = false
    const line = `compacted at Claude’s request: ${fmt(done.tokensBefore ?? job.tokens)} → ${fmt(done.tokensAfter)} tokens`
    $.ui.toast(line)
    $.ui.log(line, { to: 'debug' })
    settleOwed($)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const busy = isBusy(message)
    owed = undefined

    if (busy && attempt < MAX_RETRIES) {
      $.ui.log(`busy, retry ${attempt + 1}/${MAX_RETRIES}: ${message}`, { to: 'debug' })
      isCompacting = false
      schedule($, job, attempt + 1)
      return
    }
    if (busy) {
      // Keep it queued: the next turn end tries again. That turn may have
      // changed course, so `next` is stale by then.
      job.next = undefined
      $.ui.status('compact queued (waiting for an idle moment)')
      $.ui.log(`still busy after ${MAX_RETRIES} retries; trying again when the next turn ends, without carrying on`)
      return
    }
    pending = undefined
    $.ui.status(undefined)
    $.ui.log(`compaction failed: ${message}`)
    afterNoRun($, job, message)
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
    const next = typeof e.next === 'string' ? e.next.trim() : ''
    pending = { instructions: focus || undefined, reason: reason || undefined, next: next || undefined, tokens }
    $.ui.status(`compact queued (${fmt(tokens)} tokens)`)
    $.ui.log(`Claude queued a compaction at ${fmt(tokens)} tokens${reason ? ` (${reason})` : ''}`)

    const after = next
      ? `then your next turn starts from the summary on: ${next}`
      : 'then the session waits for the user. If work remains, call again and pass next'
    // `next` often ends a sentence itself; don't stop it twice.
    const stop = /[.!?。！？]$/.test(after) ? '' : '.'
    return {
      result: `Compaction queued: it runs once this turn ends (context ${fmt(tokens)} tokens > ${fmt(min)}), ${after}${stop} Finish your reply now.`,
    }
  }).catch(() => ({ deny: 'self-compact failed while checking the context; not compacting.' }))

  on('prompt.submit', async ($, e, next) => {
    // /compact is already the compaction; a reminder would land in its summary.
    if (e.command?.name === 'compact') return next(e)

    const carrying = e.command === undefined ? takeOwed($, `a prompt (${e.origin.kind})`) : undefined
    const text = await reminder($).catch(() => undefined)
    const context = [...(e.context ?? []), ...(carrying ? [carrying] : []), ...(text ? [text] : [])]
    return next(context.length > (e.context?.length ?? 0) ? { ...e, context } : e)
  })

  on('tool.call', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId !== undefined || done.deny !== undefined) return done

    const carrying = takeOwed($, `a tool result (${e.tool})`)
    const text = await reminder($).catch(() => undefined)
    const context = [...(done.context ?? []), ...(carrying ? [carrying] : []), ...(text ? [text] : [])]
    return context.length > (done.context?.length ?? 0) ? { ...done, context } : done
  })

  // /goal is a Stop hook: until its condition holds it turns each attempt to end
  // the turn into more work, so the compaction queued on turn.complete waited. A
  // session then went from 349k to 436k and compacted nine minutes later, mid-work,
  // on a `next` and `focus` that no longer applied (2026-11-06). So the turn ends
  // here instead. Asking beneath first lets a met goal clear as usual, and the block
  // stays in the answer so the goal check is recorded; `preventContinuation` is what
  // the engine reads first.
  on('classic.Stop', async ($, e, next) => {
    const answered = await next(e)
    if (pending === undefined) return answered

    pending.heldBy = answered.block
    if (answered.block === undefined) return answered
    if (isForcingOff) {
      // The turn works on past the breakpoint, so what Claude named goes stale.
      pending.next = undefined
      $.ui.log('a Stop hook is holding the turn open; the queued compaction waits, as the last one did not run')
      return answered
    }

    $.ui.log(`ending the turn to compact, over a Stop hook: ${answered.block.slice(0, 200)}`)
    return { ...answered, preventContinuation: true, stopReason: 'self-compact: ending the turn to compact; the work resumes after it' }
  })

  on('turn.start', ($, e, next) => {
    if (e.agentId === undefined) isTurnRunning = true
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const answered = await next(e)
    if (e.agentId !== undefined) return answered

    isTurnRunning = false
    if (owed !== undefined) {
      if (e.reason === 'answer') settleOwed($)
      else {
        // Interrupted or failed: the user takes over, as for a queued compaction.
        owed = undefined
        $.ui.log(`turn ended (${e.reason}); the carry-on is dropped`, { to: 'debug' })
      }
    }
    if (pending === undefined) return answered

    if (e.reason !== 'answer') {
      // Interrupted or failed turn: the user takes over, so drop the request.
      $.ui.log(`turn ended (${e.reason}); the queued compaction is dropped`)
      pending = undefined
      $.ui.status(undefined)
      return answered
    }

    schedule($, pending, 0)
    return answered
  })
}
