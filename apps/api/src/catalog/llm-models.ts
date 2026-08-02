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
};

/** The API key actually in effect for a run: per-request override, else env. */
export function effectiveApiKey(model: ModelConfig): string | undefined {
  return model.apiKey || process.env[model.apiKeyEnv];
}

const CUSTOM_BASE = process.env.CUSTOM_BASE_URL ?? "http://60.51.17.97:9999/v1";

/** Helper: a named chat-completion model served by the local gateway. */
function gw(id: string, hint: string): ModelConfig {
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
  };
}

export const MODELS: ModelConfig[] = [
  gw("qwen3.5-397b-instruct", "Qwen · 397B chat (instruct)"),
  gw("qwen3.5-397b", "Qwen · 397B reasoning"),
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
