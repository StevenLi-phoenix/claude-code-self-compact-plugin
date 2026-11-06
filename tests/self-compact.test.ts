import type { On, TurnCompleteInput } from 'claude-code'
import { describe, expect, mock, test, type Engine } from 'claude-code/testing'

import { isBusy, isCanceled, SETTLE_MS } from '../hooks/register'

const TOOL = 'mcp__self-compact__compact_context'
const SUMMARY = [{ role: 'user' as const, text: 'summary', toolUses: [] }]

type World = {
  clock: ReturnType<typeof mock.clock>
  compactions: (string | undefined)[]
  registered: { name: string; description: string }[]
  // What the plugin submitted, and how many compactions had run by then.
  submitted: { text: string; after: number }[]
  setTokens: (n: number | undefined) => void
}

// Everything beneath the plugin: env, clock, context usage, compaction, UI sinks.
function world(on: On, tokens: number | undefined, env: Record<string, string> = {}): World {
  mock.env(on, env)
  const clock = mock.clock(on)
  let current = tokens
  const compactions: (string | undefined)[] = []
  const registered: { name: string; description: string }[] = []
  const submitted: { text: string; after: number }[] = []

  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: current, window: 1_000_000 }, rateLimits: [] } }))
  on('session.compact', ($, e) => {
    compactions.push(e.instructions)
    const before = current
    current = 20_000
    return { messages: SUMMARY, tokensBefore: before, tokensAfter: 20_000 }
  })
  on('tool.register', ($, e) => {
    registered.push({ name: e.name, description: e.description })
    return { value: { tool: `mcp__self-compact__${e.name}` } }
  })
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('prompt.submit', ($, e) => {
    if (e.origin.kind === 'plugin') submitted.push({ text: e.text, after: compactions.length })
    return { text: e.text, context: e.context, origin: e.origin }
  })
  on('tool.call', () => ({ result: 'ok', text: 'ok' }))
  on('ui.log', () => ({ value: undefined }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))

  return { clock, compactions, registered, submitted, setTokens: n => (current = n) }
}

const prompt = (text = 'next', command?: { name: string; args: string }) => ({
  text,
  wait: false,
  origin: { kind: 'composer' as const },
  ...(command ? { command } : {}),
})

// Runs what is due, then past the wait before an idle session's own prompt.
const drained = async (clock: { settle: () => Promise<void>; advance: (ms: number) => Promise<void> }) => {
  await clock.settle()
  await clock.advance(SETTLE_MS)
}

const reminded = (result: { context?: readonly string[] }): string => (result.context ?? []).join('\n')
const said = (ran: { result?: unknown; deny?: string }): string => ran.deny ?? String(ran.result ?? '')

const turnEnd = (reason: 'answer' | 'aborted' = 'answer', agentId?: string): TurnCompleteInput => ({
  answer: 'done',
  durationMs: 1,
  isAborted: reason === 'aborted',
  turnId: 't1',
  reason,
  ...(agentId ? { agentId } : {}),
})

describe('threshold', () => {
  test('refuses at or below the idle-compaction size (200k default)', async ($, on) => {
    const w = world(on, 200_000)
    const ran = await $.tool.call({ tool: TOOL, focus: 'x' })
    expect(ran.deny ?? ran.text ?? '').toContain('needs more than 200k')
    await $.turn.complete(turnEnd())
    await w.clock.advance(10_000)
    expect(w.compactions).toEqual([])
  })

  test('refuses before the first response reports usage', async ($, on) => {
    const w = world(on, undefined)
    const ran = await $.tool.call({ tool: TOOL })
    expect(ran.deny ?? ran.text ?? '').toContain('Not compacting')
    expect(w.compactions).toEqual([])
  })

  test('follows CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS, floored at 100k', async ($, on) => {
    const w = world(on, 120_000, { CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS: '50000' })
    const ran = await $.tool.call({ tool: TOOL })
    expect(ran.deny).toBeUndefined()
    await $.turn.complete(turnEnd())
    await drained(w.clock)
    expect(w.compactions).toEqual([undefined])
  })

  test('a raised override is honoured', async ($, on) => {
    const w = world(on, 250_000, { CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS: '300000' })
    const ran = await $.tool.call({ tool: TOOL })
    expect(ran.deny ?? '').toContain('needs more than 300k')
    expect(w.compactions).toEqual([])
  })

  test('DISABLE_COMPACT refuses', async ($, on) => {
    world(on, 500_000, { DISABLE_COMPACT: '1' })
    const ran = await $.tool.call({ tool: TOOL })
    expect(ran.deny ?? '').toContain('DISABLE_COMPACT')
  })
})

describe('deferral', () => {
  test('queues, then compacts with the focus only after the turn ends', async ($, on) => {
    const w = world(on, 450_000)
    const ran = await $.tool.call({ tool: TOOL, focus: 'keep the plan', reason: 'phase done' })
    expect(ran.deny).toBeUndefined()
    await w.clock.advance(10_000)
    expect(w.compactions).toEqual([])

    await $.turn.complete(turnEnd())
    await drained(w.clock)
    expect(w.compactions).toEqual(['keep the plan'])

    // Nothing stays queued: the next turn end compacts nothing.
    await $.turn.complete(turnEnd())
    await w.clock.advance(10_000)
    expect(w.compactions).toEqual(['keep the plan'])
  })

  test('an interrupted turn drops the request', async ($, on) => {
    const w = world(on, 450_000)
    await $.tool.call({ tool: TOOL })
    await $.turn.complete(turnEnd('aborted'))
    await $.turn.complete(turnEnd())
    await w.clock.advance(10_000)
    expect(w.compactions).toEqual([])
  })

  test('a subagent turn end does not fire it', async ($, on) => {
    const w = world(on, 450_000)
    await $.tool.call({ tool: TOOL })
    await $.turn.complete(turnEnd('answer', 'agent-1'))
    await drained(w.clock)
    expect(w.compactions).toEqual([])
    await $.turn.complete(turnEnd())
    await drained(w.clock)
    expect(w.compactions).toEqual([undefined])
  })

  test('skips when the context already shrank before the turn ended', async ($, on) => {
    const w = world(on, 450_000)
    await $.tool.call({ tool: TOOL })
    w.setTokens(30_000) // auto-compaction ran meanwhile
    await $.turn.complete(turnEnd())
    await drained(w.clock)
    expect(w.compactions).toEqual([])
  })
})

describe('busy engine', () => {
  test('the engine’s between-turns rejections count as busy, others do not', () => {
    // Verbatim from Claude Code 2.1.296.
    expect(isBusy('self-compact: $.session.compact: a turn is running (t9); the conversation compacts between turns, so call it from turn.complete or later')).toBe(true)
    expect(isBusy('a turn is in flight; the conversation compacts between turns')).toBe(true)
    expect(isBusy('an external turn is driving the conversation; it compacts between turns')).toBe(true)
    expect(isBusy("a thin client's conversation lives on the remote session; compact it there")).toBe(false)
    expect(isBusy('prompt is too long')).toBe(false)
  })

  test('Esc during the compaction reads as canceled, a failure does not', () => {
    // Verbatim from Claude Code 2.1.319.
    expect(isCanceled('self-compact: $.session.compact: Compaction canceled.')).toBe(true)
    expect(isCanceled('prompt is too long')).toBe(false)
    expect(isCanceled('self-compact: $.session.compact: a turn is running (t9)')).toBe(false)
  })

  test('a non-busy rejection drops the request without retrying', async ($, on) => {
    mock.env(on, {})
    const clock = mock.clock(on)
    let attempts = 0
    on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: 450_000, window: 1_000_000 }, rateLimits: [] } }))
    on('session.compact', () => {
      attempts += 1
      throw new Error('summarizer failed') // skipped: the kit's bottom then rejects the call
    })
    on('turn.complete', ($, e) => ({ text: e.answer }))
    on('ui.log', () => ({ value: undefined }))
    on('ui.status', () => ({ value: undefined }))
    on('ui.toast', () => ({ value: undefined }))

    await $.tool.call({ tool: TOOL })
    await $.turn.complete(turnEnd())
    await drained(clock)
    expect(attempts).toBe(1)
    await clock.advance(30_000)
    await $.turn.complete(turnEnd())
    await clock.advance(30_000)
    expect(attempts).toBe(1)
  })
})

describe('carrying on', () => {
  test('with next, the work that remains is sent as a prompt once the compaction is done', async ($, on) => {
    const w = world(on, 450_000)
    const ran = await $.tool.call({ tool: TOOL, focus: 'keep the plan', next: 'run the full suite, then commit' })
    expect(said(ran)).toContain('run the full suite, then commit')
    await $.turn.complete(turnEnd())
    await drained(w.clock)
    expect(w.compactions).toEqual(['keep the plan'])
    expect(w.submitted.length).toBe(1)
    expect(w.submitted[0]?.after).toBe(1)
    expect(w.submitted[0]?.text).toContain('run the full suite, then commit')
    // Another turn can get in first, so it must not read as if nothing were done.
    expect(w.submitted[0]?.text).toContain('not done yet')

    // Once only: the next turn end sends nothing.
    await $.turn.complete(turnEnd())
    await w.clock.advance(10_000)
    expect(w.submitted.length).toBe(1)
  })

  test('a next ending in a full stop is echoed with one', async ($, on) => {
    world(on, 450_000)
    const ran = await $.tool.call({ tool: TOOL, next: 'Run the suite. Then commit.' })
    expect(said(ran)).toContain('Then commit. Finish your reply now.')
    expect(said(ran)).not.toContain('..')
  })

  test('without next the user speaks next, and the tool says so', async ($, on) => {
    const w = world(on, 450_000)
    const ran = await $.tool.call({ tool: TOOL })
    expect(said(ran)).toContain('pass next')
    await $.turn.complete(turnEnd())
    await drained(w.clock)
    expect(w.compactions).toEqual([undefined])
    expect(w.submitted).toEqual([])
  })

  test('carries on when auto-compaction got there first', async ($, on) => {
    const w = world(on, 450_000)
    await $.tool.call({ tool: TOOL, next: 'step 3' })
    w.setTokens(30_000)
    await $.turn.complete(turnEnd())
    await drained(w.clock)
    expect(w.compactions).toEqual([])
    expect(w.submitted.map(s => s.text).join('')).toContain('step 3')
  })

  test('an interrupted turn neither compacts nor carries on', async ($, on) => {
    const w = world(on, 450_000)
    await $.tool.call({ tool: TOOL, next: 'step 3' })
    await $.turn.complete(turnEnd('aborted'))
    await $.turn.complete(turnEnd())
    await w.clock.advance(10_000)
    expect(w.submitted).toEqual([])
  })

  // Each try costs a model call: after a skip or a failure the user decides.
  const settles = (outcome: 'skip' | 'fail') => async ($: Engine, on: On) => {
    mock.env(on, {})
    const clock = mock.clock(on)
    const submitted: string[] = []
    on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: 450_000, window: 1_000_000 }, rateLimits: [] } }))
    on('session.compact', () => {
      if (outcome === 'fail') throw new Error('summarizer failed')
      return { skip: 'a PreCompact hook blocked it' }
    })
    on('prompt.submit', ($, e) => {
      submitted.push(e.text)
      return { text: e.text }
    })
    on('turn.complete', ($, e) => ({ text: e.answer }))
    on('ui.log', () => ({ value: undefined }))
    on('ui.status', () => ({ value: undefined }))
    on('ui.toast', () => ({ value: undefined }))

    await $.tool.call({ tool: TOOL, next: 'step 3' })
    await $.turn.complete(turnEnd())
    await drained(clock)
    expect(submitted).toEqual([])
  }
  test('a skipped compaction does not carry on', settles('skip'))
  test('a failed compaction does not carry on', settles('fail'))
})

// /goal is a Stop hook: until its condition holds it turns each attempt to end the
// turn into more work, and the queued compaction only runs once the turn ends.
describe('a Stop hook holding the turn open', () => {
  const NOT_MET = '[done.txt exists]: not satisfied, done.txt is missing'
  const stop = ($: Engine) => $.classic.Stop({ stop_hook_active: false })

  test('a queued compaction ends the turn over the block, and the block still counts', async ($, on) => {
    const w = world(on, 450_000)
    on('classic.Stop', () => ({ block: NOT_MET }))
    await $.tool.call({ tool: TOOL, focus: 'keep the plan', next: 'step 3' })

    const ran = await stop($)
    expect(ran.preventContinuation).toBe(true)
    expect(ran.block).toBe(NOT_MET)
    expect(ran.stopReason ?? '').toContain('compact')

    await $.turn.complete(turnEnd())
    await drained(w.clock)
    expect(w.compactions).toEqual(['keep the plan'])
    expect(w.submitted.length).toBe(1)
    expect(w.submitted[0]?.after).toBe(1)
    expect(w.submitted[0]?.text).toContain('step 3')
    expect(w.submitted[0]?.text).toContain('done.txt is missing')
  })

  test('with nothing queued the block stands', async ($, on) => {
    const w = world(on, 450_000)
    on('classic.Stop', () => ({ block: NOT_MET }))
    const ran = await stop($)
    expect(ran.block).toBe(NOT_MET)
    expect(ran.preventContinuation).toBeUndefined()
    expect(w.compactions).toEqual([])
  })

  test('a Stop hook that passes changes nothing: no next, nobody resumes', async ($, on) => {
    const w = world(on, 450_000)
    on('classic.Stop', () => ({}))
    await $.tool.call({ tool: TOOL })
    const ran = await stop($)
    expect(ran.preventContinuation).toBeUndefined()
    await $.turn.complete(turnEnd())
    await drained(w.clock)
    expect(w.compactions).toEqual([undefined])
    expect(w.submitted).toEqual([])
  })

  test('without next the session still resumes, on what the Stop hook asks for', async ($, on) => {
    const w = world(on, 450_000)
    on('classic.Stop', () => ({ block: NOT_MET }))
    await $.tool.call({ tool: TOOL })
    await stop($)
    await $.turn.complete(turnEnd())
    await drained(w.clock)
    expect(w.compactions).toEqual([undefined])
    expect(w.submitted.length).toBe(1)
    expect(w.submitted[0]?.text).toContain('done.txt is missing')
  })

  test('resumes when auto-compaction got there first', async ($, on) => {
    const w = world(on, 450_000)
    on('classic.Stop', () => ({ block: NOT_MET }))
    await $.tool.call({ tool: TOOL })
    await stop($)
    w.setTokens(30_000)
    await $.turn.complete(turnEnd())
    await drained(w.clock)
    expect(w.compactions).toEqual([])
    expect(w.submitted[0]?.text).toContain('done.txt is missing')
  })

  test('an interrupted turn neither compacts nor resumes', async ($, on) => {
    const w = world(on, 450_000)
    on('classic.Stop', () => ({ block: NOT_MET }))
    await $.tool.call({ tool: TOOL, next: 'step 3' })
    await stop($)
    await $.turn.complete(turnEnd('aborted'))
    await drained(w.clock)
    expect(w.compactions).toEqual([])
    expect(w.submitted).toEqual([])
  })

  test('each queued compaction ends its turn', async ($, on) => {
    const w = world(on, 450_000)
    on('classic.Stop', () => ({ block: NOT_MET }))
    await $.tool.call({ tool: TOOL, next: 'step 3' })
    expect((await stop($)).preventContinuation).toBe(true)
    await $.turn.complete(turnEnd())
    await drained(w.clock)

    w.setTokens(450_000)
    await $.tool.call({ tool: TOOL, next: 'step 4' })
    expect((await stop($)).preventContinuation).toBe(true)
  })

  // Ending the turn made resuming the mod's job, or the goal sits paused. It only
  // does so once: each round costs a model call, and a summarizer that keeps
  // failing must not loop them.
  const noRun = (outcome: 'skip' | 'fail') => async ($: Engine, on: On) => {
    mock.env(on, {})
    const clock = mock.clock(on)
    const submitted: string[] = []
    let breaks = true
    let compacted = 0
    on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: 450_000, window: 1_000_000 }, rateLimits: [] } }))
    on('session.compact', () => {
      if (!breaks) {
        compacted += 1
        return { messages: SUMMARY, tokensBefore: 450_000, tokensAfter: 450_000 }
      }
      if (outcome === 'fail') throw new Error('summarizer failed')
      return { skip: 'a PreCompact hook blocked it' }
    })
    on('classic.Stop', () => ({ block: NOT_MET }))
    on('prompt.submit', ($, e) => {
      submitted.push(e.text)
      return { text: e.text }
    })
    on('turn.complete', ($, e) => ({ text: e.answer }))
    on('ui.log', () => ({ value: undefined }))
    on('ui.status', () => ({ value: undefined }))
    on('ui.toast', () => ({ value: undefined }))

    await $.tool.call({ tool: TOOL, next: 'step 3' })
    expect((await stop($)).preventContinuation).toBe(true)
    await $.turn.complete(turnEnd())
    await drained(clock)
    expect(submitted.length).toBe(1)
    expect(submitted[0]).toContain('did not run')
    expect(submitted[0]).toContain('step 3')

    // The next request waits for a real turn end instead of forcing one.
    await $.tool.call({ tool: TOOL, next: 'step 4' })
    expect((await stop($)).preventContinuation).toBeUndefined()

    // A compaction that does run lifts that again.
    breaks = false
    await $.turn.complete(turnEnd())
    await drained(clock)
    expect(compacted).toBe(1)
    // That turn worked on past the request, so its next is stale by now.
    expect(submitted.length).toBe(2)
    expect(submitted[1]).not.toContain('step 4')
    expect(submitted[1]).toContain('done.txt is missing')
    await $.tool.call({ tool: TOOL, next: 'step 5' })
    expect((await stop($)).preventContinuation).toBe(true)
  }
  test('a skipped compaction still resumes the work, then stops forcing', noRun('skip'))
  test('a failed compaction still resumes the work, then stops forcing', noRun('fail'))

  test('a later pass that lets the turn end clears the hold: nobody resumes', async ($, on) => {
    const w = world(on, 450_000)
    let block: string | undefined = NOT_MET
    on('classic.Stop', () => (block ? { block } : {}))
    await $.tool.call({ tool: TOOL })
    await stop($)
    block = undefined
    const ran = await stop($)
    expect(ran.preventContinuation).toBeUndefined()
    await $.turn.complete(turnEnd())
    await drained(w.clock)
    expect(w.compactions).toEqual([undefined])
    expect(w.submitted).toEqual([])
  })
})

// The engine drains its queue the moment the compaction ends, and a plugin's prompt
// only runs once idle, behind a notification. A session got its carry-on five minutes
// late that way, as a new order, while it worked on the same thing. So whatever reaches
// Claude first carries it, and only an idle session gets a prompt of its own.
describe('something else gets in first', () => {
  const notification = () => ({ text: '<task-notification>', wait: false, origin: { kind: 'task-notification' as const } })
  const bash = { tool: 'Bash', command: 'true' }
  const carried = (ran: { context?: readonly string[] }): string => (ran.context ?? []).join('\n')

  test('a notification drained while the compaction ends carries the work, once', async ($, on) => {
    mock.env(on, {})
    const clock = mock.clock(on)
    const submitted: string[] = []
    const ended = Promise.withResolvers<void>()
    on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: 450_000, window: 1_000_000 }, rateLimits: [] } }))
    on('session.compact', async () => {
      await ended.promise
      return { messages: SUMMARY, tokensBefore: 450_000, tokensAfter: 20_000 }
    })
    on('prompt.submit', ($, e) => {
      if (e.origin.kind === 'plugin') submitted.push(e.text)
      return { text: e.text, context: e.context, origin: e.origin }
    })
    on('turn.complete', ($, e) => ({ text: e.answer }))
    on('tool.call', () => ({ result: 'ok', text: 'ok' }))
    on('ui.log', () => ({ value: undefined }))
    on('ui.status', () => ({ value: undefined }))
    on('ui.toast', () => ({ value: undefined }))

    await $.tool.call({ tool: TOOL, next: 'step 3' })
    await $.turn.complete(turnEnd())
    await clock.advance(0)

    // The compaction has not resolved yet when the engine picks the next item.
    const first = await $.prompt.submit(notification())
    expect(carried(first)).toContain('step 3')
    ended.resolve()
    await drained(clock)
    expect(submitted).toEqual([])
    expect(carried(await $.tool.call(bash))).not.toContain('step 3')
  })

  test('a typed prompt carries it too, and is told it wins', async ($, on) => {
    const w = world(on, 450_000)
    await $.tool.call({ tool: TOOL, next: 'step 3' })
    await $.turn.complete(turnEnd())
    await w.clock.advance(0)
    const typed = await $.prompt.submit(prompt('do something else'))
    expect(typed.text).toBe('do something else')
    expect(carried(typed)).toContain('step 3')
    expect(carried(typed)).toContain('it wins')
    await drained(w.clock)
    expect(w.submitted).toEqual([])
  })

  test('a turn already running gets it on its next tool result, once', async ($, on) => {
    const w = world(on, 450_000)
    await $.tool.call({ tool: TOOL, next: 'step 3' })
    await $.turn.complete(turnEnd())
    await w.clock.advance(0)
    await $.turn.start({ text: 'x', turnId: 't2' })
    await drained(w.clock)
    expect(w.submitted).toEqual([])

    expect(carried(await $.tool.call(bash))).toContain('step 3')
    expect(carried(await $.tool.call(bash))).not.toContain('step 3')
    await $.turn.complete({ ...turnEnd(), turnId: 't2' })
    await drained(w.clock)
    expect(w.submitted).toEqual([])
  })

  test('a subagent’s tool result does not take it', async ($, on) => {
    const w = world(on, 450_000)
    await $.tool.call({ tool: TOOL, next: 'step 3' })
    await $.turn.complete(turnEnd())
    await w.clock.advance(0)
    await $.turn.start({ text: 'x', turnId: 't2' })
    await drained(w.clock)
    expect(carried(await $.tool.call({ ...bash, agentId: 'agent-1' }))).not.toContain('step 3')
    expect(carried(await $.tool.call(bash))).toContain('step 3')
  })

  test('that turn ending with no tool call hands it to a prompt of its own', async ($, on) => {
    const w = world(on, 450_000)
    await $.tool.call({ tool: TOOL, next: 'step 3' })
    await $.turn.complete(turnEnd())
    await w.clock.advance(0)
    await $.turn.start({ text: 'x', turnId: 't2' })
    await drained(w.clock)
    await $.turn.complete({ ...turnEnd(), turnId: 't2' })
    await drained(w.clock)
    expect(w.submitted.length).toBe(1)
    expect(w.submitted[0]?.text).toContain('step 3')
  })

  test('that turn interrupted drops it: the user takes over', async ($, on) => {
    const w = world(on, 450_000)
    await $.tool.call({ tool: TOOL, next: 'step 3' })
    await $.turn.complete(turnEnd())
    await w.clock.advance(0)
    await $.turn.start({ text: 'x', turnId: 't2' })
    await drained(w.clock)
    await $.turn.complete({ ...turnEnd('aborted'), turnId: 't2' })
    await drained(w.clock)
    expect(w.submitted).toEqual([])
    expect(carried(await $.tool.call(bash))).not.toContain('step 3')
  })

  test('nothing is owed after a failure nobody has to resume from', async ($, on) => {
    mock.env(on, {})
    const clock = mock.clock(on)
    on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: 450_000, window: 1_000_000 }, rateLimits: [] } }))
    on('session.compact', () => {
      throw new Error('summarizer failed')
    })
    on('prompt.submit', ($, e) => ({ text: e.text, context: e.context, origin: e.origin }))
    on('turn.complete', ($, e) => ({ text: e.answer }))
    on('tool.call', () => ({ result: 'ok', text: 'ok' }))
    on('ui.log', () => ({ value: undefined }))
    on('ui.status', () => ({ value: undefined }))
    on('ui.toast', () => ({ value: undefined }))
    await $.tool.call({ tool: TOOL, next: 'step 3' })
    await $.turn.complete(turnEnd())
    await drained(clock)
    expect(carried(await $.prompt.submit(notification()))).not.toContain('step 3')
    expect(carried(await $.tool.call(bash))).not.toContain('step 3')
  })
})

describe('reminder past 300k', () => {
  test('a prompt past 300k reminds Claude to look for a breakpoint; at 300k none', async ($, on) => {
    const w = world(on, 300_000)
    expect(reminded(await $.prompt.submit(prompt()))).toBe('')

    w.setTokens(350_000)
    const text = reminded(await $.prompt.submit(prompt()))
    expect(text).toContain('350k tokens')
    expect(text).toContain(TOOL)
    expect(text).toContain('good breakpoint')
    expect(text).toContain('not an order')
  })

  test('not on every prompt: again only once the context grew another 100k', async ($, on) => {
    const w = world(on, 350_000)
    expect(reminded(await $.prompt.submit(prompt()))).toContain('350k tokens')
    expect(reminded(await $.prompt.submit(prompt()))).toBe('')
    w.setTokens(449_000)
    expect(reminded(await $.prompt.submit(prompt()))).toBe('')
    w.setTokens(450_000)
    expect(reminded(await $.prompt.submit(prompt()))).toContain('450k tokens')
  })

  test('the prompt as typed is kept, and context already attached stays first', async ($, on) => {
    world(on, 350_000)
    const entered = await $.prompt.submit({ ...prompt('fix it'), context: ['from another hook'] })
    expect(entered.text).toBe('fix it')
    expect(entered.context?.[0]).toBe('from another hook')
    expect(entered.context?.length).toBe(2)
  })

  test('none while a compaction is queued, and none on /compact', async ($, on) => {
    world(on, 350_000)
    expect(reminded(await $.prompt.submit(prompt('/compact', { name: 'compact', args: '' })))).toBe('')
    await $.tool.call({ tool: TOOL })
    expect(reminded(await $.prompt.submit(prompt()))).toBe('')
    expect(reminded(await $.tool.call({ tool: 'Bash', command: 'ls' }))).toBe('')
  })

  test('inside a turn: on crossing 300k, then again only every 100k more', async ($, on) => {
    const w = world(on, 250_000)
    const step = async (tokens: number) => {
      w.setTokens(tokens)
      return reminded(await $.tool.call({ tool: 'Bash', command: 'ls' }))
    }
    expect(await step(250_000)).toBe('')
    expect(await step(320_000)).toContain('320k tokens')
    expect(await step(380_000)).toBe('')
    expect(await step(419_000)).toBe('')
    expect(await step(420_000)).toContain('420k tokens')
  })

  test('prompts and tool calls share one count', async ($, on) => {
    const w = world(on, 350_000)
    expect(reminded(await $.prompt.submit(prompt()))).toContain('350k')
    w.setTokens(400_000)
    expect(reminded(await $.tool.call({ tool: 'Read', file_path: '/tmp/x' }))).toBe('')
    w.setTokens(460_000)
    expect(reminded(await $.tool.call({ tool: 'Read', file_path: '/tmp/x' }))).toContain('460k')
    w.setTokens(500_000)
    expect(reminded(await $.prompt.submit(prompt()))).toBe('')
  })

  test('after a compaction the next crossing reminds again', async ($, on) => {
    const w = world(on, 350_000)
    expect(reminded(await $.tool.call({ tool: 'Bash', command: 'ls' }))).toContain('350k')
    w.setTokens(40_000)
    expect(reminded(await $.tool.call({ tool: 'Bash', command: 'ls' }))).toBe('')
    w.setTokens(310_000)
    expect(reminded(await $.tool.call({ tool: 'Bash', command: 'ls' }))).toContain('310k')
  })

  test('a subagent’s tool calls carry none', async ($, on) => {
    world(on, 350_000)
    expect(reminded(await $.tool.call({ tool: 'Bash', command: 'ls', agentId: 'agent-1' }))).toBe('')
  })

  test('none when compacting is off or the tool would refuse at this size', async ($, on) => {
    world(on, 350_000, { DISABLE_COMPACT: '1' })
    expect(reminded(await $.prompt.submit(prompt()))).toBe('')
  })

  test('an idle-compaction size above 300k raises the reminder with it', async ($, on) => {
    const w = world(on, 350_000, { CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS: '400000' })
    expect(reminded(await $.prompt.submit(prompt()))).toBe('')
    w.setTokens(410_000)
    expect(reminded(await $.prompt.submit(prompt()))).toContain('past 400k')
  })
})

test('registers the tool in the prompt with the threshold in its description', async ($, on) => {
  const w = world(on, 0)
  await $.session.start({ cwd: '/tmp', surface: null, isInteractive: false })
  expect(w.registered.map(r => r.name)).toEqual(['compact_context'])
  expect(w.registered[0]?.description ?? '').toContain('more than 200k tokens')
  expect(w.registered[0]?.description ?? '').toContain('/goal')
})
