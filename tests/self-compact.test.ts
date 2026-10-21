import type { On, TurnCompleteInput } from 'claude-code'
import { describe, expect, mock, test, type Engine } from 'claude-code/testing'

import { isBusy } from '../hooks/register'

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
    await w.clock.settle()
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
    await w.clock.settle()
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
    await w.clock.settle()
    expect(w.compactions).toEqual([])
    await $.turn.complete(turnEnd())
    await w.clock.settle()
    expect(w.compactions).toEqual([undefined])
  })

  test('skips when the context already shrank before the turn ended', async ($, on) => {
    const w = world(on, 450_000)
    await $.tool.call({ tool: TOOL })
    w.setTokens(30_000) // auto-compaction ran meanwhile
    await $.turn.complete(turnEnd())
    await w.clock.settle()
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
    await clock.settle()
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
    await w.clock.settle()
    expect(w.compactions).toEqual(['keep the plan'])
    expect(w.submitted.length).toBe(1)
    expect(w.submitted[0]?.after).toBe(1)
    expect(w.submitted[0]?.text).toContain('run the full suite, then commit')

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

  test('without next the person speaks next, and the tool says so', async ($, on) => {
    const w = world(on, 450_000)
    const ran = await $.tool.call({ tool: TOOL })
    expect(said(ran)).toContain('pass next')
    await $.turn.complete(turnEnd())
    await w.clock.settle()
    expect(w.compactions).toEqual([undefined])
    expect(w.submitted).toEqual([])
  })

  test('carries on when auto-compaction got there first', async ($, on) => {
    const w = world(on, 450_000)
    await $.tool.call({ tool: TOOL, next: 'step 3' })
    w.setTokens(30_000)
    await $.turn.complete(turnEnd())
    await w.clock.settle()
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

  // Each try costs a model call: after a skip or a failure the person decides.
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
    await clock.settle()
    expect(submitted).toEqual([])
  }
  test('a skipped compaction does not carry on', settles('skip'))
  test('a failed compaction does not carry on', settles('fail'))
})

describe('reminder past 400k', () => {
  test('a prompt past 400k reminds Claude to look for a breakpoint; at 400k none', async ($, on) => {
    const w = world(on, 400_000)
    expect(reminded(await $.prompt.submit(prompt()))).toBe('')

    w.setTokens(450_000)
    const text = reminded(await $.prompt.submit(prompt()))
    expect(text).toContain('450k tokens')
    expect(text).toContain(TOOL)
    expect(text).toContain('good breakpoint')
    expect(text).toContain('not an order')
  })

  test('not on every prompt: again only once the context grew another 100k', async ($, on) => {
    const w = world(on, 450_000)
    expect(reminded(await $.prompt.submit(prompt()))).toContain('450k tokens')
    expect(reminded(await $.prompt.submit(prompt()))).toBe('')
    w.setTokens(549_000)
    expect(reminded(await $.prompt.submit(prompt()))).toBe('')
    w.setTokens(550_000)
    expect(reminded(await $.prompt.submit(prompt()))).toContain('550k tokens')
  })

  test('the prompt as typed is kept, and context already attached stays first', async ($, on) => {
    world(on, 450_000)
    const entered = await $.prompt.submit({ ...prompt('fix it'), context: ['from another hook'] })
    expect(entered.text).toBe('fix it')
    expect(entered.context?.[0]).toBe('from another hook')
    expect(entered.context?.length).toBe(2)
  })

  test('none while a compaction is queued, and none on /compact', async ($, on) => {
    world(on, 450_000)
    expect(reminded(await $.prompt.submit(prompt('/compact', { name: 'compact', args: '' })))).toBe('')
    await $.tool.call({ tool: TOOL })
    expect(reminded(await $.prompt.submit(prompt()))).toBe('')
    expect(reminded(await $.tool.call({ tool: 'Bash', command: 'ls' }))).toBe('')
  })

  test('inside a turn: on crossing 400k, then again only every 100k more', async ($, on) => {
    const w = world(on, 350_000)
    const step = async (tokens: number) => {
      w.setTokens(tokens)
      return reminded(await $.tool.call({ tool: 'Bash', command: 'ls' }))
    }
    expect(await step(350_000)).toBe('')
    expect(await step(420_000)).toContain('420k tokens')
    expect(await step(480_000)).toBe('')
    expect(await step(519_000)).toBe('')
    expect(await step(520_000)).toContain('520k tokens')
  })

  test('prompts and tool calls share one count', async ($, on) => {
    const w = world(on, 450_000)
    expect(reminded(await $.prompt.submit(prompt()))).toContain('450k')
    w.setTokens(500_000)
    expect(reminded(await $.tool.call({ tool: 'Read', file_path: '/tmp/x' }))).toBe('')
    w.setTokens(560_000)
    expect(reminded(await $.tool.call({ tool: 'Read', file_path: '/tmp/x' }))).toContain('560k')
    w.setTokens(600_000)
    expect(reminded(await $.prompt.submit(prompt()))).toBe('')
  })

  test('after a compaction the next crossing reminds again', async ($, on) => {
    const w = world(on, 450_000)
    expect(reminded(await $.tool.call({ tool: 'Bash', command: 'ls' }))).toContain('450k')
    w.setTokens(40_000)
    expect(reminded(await $.tool.call({ tool: 'Bash', command: 'ls' }))).toBe('')
    w.setTokens(410_000)
    expect(reminded(await $.tool.call({ tool: 'Bash', command: 'ls' }))).toContain('410k')
  })

  test('a subagent’s tool calls carry none', async ($, on) => {
    world(on, 450_000)
    expect(reminded(await $.tool.call({ tool: 'Bash', command: 'ls', agentId: 'agent-1' }))).toBe('')
  })

  test('none when compacting is off or the tool would refuse at this size', async ($, on) => {
    world(on, 450_000, { DISABLE_COMPACT: '1' })
    expect(reminded(await $.prompt.submit(prompt()))).toBe('')
  })

  test('an idle-compaction size above 400k raises the reminder with it', async ($, on) => {
    const w = world(on, 450_000, { CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS: '500000' })
    expect(reminded(await $.prompt.submit(prompt()))).toBe('')
    w.setTokens(510_000)
    expect(reminded(await $.prompt.submit(prompt()))).toContain('past 500k')
  })
})

test('registers the tool in the prompt with the threshold in its description', async ($, on) => {
  const w = world(on, 0)
  await $.session.start({ cwd: '/tmp', surface: null, isInteractive: false })
  expect(w.registered.map(r => r.name)).toEqual(['compact_context'])
  expect(w.registered[0]?.description ?? '').toContain('more than 200k tokens')
})
