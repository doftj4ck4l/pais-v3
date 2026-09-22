import { describe, expect, it } from 'bun:test'
import {
  historyFrom,
  withDocumentReferenceNote,
  withoutAttachmentNote,
} from '../src/features/agents/lib/attachment-notes'

describe('Chat document reference notes', () => {
  it('keeps source ids in follow-up history while hiding them from the transcript', () => {
    const text = withDocumentReferenceNote('Summarise @Proposal.pdf', ['doc-1', 'doc-1'])

    expect(withoutAttachmentNote(text)).toBe('Summarise @Proposal.pdf')
    expect(historyFrom([{ kind: 'user', text }])).toEqual([{ role: 'user', content: text }])
    expect(text).toContain('["doc-1"]')
  })

  it('caps source references to the API limit', () => {
    const text = withDocumentReferenceNote(
      'Compare these',
      Array.from({ length: 8 }, (_, index) => `doc-${index}`),
    )

    expect(text).toContain('["doc-0","doc-1","doc-2","doc-3","doc-4","doc-5"]')
    expect(text).not.toContain('doc-6')
  })
})
