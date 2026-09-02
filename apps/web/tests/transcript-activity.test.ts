import { describe, expect, it } from 'bun:test'
import { groupTranscriptItems } from '../src/features/agents/lib/transcript'
import { summarizeWork } from '../src/features/agents/lib/tool-summary'
import type { Item } from '../src/shared/lib/types'

const tool = (id: string, ms?: number, result = 'done'): Extract<Item, { kind: 'tool' }> => ({
  kind: 'tool',
  id,
  name: 'bash',
  args: '{}',
  result,
  ms,
  ok: true,
})

describe('groupTranscriptItems', () => {
  it('hides consecutive tool calls behind one activity group', () => {
    const grouped = groupTranscriptItems([
      { kind: 'user', text: 'Please investigate' },
      tool('one', 10_000),
      tool('two', 20_000),
      { kind: 'assistant', text: 'Finished' },
    ])

    expect(grouped).toHaveLength(3)
    expect(grouped[1]).toEqual({ kind: 'tool-group', tools: [tool('one', 10_000), tool('two', 20_000)] })
  })

  it('starts a new hidden batch at each agent-loop boundary', () => {
    const grouped = groupTranscriptItems([
      tool('one', 10_000),
      { kind: 'iteration', n: 2 },
      tool('two', 20_000),
    ])

    expect(grouped.map((item) => item.kind)).toEqual(['tool-group', 'tool-group'])
  })

  it('keeps reasoning and rendered UI outside tool groups', () => {
    const renderUi: Extract<Item, { kind: 'tool' }> = {
      ...tool('ui', 50),
      name: 'render_ui',
    }
    const grouped = groupTranscriptItems([
      tool('one', 1_000),
      { kind: 'thinking', text: 'Checking', ms: 2_000 },
      renderUi,
      tool('two', 3_000),
    ])

    expect(grouped.map((item) => item.kind)).toEqual([
      'tool-group',
      'thinking',
      'tool',
      'tool-group',
    ])
  })

  it('drops empty assistant placeholders and invisible iteration rows', () => {
    expect(groupTranscriptItems([
      { kind: 'assistant', text: '  ' },
      { kind: 'iteration', n: 1 },
    ])).toEqual([])
  })
})

describe('summarizeWork', () => {
  it('summarizes the combined wall time in plain language', () => {
    expect(summarizeWork([tool('one', 10_000), tool('two', 30_000)])).toEqual({
      label: 'Worked for 30 seconds',
      pending: false,
    })
    expect(summarizeWork([tool('one', 61_000)]).label).toBe('Worked for 1m 1s')
  })

  it('shows a live label while any call is pending', () => {
    expect(summarizeWork([
      tool('done', 10_000),
      { ...tool('pending'), result: undefined, ms: undefined },
    ])).toEqual({ label: 'Working…', pending: true })
  })

  it('falls back to an action count for old rows without timings', () => {
    expect(summarizeWork([tool('one', undefined)]).label).toBe('Completed 1 action')
    expect(summarizeWork([tool('one', undefined), tool('two', undefined)]).label).toBe(
      'Completed 2 actions',
    )
  })
})
