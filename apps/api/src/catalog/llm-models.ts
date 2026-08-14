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
