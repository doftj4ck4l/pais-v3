import { describe, expect, test } from 'bun:test'
import { getModel, isLikelyConfigured } from './llm-models'
import { getMeta, resolveRun } from '../services/agent/model.service'

describe('local Qwen 3.8 uncensored model', () => {
  test('uses the measured endpoint capabilities in the model picker', () => {
    const model = getModel('local-qwen3.8-27b-uncensored')

    expect(model).toBeDefined()
    expect(model?.model).toBe('qwen3.8-27b-uncensored')
    expect(model?.baseUrl).toBe('http://10.0.151.4:9504/v1')
    expect(model?.contextWindow).toBe(8_192)
    expect(model?.mode).toBe('chat-only')
    expect(model?.thinking).toMatchObject({
      levels: ['low', 'medium', 'xhigh'],
      default: 'xhigh',
    })
    expect(model?.thinking?.levels).not.toContain('high')
    expect(model && isLikelyConfigured(model)).toBe(true)
  })

  test('advertises its chat-only mode to clients', () => {
    const model = getMeta().models.find((entry) => entry.id === 'local-qwen3.8-27b-uncensored')

    expect(model?.mode).toBe('chat-only')
  })
})

describe('configured custom gateway model', () => {
  test('advertises and resolves only the configured shared-gateway model', () => {
    const previousKey = process.env.CUSTOM_API_KEY
    const previousModel = process.env.CUSTOM_MODEL
    process.env.CUSTOM_API_KEY = 'local-no-auth'
    process.env.CUSTOM_MODEL = 'nemotron-3.5-lightning'

    try {
      const gatewayModels = getMeta().models.filter((model) => model.id.startsWith('gw-'))
      expect(
        gatewayModels.find((model) => model.id === 'gw-nemotron-3.5-lightning')?.ready,
      ).toBe(true)
      expect(
        gatewayModels
          .filter((model) => model.id !== 'gw-nemotron-3.5-lightning')
          .every((model) => !model.ready),
      ).toBe(true)
      expect(resolveRun({ modelId: 'gw-nemotron-3.5-lightning' }).ok).toBe(true)
      expect(resolveRun({ modelId: 'gw-qwen3.8-27b' }).ok).toBe(false)
    } finally {
      if (previousKey === undefined) delete process.env.CUSTOM_API_KEY
      else process.env.CUSTOM_API_KEY = previousKey
      if (previousModel === undefined) delete process.env.CUSTOM_MODEL
      else process.env.CUSTOM_MODEL = previousModel
    }
  })
})
