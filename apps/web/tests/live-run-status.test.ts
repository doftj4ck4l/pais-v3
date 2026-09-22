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
    expect(liveRunStatus([{ kind: 'user', text: 'Help' }])).toEqual({ key: 'runConnecting' })
    expect(liveRunStatus([
      { kind: 'user', text: 'Help' },
      { kind: 'iteration', n: 1 },
    ])).toEqual({ key: 'runThinking' })
    expect(liveRunStatus([
      { kind: 'user', text: 'Help' },
      { kind: 'assistant', text: 'Here is' },
    ])).toEqual({ key: 'runAnswering' })
  })

  it('shows an active tool and returns to thinking after its result', () => {
    const items: Item[] = [
      { kind: 'iteration', n: 1 },
      pendingTool('search_docs'),
    ]
    expect(liveRunStatus(items)).toEqual({ key: 'runSearchingDocs' })

    items[1] = { ...items[1], result: 'Found it', ok: true }
    expect(liveRunStatus(items)).toEqual({ key: 'runThinking' })
  })

  it('does not fall back to text emitted before a completed tool', () => {
    expect(liveRunStatus([
      { kind: 'assistant', text: 'I will check.' },
      { ...pendingTool('bash'), result: 'Done' },
    ])).toEqual({ key: 'runThinking' })
  })

  it('keeps reporting another parallel tool when the newest one completes', () => {
    expect(liveRunStatus([
      { kind: 'iteration', n: 1 },
      pendingTool('bash', 'one'),
      { ...pendingTool('search_docs', 'two'), result: 'Done' },
    ])).toEqual({ key: 'runRunningCommand' })
  })

  it('prioritizes a question waiting for the user', () => {
    expect(liveRunStatus([pendingTool('bash')], true)).toEqual({ key: 'runWaiting' })
  })
})

describe('toolStatus', () => {
  it('keeps common tool activity short and specific', () => {
    expect(toolStatus('web_search')).toEqual({ key: 'runSearchingWeb' })
    expect(toolStatus('export_document')).toEqual({ key: 'runCreating' })
    expect(toolStatus('generate_image')).toEqual({ key: 'runCreating' })
    expect(toolStatus('run_query')).toEqual({ key: 'runCheckingData' })
    expect(toolStatus('nextcloud__nc_calendar_list_events')).toEqual({ key: 'runCheckingCalendar' })
  })

  it('names the file a read or write is about, not just the verb', () => {
    // "Reading" alone says nothing the user did not already know; the file is the
    // part they can act on. The path arrives as the tool call's own arguments.
    expect(toolStatus('read', '{"path":"/workspace/reports/Q3-report.docx"}')).toEqual({
      key: 'runReadingName',
      values: { name: 'Q3-report.docx' },
    })
    expect(toolStatus('write', '{"path":"/workspace/summary.txt","content":"x"}')).toEqual({
      key: 'runWritingName',
      values: { name: 'summary.txt' },
    })
    expect(toolStatus('share_file', '{"path":"/workspace/chart.png"}')).toEqual({
      key: 'runSharingName',
      values: { name: 'chart.png' },
    })
  })

  it('names the query a search is running, and the host being fetched', () => {
    expect(toolStatus('search_docs', '{"query":"revenue recognition policy"}')).toEqual({
      key: 'runSearchingDocsFor',
      values: { name: 'revenue recognition policy' },
    })
    expect(toolStatus('web_search', '{"query":"Bursa Malaysia filings"}')).toEqual({
      key: 'runSearchingWebFor',
      values: { name: 'Bursa Malaysia filings' },
    })
    expect(toolStatus('fetch_url', '{"url":"https://www.bursamalaysia.com/market"}')).toEqual({
      key: 'runReadingName',
      values: { name: 'www.bursamalaysia.com' },
    })
  })

  it('names what an MCP tool is doing, and to which service', () => {
    // "Using nextcloud" for 50 seconds says nothing the user could act on.
    expect(toolStatus('nextcloud__nc_webdav_search_files', '{"query":"Azlan Jizam"}')).toEqual({
      key: 'runConnectorSearching',
      values: { server: 'Nextcloud', name: 'Azlan Jizam' },
    })
    expect(
      toolStatus('nextcloud__nc_webdav_read_file', '{"path":"1. VRS/ISOC proposal.docx"}'),
    ).toEqual({
      key: 'runConnectorReading',
      values: { server: 'Nextcloud', name: 'ISOC proposal.docx' },
    })
    expect(toolStatus('nextcloud__nc_webdav_write_file', '{"path":"notes.txt"}')).toEqual({
      key: 'runConnectorWriting',
      values: { server: 'Nextcloud', name: 'notes.txt' },
    })
  })

  it('still names the service when the tool is neither read, search nor write', () => {
    expect(toolStatus('nextcloud__nc_mail_list_accounts')).toEqual({
      key: 'runUsingConnectorName',
      values: { name: 'Nextcloud' },
    })
    expect(toolStatus('nextcloud__nc_webdav_search_files')).toEqual({
      key: 'runConnectorSearchingOnly',
      values: { server: 'Nextcloud' },
    })
  })

  it('falls back to the verb when the arguments say nothing usable', () => {
    // An argument that will not parse is not a reason to invent a subject.
    expect(toolStatus('read', 'not json')).toEqual({ key: 'runReading' })
    expect(toolStatus('read', '{}')).toEqual({ key: 'runReading' })
    expect(toolStatus('write', '{"path":"   "}')).toEqual({ key: 'runWriting' })
    expect(toolStatus('search_docs')).toEqual({ key: 'runSearchingDocs' })
  })

  it('keeps one line, and caps a long subject', () => {
    const long = 'a'.repeat(80)
    const status = toolStatus('search_docs', JSON.stringify({ query: long }))
    const name = status.values?.name ?? ''
    expect(name.length).toBeLessThanOrEqual(42)
    expect(name.endsWith('…')).toBe(true)
    expect(toolStatus('search_docs', '{"query":"two\\nlines"}').values?.name).toBe('two lines')
  })
})
