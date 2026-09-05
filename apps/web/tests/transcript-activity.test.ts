import { describe, expect, it } from 'bun:test'
import { groupTranscriptItems, visibleTranscriptItems } from '../src/features/agents/lib/transcript'
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

describe('visibleTranscriptItems', () => {
  const items: Item[] = [
    { kind: 'user', text: 'Please investigate' },
    tool('one', 10),
    { kind: 'assistant', text: 'Finished' },
  ]

  it('keeps tool calls hidden by default', () => {
    expect(visibleTranscriptItems(items, false).map((item) => item.kind)).toEqual([
      'user',
      'assistant',
    ])
  })

  it('restores grouped tool calls when the preference is enabled', () => {
    expect(visibleTranscriptItems(items, true).map((item) => item.kind)).toEqual([
      'user',
      'tool-group',
      'assistant',
    ])
  })
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
