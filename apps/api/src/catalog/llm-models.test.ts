import { afterEach, describe, expect, test } from 'bun:test'
import { getModel, MODELS, reasoningPayloadForModel } from './llm-models'
import { getMeta, resolveRun } from '../services/agent/model.service'
import { __setServedModelsForTest } from '../services/agent/gateway-models'

describe('shared gateway catalog', () => {
  test('advertises only the two Pixel model tiers', () => {
    const previousKey = process.env.CUSTOM_API_KEY
    const previousModel = process.env.CUSTOM_MODEL
    process.env.CUSTOM_API_KEY = 'test-key'
    delete process.env.CUSTOM_MODEL

    try {
      expect(MODELS.map((model) => ({
        id: model.id,
        label: model.label,
        upstream: model.model,
        brand: model.brand,
      }))).toEqual([
        {
          id: 'pixel-simple-1',
          label: 'pixel-simple-1',
          upstream: 'ds4-flash',
          brand: 'pixelspace',
        },
        {
          id: 'pixel-pro-1',
          label: 'pixel-pro-1',
          upstream: 'ds4-flash',
          brand: 'pixelspace',
        },
      ])
      expect(getMeta().models.map((model) => model.id)).toEqual([
        'pixel-simple-1',
        'pixel-pro-1',
      ])
    } finally {
      if (previousKey === undefined) delete process.env.CUSTOM_API_KEY
      else process.env.CUSTOM_API_KEY = previousKey
      if (previousModel === undefined) delete process.env.CUSTOM_MODEL
      else process.env.CUSTOM_MODEL = previousModel
    }
  })

  test('keeps Simple non-thinking and fixes Pro at high without an effort picker', () => {
    const previousModel = process.env.CUSTOM_MODEL
    delete process.env.CUSTOM_MODEL

    try {
      expect(getModel('pixel-simple-1')).toMatchObject({
        model: 'ds4-flash',
        reasoningEffort: 'none',
      })
      expect(getModel('pixel-simple-1')?.thinking).toBeUndefined()
      expect(getModel('pixel-pro-1')?.thinking).toMatchObject({
        levels: ['high'],
        default: 'high',
        request: {},
      })
      expect(getModel('pixel-pro-1')?.model).toBe('ds4-flash')
      expect(reasoningPayloadForModel(getModel('pixel-simple-1')!)).toEqual({
        reasoning_effort: 'none',
      })
      expect(reasoningPayloadForModel(getModel('pixel-pro-1')!, 'low')).toEqual({
        reasoning_effort: 'high',
      })
      expect(getMeta().models.find((model) => model.id === 'pixel-simple-1')?.thinking).toBeUndefined()
      expect(getMeta().models.find((model) => model.id === 'pixel-pro-1')?.thinking).toBeUndefined()
    } finally {
      if (previousModel === undefined) delete process.env.CUSTOM_MODEL
      else process.env.CUSTOM_MODEL = previousModel
    }
  })

  test('keeps previously advertised vendor ids resolvable but out of the picker', () => {
    const hiddenIds = [
      'gw-qwen3.8-27b',
      'gw-qwen3.8-flash',
      'local-qwen3-4b-uncensored',
      'gw-ds4-flash',
      'gw-vrs_smart',
      'gw-gemini-3.1-flash-image',
    ]
    const previousModel = process.env.CUSTOM_MODEL
    delete process.env.CUSTOM_MODEL

    try {
      expect(MODELS.map((model) => model.id)).toEqual(['pixel-simple-1', 'pixel-pro-1'])
      for (const id of hiddenIds) expect(getModel(id)).toBeDefined()
      expect(getModel('local-qwen3-4b-uncensored')).toMatchObject({
        label: 'qwen3-4b-uncensored',
        model: 'qwen3-4b-uncensored',
        baseUrl: 'http://10.0.151.8:8002/v1',
        contextWindow: 8_192,
      })
      expect(getModel('gw-gemini-3.1-flash-image')).toMatchObject({
        mode: 'chat-only',
      })
    } finally {
      if (previousModel === undefined) delete process.env.CUSTOM_MODEL
      else process.env.CUSTOM_MODEL = previousModel
    }
  })

  test('keeps non-chat router endpoints out of the model picker', () => {
    const advertised = MODELS.map((model) => model.model)

    expect(advertised).not.toContain('qwen3-tts')
    expect(advertised).not.toContain('qwen3-vl-embedding-8b')
    expect(advertised).not.toContain('whisper-large-v3-turbo')
    expect(advertised).not.toContain('z-image-turbo')
  })

  test('routes older retired ids to Pixel Pro without listing them', () => {
    const previousKey = process.env.CUSTOM_API_KEY
    const previousModel = process.env.CUSTOM_MODEL
    const retiredIds = [
      'local-qwen3.8-27b-uncensored',
      'gw-qwen3.5-397b-instruct',
      'gw-qwen3.6-35b-instruct',
      'gw-qwen3.6-35b',
      'gw-ds4-flash-1m',
      'gw-muse-glimmer-30b',
      'gw-nemotron-3.5-lightning',
    ]

    process.env.CUSTOM_API_KEY = 'test-key'
    delete process.env.CUSTOM_MODEL
    try {
      for (const retiredId of retiredIds) {
        expect(MODELS.map((model) => model.id)).not.toContain(retiredId)
        expect(getModel(retiredId)?.model).toBe('ds4-flash')
        expect(resolveRun({ modelId: retiredId }).ok).toBe(true)
      }
      expect(getModel('gw-qwen3.6-35b')?.id).toBe('pixel-pro-1')
      expect(getModel('local-qwen3.8-27b-uncensored')).toMatchObject({
        id: 'local-qwen3.8-27b-uncensored',
        mode: 'chat-only',
      })
    } finally {
      if (previousKey === undefined) delete process.env.CUSTOM_API_KEY
      else process.env.CUSTOM_API_KEY = previousKey
      if (previousModel === undefined) delete process.env.CUSTOM_MODEL
      else process.env.CUSTOM_MODEL = previousModel
    }
  })

  test('routes retired ids to the configured on-prem model', () => {
    const previousKey = process.env.CUSTOM_API_KEY
    const previousModel = process.env.CUSTOM_MODEL
    process.env.CUSTOM_API_KEY = 'local-no-auth'
    process.env.CUSTOM_MODEL = 'nemotron-3.5-lightning'

    try {
      expect(getModel('gw-qwen3.6-35b')).toMatchObject({
        id: 'gw-nemotron-3.5-lightning',
        model: 'nemotron-3.5-lightning',
      })
      expect(getModel('local-qwen3.8-27b-uncensored')).toMatchObject({
        id: 'local-qwen3.8-27b-uncensored',
        model: 'nemotron-3.5-lightning',
        mode: 'chat-only',
      })
      expect(resolveRun({ modelId: 'gw-qwen3.6-35b' }).ok).toBe(true)
      expect(resolveRun({ modelId: 'local-qwen3.8-27b-uncensored' }).ok).toBe(true)
    } finally {
      if (previousKey === undefined) delete process.env.CUSTOM_API_KEY
      else process.env.CUSTOM_API_KEY = previousKey
      if (previousModel === undefined) delete process.env.CUSTOM_MODEL
      else process.env.CUSTOM_MODEL = previousModel
    }
  })
})

describe('on-prem gateway discovery', () => {
  const savedKey = process.env.CUSTOM_API_KEY
  const savedModel = process.env.CUSTOM_MODEL

  afterEach(() => {
    __setServedModelsForTest(null)
    if (savedKey === undefined) delete process.env.CUSTOM_API_KEY
    else process.env.CUSTOM_API_KEY = savedKey
    if (savedModel === undefined) delete process.env.CUSTOM_MODEL
    else process.env.CUSTOM_MODEL = savedModel
  })

  test('shows only the models the machine actually serves', () => {
    process.env.CUSTOM_API_KEY = 'local-no-auth'
    process.env.CUSTOM_MODEL = 'nemotron-3.5-lightning'
    // The gateway reports a single served model with its true window.
    __setServedModelsForTest(new Map([['nemotron-3.5-lightning', 131_072]]))

    const ids = getMeta().models.map((m) => m.id)
    expect(ids).toEqual(['gw-nemotron-3.5-lightning'])
    const only = getMeta().models[0]
    expect(only.ready).toBe(true)
    expect(only.contextWindow).toBe(131_072)
    // No phantom gateway models and no unreachable hardcoded LAN endpoint.
    expect(ids).not.toContain('gw-ds4-flash')
    expect(ids).not.toContain('local-qwen3.8-27b-uncensored')
  })

  test('falls back to the configured model before discovery answers', () => {
    process.env.CUSTOM_API_KEY = 'local-no-auth'
    process.env.CUSTOM_MODEL = 'some-brand-new-model'
    __setServedModelsForTest(null)

    const ids = getMeta().models.map((m) => m.id)
    expect(ids).toEqual(['gw-some-brand-new-model'])
    // A synthesised model still resolves for a run.
    expect(resolveRun({ modelId: 'gw-some-brand-new-model' }).ok).toBe(true)
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
