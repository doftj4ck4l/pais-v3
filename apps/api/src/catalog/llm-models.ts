/**
 * A model that reasons, with a user-adjustable effort.
 *
 * The gateway wants Qwen's thinking switched on through
 * `chat_template_kwargs.enable_thinking` (a bare top-level `enable_thinking` is
 * ignored — measured), alongside a top-level `reasoning_effort`. pi-ai's
 * completions adapter emits one or the other but never both, so this preset is
 * injected into the request body wholesale via a `before_provider_payload`
 * hook. `sampling` carries the rest of the vendor's thinking recipe (top_p,
 * top_k, penalties) that the adapter otherwise drops.
 */
export type ThinkingConfig = {
  /** Effort levels the user can pick, ordered low → high. */
  levels: string[];
  /** The effort a fresh chat starts at. */
  default: string;
  /** Extra body params merged into every request for this model. */
  sampling: Record<string, unknown>;
};

export type ModelConfig = {
  id: string;
  label: string;
  provider: "openai" | "deepseek" | "custom" | "mock";
  model: string;
  /**
   * `chat-only` models receive text messages only: no tool schemas, tool
   * history, attachments, or agent-specific prompt additions.
   */
  mode?: "agent" | "chat-only";
  /**
   * Present when the model always reasons and exposes an adjustable effort. Its
   * mere presence is what tells the UI to show the effort control and the run to
   * inject the thinking body — a model without it is a plain chat model.
   */
  thinking?: ThinkingConfig;
  /** env var that holds the API key (fallback when `apiKey` is not supplied per-request) */
  apiKeyEnv: string;
  /** OpenAI-compatible base URL */
  baseUrl: string;
  /** short note shown in the UI */
  hint: string;
  /** per-request API key override (used for the UI-configured Custom model) */
  apiKey?: string;
  /** brand slug used to look up a logo under /logos/<brand>.<ext> */
  brand: string;
  /**
   * Usable context window in tokens.
   *
   * Declared here, not discovered: this gateway restricts its virtual keys to
   * `llm_api_routes`, so `/v1/model/info` is forbidden and there is no endpoint
   * that reports a model's window. Wrong values here mean a context meter that
   * lies, so treat these as configuration to correct per deployment.
   */
  contextWindow: number;
};

/** Fallback when a model entry predates the `contextWindow` field. */
export const DEFAULT_CONTEXT_WINDOW = 131_072;

/** The API key actually in effect for a run: per-request override, else env. */
export function effectiveApiKey(model: ModelConfig): string | undefined {
  return model.apiKey || process.env[model.apiKeyEnv];
}

const CUSTOM_BASE = process.env.CUSTOM_BASE_URL ?? "http://60.51.17.97:9999/v1";
const QWEN38_UNCENSORED_BASE =
  process.env.QWEN38_UNCENSORED_BASE_URL?.trim() || "http://10.0.151.4:9504/v1";
// llama.cpp accepts an Authorization header but this LAN deployment does not
// require one. pi's OpenAI adapter still expects a non-empty key, so use an
// inert value unless the endpoint is secured later.
const QWEN38_UNCENSORED_KEY =
  process.env.QWEN38_UNCENSORED_API_KEY?.trim() || "local-no-auth";

/**
 * Which logo a gateway model wears, by id prefix.
 *
 * Prefix rather than exact id, because the gateway names a family and then
 * versions it (`ds4-flash`, `ds4-flash-1m`), and a table of exact ids means a
 * model added upstream silently loses its logo. Anything unmatched falls
 * through to a monogram in the console rather than a broken image.
 */
function brandOf(id: string): string {
  if (id.startsWith("ds4")) return "deepseek";
  if (id.startsWith("qwen")) return "qwen";
  if (id.startsWith("nemotron")) return "nvidia";
  if (id.startsWith("muse")) return "muse";
  if (id.startsWith("vrs")) return "vrs";
  return "";
}

/** Helper: a named chat-completion model served by the local gateway. */
function gw(id: string, hint: string, contextWindow = DEFAULT_CONTEXT_WINDOW): ModelConfig {
  const brand = brandOf(id);
  return {
    id: "gw-" + id,
    label: id,
    provider: "custom",
    model: id,
    apiKeyEnv: "CUSTOM_API_KEY",
    baseUrl: CUSTOM_BASE,
    hint,
    brand,
    contextWindow,
  };
}

const qwenThinking = (levels: string[], defaultLevel: string): ThinkingConfig => ({
  levels,
  default: defaultLevel,
  sampling: {
    temperature: 1,
    top_p: 0.95,
    top_k: 20,
    min_p: 0,
    presence_penalty: 0,
    repetition_penalty: 1,
  },
});

// Only qwen3.5-397b-instruct is measured: it accepted a 200,012-token prompt,
// so 262144 is the nearest plausible window and 131072 would have understated
// it by a third. The rest are the default until someone measures them, except
// ds4-flash-1m, whose window is the whole point of it being a separate model.
//
// This list is checked against `GET /v1/models` on the gateway rather than
// grown by hand. Three entries were dropped once it was: `qwen3.5-397b`,
// `qwen3.6-27b` and `qwen3.6-27b-instruct` all answer
// `403 litellm.PermissionDeniedError: Model is blocked` on our virtual key, and
// a blocked model reads in the console as a model that returned nothing —
// there is no error the run can show. Offering one is worse than not listing
// it. Re-add them if the key's allowlist changes.
export const MODELS: ModelConfig[] = [
  // Thinking-only: no instruct variant is listed, deliberately — this model is
  // always in thinking mode and the user only adjusts how hard it thinks.
  {
    ...gw("qwen3.8-27b", "Qwen · 27B (thinking)"),
    thinking: qwenThinking(["medium", "high", "xhigh"], "high"),
  },
  {
    id: "local-qwen3.8-27b-uncensored",
    label: "qwen3.8-27b-uncensored",
    provider: "custom",
    model: "qwen3.8-27b-uncensored",
    mode: "chat-only",
    thinking: qwenThinking(["low", "medium", "xhigh"], "xhigh"),
    apiKeyEnv: "QWEN38_UNCENSORED_API_KEY",
    apiKey: QWEN38_UNCENSORED_KEY,
    baseUrl: QWEN38_UNCENSORED_BASE,
    hint: "Qwen · 27B uncensored · local GPU",
    brand: "qwen",
    contextWindow: 8_192,
  },
  gw("qwen3.5-397b-instruct", "Qwen · 397B chat (instruct)", 262_144),
  gw("qwen3.6-35b-instruct", "Qwen · 35B chat (instruct)"),
  gw("qwen3.6-35b", "Qwen · 35B reasoning"),
  gw("ds4-flash", "ds4-flash (reasoning)"),
  gw("ds4-flash-1m", "ds4-flash · 1M context", 1_048_576),
  gw("nemotron-3.5-lightning", "NVIDIA · Nemotron 3.5 Lightning"),
  gw("muse-glimmer-30b", "Muse · Glimmer 30B"),
  gw("vrs_smart", "VRS Smart · reads images"),
];

export function getModel(id: string): ModelConfig | undefined {
  return MODELS.find((m) => m.id === id);
}

/** True if the requested provider can actually be reached (key present). */
export function isLikelyConfigured(model: ModelConfig): boolean {
  if (model.provider === "mock") return true;
  const key = effectiveApiKey(model);
  if (!model.apiKeyEnv && !key) return false;
  const ready = !!key && key.length > 0;
  if (model.provider === "custom") return ready && !!model.baseUrl;
  return ready;
}
