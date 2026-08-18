import { describe, expect, it } from 'bun:test'

import { normalizeGeneratedImageUrls } from '../src/features/agents/lib/generated-image-url'

describe('normalizeGeneratedImageUrls', () => {
  it('repairs the malformed absolute URL emitted by Nemotron', () => {
    const markdown =
      '![Malaysia Airport Monthly Passenger Count 2024](https://api.images/5116c76f-1313-40af-9f49-23f9b72a2088)'

    expect(normalizeGeneratedImageUrls(markdown)).toBe(
      '![Malaysia Airport Monthly Passenger Count 2024](/api/images/5116c76f-1313-40af-9f49-23f9b72a2088)',
    )
  })

  it('also repairs the HTTP variant', () => {
    const markdown =
      '![chart](http://api.images/5116c76f-1313-40af-9f49-23f9b72a2088)'

    expect(normalizeGeneratedImageUrls(markdown)).toBe(
      '![chart](/api/images/5116c76f-1313-40af-9f49-23f9b72a2088)',
    )
  })

  it('preserves correct generated-image and external URLs', () => {
    const markdown = [
      '![generated](/api/images/5116c76f-1313-40af-9f49-23f9b72a2088)',
      '![external](https://cdn.example.com/api/images/5116c76f-1313-40af-9f49-23f9b72a2088)',
    ].join('\n')

    expect(normalizeGeneratedImageUrls(markdown)).toBe(markdown)
  })

  it('does not rewrite an arbitrary path on the malformed host', () => {
    const markdown = '![external](https://api.images/not-a-generated-image-id)'

    expect(normalizeGeneratedImageUrls(markdown)).toBe(markdown)
  })
})
