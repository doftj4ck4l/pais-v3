import { describe, expect, it } from 'bun:test'
import { liveRunStatus, toolStatus } from '../src/features/agents/lib/live-run-status'
import type { Item } from '../src/shared/lib/types'

const pendingTool = (name: string, id = name): Extract<Item, { kind: 'tool' }> => ({
  kind: 'tool',
  id,
  name,
  args: '{}',
})

describe('liveRunStatus', () => {
  it('starts with connection, then follows the actual model stream', () => {
    expect(liveRunStatus([{ kind: 'user', text: 'Help' }])).toBe('runConnecting')
    expect(liveRunStatus([
      { kind: 'user', text: 'Help' },
      { kind: 'iteration', n: 1 },
    ])).toBe('runThinking')
    expect(liveRunStatus([
      { kind: 'user', text: 'Help' },
      { kind: 'assistant', text: 'Here is' },
    ])).toBe('runAnswering')
  })

  it('shows an active tool and returns to thinking after its result', () => {
    const items: Item[] = [
      { kind: 'iteration', n: 1 },
      pendingTool('search_docs'),
    ]
    expect(liveRunStatus(items)).toBe('runSearchingDocs')

    items[1] = { ...items[1], result: 'Found it', ok: true }
    expect(liveRunStatus(items)).toBe('runThinking')
  })

  it('does not fall back to text emitted before a completed tool', () => {
    expect(liveRunStatus([
      { kind: 'assistant', text: 'I will check.' },
      { ...pendingTool('bash'), result: 'Done' },
    ])).toBe('runThinking')
  })

  it('keeps reporting another parallel tool when the newest one completes', () => {
    expect(liveRunStatus([
      { kind: 'iteration', n: 1 },
      pendingTool('bash', 'one'),
      { ...pendingTool('search_docs', 'two'), result: 'Done' },
    ])).toBe('runRunningCommand')
  })

  it('prioritizes a question waiting for the user', () => {
    expect(liveRunStatus([pendingTool('bash')], true)).toBe('runWaiting')
  })
})

describe('toolStatus', () => {
  it('keeps common tool activity short and specific', () => {
    expect(toolStatus('web_search')).toBe('runSearchingWeb')
    expect(toolStatus('generate_image')).toBe('runCreating')
    expect(toolStatus('run_query')).toBe('runCheckingData')
    expect(toolStatus('nextcloud__nc_calendar_list_events')).toBe('runCheckingCalendar')
    expect(toolStatus('nextcloud__nc_mail_list_accounts')).toBe('runUsingConnector')
  })
})
