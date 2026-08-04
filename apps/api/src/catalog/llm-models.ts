export type ModelConfig = {
  id: string;
  label: string;
  provider: "openai" | "deepseek" | "custom" | "mock";
  model: string;
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

/** Helper: a named chat-completion model served by the local gateway. */
function gw(id: string, hint: string, contextWindow = DEFAULT_CONTEXT_WINDOW): ModelConfig {
  const brand = id.startsWith("ds4") ? "deepseek" : "qwen";
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

// Only qwen3.5-397b-instruct is measured: it accepted a 200,012-token prompt,
// so 262144 is the nearest plausible window and 131072 would have understated
// it by a third. The rest are the default until someone measures them.
export const MODELS: ModelConfig[] = [
  gw("qwen3.5-397b-instruct", "Qwen · 397B chat (instruct)", 262_144),
  gw("qwen3.5-397b", "Qwen · 397B reasoning", 262_144),
  gw("qwen3.6-27b-instruct", "Qwen · 27B chat (instruct)"),
  gw("qwen3.6-27b", "Qwen · 27B reasoning"),
  gw("qwen3.6-35b-instruct", "Qwen · 35B chat (instruct)"),
  gw("qwen3.6-35b", "Qwen · 35B reasoning"),
  gw("ds4-flash", "ds4-flash (reasoning)"),
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
