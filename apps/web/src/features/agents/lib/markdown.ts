import { marked } from 'marked'
import DOMPurify from 'dompurify'

import { normalizeGeneratedImageUrls } from './generated-image-url'

marked.setOptions({ gfm: true, breaks: true })

export function renderMarkdown(text: string): string {
  return DOMPurify.sanitize(marked.parse(normalizeGeneratedImageUrls(text)) as string)
}
