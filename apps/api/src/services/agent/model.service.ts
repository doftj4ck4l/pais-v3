import {
  MODELS,
  getModel,
  isLikelyConfigured,
  syntheticGatewayModel,
  type ModelConfig,
} from "../../catalog/llm-models";
import { HARNESSES, getHarness, type Harness } from "../../catalog/harnesses";
import { maybeRefreshServedModels, servedModels } from "./gateway-models";

/** Shape returned by GET /api/meta — the catalog the UI renders. */
export type MetaPayload = {
  harnesses: Harness[];
  models: {
    id: string;
    label: string;
    provider: string;
    hint: string;
    brand: string;
    mode: "agent" | "chat-only";
    ready: boolean;
    /** Usable context window, so the console can meter a thread against it. */
    contextWindow: number;
    /**
     * Present when the model always reasons and its effort is adjustable. The
     * console shows an effort control only for models that carry this; a plain
     * chat model omits it entirely.
     */
    thinking?: { levels: string[]; default: string };
  }[];
};

export function getMeta(): MetaPayload {
  return { harnesses: HARNESSES, models: metaModels() };
}

function toMetaModel(model: ModelConfig, ready: boolean, contextWindow?: number): MetaPayload["models"][number] {
  return {
    id: model.id,
    label: model.label,
    provider: model.provider,
    hint: model.hint,
    brand: model.brand,
    mode: model.mode ?? "agent",
    ready,
    contextWindow: contextWindow ?? model.contextWindow,
    // Only the levels and default reach the UI; the sampling recipe stays server-side.
    ...(model.thinking
      ? { thinking: { levels: model.thinking.levels, default: model.thinking.default } }
      : {}),
  };
}

/**
 * The model list the picker renders.
 *
 * Without `CUSTOM_MODEL` this is a multi-model deployment (the shared office
 * gateway) and the full static catalog is correct — unchanged behaviour.
 *
 * With `CUSTOM_MODEL` set the box serves one gateway, so the picker follows it:
 * show only what `GET /v1/models` reports, and nothing else — no greyed-out
 * models this machine never had, and no hardcoded LAN endpoints that would read
 * as ready while answering nothing. Until the first discovery lands (or if the
 * gateway never answers) the configured model alone stands in, which is exactly
 * the single-model case anyway.
 */
function metaModels(): MetaPayload["models"] {
  const configured = process.env.CUSTOM_MODEL?.trim();
  if (!configured) {
    return MODELS.map((m) => toMetaModel(m, isLikelyConfigured(m)));
  }

  maybeRefreshServedModels();
  const served = servedModels();
  const names = served ? [...served.keys()] : [configured];

  const entries: Array<{ model: ModelConfig; contextWindow?: number }> = [];
  for (const name of names) {
    const known = MODELS.find(
      (m) => m.provider === "custom" && m.apiKeyEnv === "CUSTOM_API_KEY" && m.model === name,
    );
    if (known) entries.push({ model: known, contextWindow: served?.get(name) });
    else if (name === configured) {
      entries.push({ model: syntheticGatewayModel(configured, served?.get(name)), contextWindow: served?.get(name) });
    }
    // A served model that is neither in the catalog nor the configured one has
    // no resolvable config, so it is left out rather than offered and failing.
  }
  if (!entries.length) entries.push({ model: syntheticGatewayModel(configured) });

  // Everything here is served by this machine, so it is ready by definition.
  return entries.map(({ model, contextWindow }) => toMetaModel(model, true, contextWindow));
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
