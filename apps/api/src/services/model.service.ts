import { MODELS, getModel, isLikelyConfigured, type ModelConfig } from "../catalog/llm-models";
import { HARNESSES, getHarness, type Harness } from "../catalog/harnesses";

/** Shape returned by GET /api/meta — the catalog the UI renders. */
export type MetaPayload = {
  harnesses: Harness[];
  models: {
    id: string;
    label: string;
    provider: string;
    hint: string;
    brand: string;
    ready: boolean;
    /** Usable context window, so the console can meter a thread against it. */
    contextWindow: number;
  }[];
};

export function getMeta(): MetaPayload {
  return {
    harnesses: HARNESSES,
    models: MODELS.map((m) => ({
      id: m.id,
      label: m.label,
      provider: m.provider,
      hint: m.hint,
      brand: m.brand,
      ready: isLikelyConfigured(m),
      contextWindow: m.contextWindow,
    })),
  };
}

export type Resolution =
  | { ok: true; harness: Harness; model: ModelConfig }
  | { ok: false; error: string };

/**
 * Resolve the harness + model for a run.
 *
 * There is no mock fallback in the catalog, so an unknown or unconfigured model
 * is a client error rather than something to silently substitute.
 */
export function resolveRun(input: {
  harnessId?: string;
  modelId?: string;
  modelConfig?: { baseUrl?: string; model?: string; apiKey?: string };
}): Resolution {
  const harness = input.harnessId ? getHarness(input.harnessId) : HARNESSES[0];
  if (!harness) {
    return {
      ok: false,
      error: `Unknown harness "${input.harnessId}". Available: ${HARNESSES.map((h) => h.id).join(", ")}`,
    };
  }

  const base = input.modelId ? getModel(input.modelId) : MODELS[0];
  if (!base) {
    return {
      ok: false,
      error: `Unknown model "${input.modelId}". Available: ${MODELS.map((m) => m.id).join(", ")}`,
    };
  }

  // The UI-configured custom model overlays base URL / model / key per request.
  const model: ModelConfig = input.modelConfig
    ? {
        ...base,
        baseUrl: input.modelConfig.baseUrl?.trim() || base.baseUrl,
        model: input.modelConfig.model?.trim() || base.model,
        apiKey: input.modelConfig.apiKey?.trim() || base.apiKey,
      }
    : base;

  if (!isLikelyConfigured(model)) {
    return {
      ok: false,
      error: `${model.label} is not configured — set ${model.apiKeyEnv} in apps/api/.env (and a base URL for custom models).`,
    };
  }

  return { ok: true, harness, model };
}
