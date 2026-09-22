/** The @token immediately before the caret, if the user is composing one. */
export function documentMentionAt(
  value: string,
  cursor: number,
): { start: number; end: number; query: string } | null {
  const before = value.slice(0, cursor)
  const match = before.match(/(?:^|\s)@([^@\n]{0,100})$/)
  if (!match || match.index === undefined) return null
  const leading = match[0].startsWith('@') ? 0 : 1
  return {
    start: match.index + leading,
    end: cursor,
    query: (match[1] ?? '').trimStart(),
  }
}
