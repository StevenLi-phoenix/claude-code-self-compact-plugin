import type { On, TurnCompleteInput } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'

import { isBusy } from '../hooks/register'

const TOOL = 'mcp__self-compact__compact_context'
const SUMMARY = [{ role: 'user' as const, text: 'summary', toolUses: [] }]

type World = {
  clock: ReturnType<typeof mock.clock>
  compactions: (string | undefined)[]
  registered: { name: string; description: string }[]
  setTokens: (n: number | undefined) => void
}

// Everything beneath the plugin: env, clock, context usage, compaction, UI sinks.
function world(on: On, tokens: number | undefined, env: Record<string, string> = {}): World {
  mock.env(on, env)
  const clock = mock.clock(on)
  let current = tokens
  const compactions: (string | undefined)[] = []
  const registered: { name: string; description: string }[] = []

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
  on('ui.log', () => ({ value: undefined }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))

  return { clock, compactions, registered, setTokens: n => (current = n) }
}

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

test('registers the tool in the prompt with the threshold in its description', async ($, on) => {
  const w = world(on, 0)
  await $.session.start({ cwd: '/tmp', surface: null, isInteractive: false })
  expect(w.registered.map(r => r.name)).toEqual(['compact_context'])
  expect(w.registered[0]?.description ?? '').toContain('more than 200k tokens')
})
