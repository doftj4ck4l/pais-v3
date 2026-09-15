import { afterEach, describe, expect, test } from 'bun:test'
import { getModel, MODELS } from './llm-models'
import { getMeta, resolveRun } from '../services/agent/model.service'
import { __setServedModelsForTest } from '../services/agent/gateway-models'

describe('shared gateway catalog', () => {
  test('lists only deployments verified healthy on the gateway', () => {
    expect(MODELS.map((model) => model.model)).toEqual([
      'qwen3.8-27b',
      'qwen3.8-flash',
      'qwen3-4b-uncensored',
      'ds4-flash',
      'vrs_smart',
      'gemini-3.1-flash-image',
    ])
  })

  test('offers the directly served uncensored model as an agent model', () => {
    const previousModel = process.env.CUSTOM_MODEL
    delete process.env.CUSTOM_MODEL

    try {
      const model = getModel('local-qwen3-4b-uncensored')
      expect(model).toMatchObject({
        label: 'qwen3-4b-uncensored',
        model: 'qwen3-4b-uncensored',
        baseUrl: 'http://10.0.151.8:8002/v1',
        contextWindow: 8_192,
      })
      expect(resolveRun({ modelId: 'local-qwen3-4b-uncensored' }).ok).toBe(true)

      const dropdown = getMeta().models
      expect(dropdown.find((entry) => entry.id === 'local-qwen3-4b-uncensored')).toMatchObject({
        label: 'qwen3-4b-uncensored',
        mode: 'agent',
        ready: true,
        contextWindow: 8_192,
      })
      expect(dropdown.map((entry) => entry.id)).not.toContain('gw-glm-5.3-flash')
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

  test('marks the Gemini image model chat-only because it does not support tools', () => {
    expect(MODELS.find((model) => model.model === 'gemini-3.1-flash-image')).toMatchObject({
      id: 'gw-gemini-3.1-flash-image',
      mode: 'chat-only',
    })
  })

  test('routes persisted retired ids to Qwen without listing them', () => {
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
        expect(getModel(retiredId)?.model).toBe('qwen3.8-27b')
        expect(resolveRun({ modelId: retiredId }).ok).toBe(true)
      }
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
