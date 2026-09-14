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
/**
 * A gateway model the static catalog does not list.
 *
 * On-prem serves whichever model the operator chose at install, and that name
 * need not appear in the hand-maintained list above. Synthesising it lets a
 * freshly installed machine both show and run its own model. It carries the
 * gateway's base URL and key like any other `gw()` entry, so a run resolves the
 * same way.
 */
export function syntheticGatewayModel(name: string, contextWindow?: number): ModelConfig {
  const model = gw(name, `Local · ${name}`);
  return contextWindow && contextWindow > 0 ? { ...model, contextWindow } : model;
}

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

// The shared gateway can advertise a model after all of its deployments have
// gone unhealthy. Keep this list to models verified with a real completion,
// not merely names returned by `GET /v1/models`; otherwise the picker offers a
// run that can only return "no healthy deployments".
export const MODELS: ModelConfig[] = [
  // Thinking-only: no instruct variant is listed, deliberately — this model is
  // always in thinking mode and the user only adjusts how hard it thinks.
  {
    ...gw("qwen3.8-27b", "Qwen · 27B (thinking)"),
    thinking: qwenThinking(["medium", "high", "xhigh"], "high"),
  },
  {
    ...gw("qwen3.8-flash", "Qwen · Flash (thinking)"),
    thinking: qwenThinking(["medium", "high", "xhigh"], "high"),
  },
  gw("ds4-flash", "ds4-flash (reasoning)"),
  gw("glm-5.3-flash", "GLM · 5.3 Flash"),
  gw("vrs_smart", "VRS · Smart"),
  {
    ...gw("gemini-3.1-flash-image", "Google · Gemini 3.1 Flash Image"),
    // The router accepts ordinary chat completions for this model but has no
    // endpoint that supports tool use, so keep agent schemas away from it.
    mode: "chat-only",
  },
];

// Existing conversations and managed agents persist catalog ids. Keep retired
// ids resolvable through the active shared-gateway model (or the configured
// on-prem model) without advertising them in the picker again.
const LEGACY_CHAT_ONLY_MODEL_ID = "local-qwen3.8-27b-uncensored";
const RETIRED_MODEL_IDS = new Set([
  LEGACY_CHAT_ONLY_MODEL_ID,
  "gw-qwen3.5-397b-instruct",
  "gw-qwen3.6-35b-instruct",
  "gw-qwen3.6-35b",
  "gw-ds4-flash-1m",
  "gw-muse-glimmer-30b",
  "gw-nemotron-3.5-lightning",
]);

export function getModel(id: string): ModelConfig | undefined {
  const known = MODELS.find((m) => m.id === id);
  if (known) return known;
  const configured = process.env.CUSTOM_MODEL?.trim();
  if (RETIRED_MODEL_IDS.has(id)) {
    const replacement = configured
      ? MODELS.find((m) => m.model === configured) ?? syntheticGatewayModel(configured)
      : MODELS.find((m) => m.id === "gw-qwen3.8-27b");
    if (!replacement) return undefined;
    return id === LEGACY_CHAT_ONLY_MODEL_ID
      ? { ...replacement, id, mode: "chat-only" }
      : replacement;
  }
  // The single model an on-prem gateway serves may not be in the static list;
  // resolve it so the picker's choice can actually run. Bounded to the
  // configured model, never an arbitrary `gw-*` id.
  if (configured && id === `gw-${configured}`) return syntheticGatewayModel(configured);
  return undefined;
}

/** True if the requested provider can actually be reached (key present). */
export function isLikelyConfigured(model: ModelConfig): boolean {
  if (model.provider === "mock") return true;
  const configuredGatewayModel = process.env.CUSTOM_MODEL?.trim();
  if (
    model.provider === "custom" &&
    model.apiKeyEnv === "CUSTOM_API_KEY" &&
    !model.apiKey &&
    configuredGatewayModel &&
    model.model !== configuredGatewayModel
  ) {
    return false;
  }
  const key = effectiveApiKey(model);
  if (!model.apiKeyEnv && !key) return false;
  const ready = !!key && key.length > 0;
  if (model.provider === "custom") return ready && !!model.baseUrl;
  return ready;
}
