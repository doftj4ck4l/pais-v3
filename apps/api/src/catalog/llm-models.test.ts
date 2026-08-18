import { describe, expect, test } from 'bun:test'
import { MODELS, isLikelyConfigured } from './llm-models'

describe('local Qwen 3.8 uncensored model', () => {
  test('uses the measured endpoint capabilities in the model picker', () => {
    const model = MODELS.find((entry) => entry.id === 'local-qwen3.8-27b-uncensored')

    expect(model).toBeDefined()
    expect(model?.model).toBe('qwen3.8-27b-uncensored')
    expect(model?.baseUrl).toBe('http://10.0.151.4:9504/v1')
    expect(model?.contextWindow).toBe(8_192)
    expect(model?.thinking).toMatchObject({
      levels: ['low', 'medium', 'xhigh'],
      default: 'xhigh',
    })
    expect(model?.thinking?.levels).not.toContain('high')
    expect(model && isLikelyConfigured(model)).toBe(true)
  })
})
