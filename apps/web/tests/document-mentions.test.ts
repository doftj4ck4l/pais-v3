import { describe, expect, it } from 'bun:test'
import { documentMentionAt } from '../src/features/agents/lib/document-mentions'

describe('document mentions', () => {
  it('finds a filename query at the caret and leaves surrounding text alone', () => {
    expect(documentMentionAt('Compare @command centre', 23)).toEqual({
      start: 8,
      end: 23,
      query: 'command centre',
    })
  })

  it('does not cross a newline or an earlier mention', () => {
    expect(documentMentionAt('Use @first\nand @second', 22)).toEqual({
      start: 15,
      end: 22,
      query: 'second',
    })
    expect(documentMentionAt('email@example.com', 17)).toBeNull()
  })
})
