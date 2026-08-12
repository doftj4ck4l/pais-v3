import { env } from "../../config/env";
import { logger } from "../../lib/logger";
import { effectiveApiKey } from "../../catalog/llm-models";
import { MODELS } from "../../catalog/llm-models";

/**
 * Looking at an image, on behalf of a model that cannot.
 *
 * `generate_image` already establishes the shape: a tool runs in the API
 * process, calls a *different* model over HTTP, and returns text. This is that
 * in reverse, and it exists because the two are not symmetric today — a run on
 * `ds4-flash` can make a picture and then be unable to see the one it made.
 *
 * The answer comes back as prose, never as pixels. That is what makes it work
 * at all: the transcript stays text, `RESULT_CHAR_CAP` is never in danger, and
 * the blind model gets something it can actually reason over on the next turn.
 * Returning the image itself would fail three ways at once — `flattenContent`
 * renders an image block as `[image]`, the pi model is declared `input:
 * ["text"]`, and one base64 PNG measured 135,944 characters against a 40,000
 * cap.
 */

export type VisionResult =
  | { ok: true; text: string; model: string }
  | { ok: false; error: string };

type Deps = {
  fetchImpl?: typeof fetch;
  /**
   * Injected rather than read from `env` at call time. `env` resolves once at
   * import, so a test setting process.env in `beforeEach` would have no effect
   * and the service would look configured while being empty.
   */
  apiKey?: string;
  baseUrl?: string;
};

/** The gateway's own config, borrowed from any model served by it. */
function gatewayConfig(): { baseUrl: string; apiKey: string | undefined } {
  const any = MODELS.find((m) => m.provider === "custom");
  return {
    baseUrl: any?.baseUrl ?? "",
    apiKey: any ? effectiveApiKey(any) : undefined,
  };
}

/** True when a vision call could succeed, so the tool can be withheld rather than fail. */
export function visionConfigured(): boolean {
  const { baseUrl, apiKey } = gatewayConfig();
  return Boolean(baseUrl && apiKey);
}

export async function describeImage(
  input: { bytes: Uint8Array; contentType: string; question: string; model?: string },
  deps: Deps = {},
): Promise<VisionResult> {
  const gateway = gatewayConfig();
  const baseUrl = deps.baseUrl ?? gateway.baseUrl;
  const apiKey = deps.apiKey ?? gateway.apiKey;
  const doFetch = deps.fetchImpl ?? fetch;
  const model = input.model?.trim() || env.visionModel;

  if (!baseUrl || !apiKey) {
    return { ok: false, error: "no vision model is configured (CUSTOM_BASE_URL / CUSTOM_API_KEY)" };
  }
  if (input.bytes.byteLength > env.visionMaxBytes) {
    return {
      ok: false,
      error:
        `image is ${input.bytes.byteLength.toLocaleString()} bytes, over the ` +
        `${env.visionMaxBytes.toLocaleString()} limit — crop or downscale it first`,
    };
  }

  const dataUri = `data:${input.contentType};base64,${Buffer.from(input.bytes).toString("base64")}`;
  const startedAt = Date.now();

  let res: Response;
  try {
    res = await doFetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: input.question },
              { type: "image_url", image_url: { url: dataUri } },
            ],
          },
        ],
        // No cap. A vision model that reasons spends the same budget on
        // reasoning as on the answer, and a small ceiling returns
        // `finish_reason: "length"` with nothing in `content` — the same trap
        // `image.service` documents for generation.
      }),
    });
  } catch (e: any) {
    return { ok: false, error: `vision request failed: ${e?.message ?? String(e)}` };
  }

  const body = await res.text();
  if (!res.ok) {
    // The gateway's own message is the useful part: "X is not a multimodal
    // model" names the fix, where "HTTP 400" sends you looking at the image.
    let detail = body.slice(0, 300);
    try {
      detail = JSON.parse(body)?.error?.message ?? detail;
    } catch {
      // Keep the raw body — a non-JSON error is still worth reporting.
    }
    logger.warn("vision.failed", { model, status: res.status, detail: detail.slice(0, 200) });
    return { ok: false, error: `vision model ${model} refused: ${detail}` };
  }

  let text = "";
  try {
    const parsed = JSON.parse(body);
    text = String(parsed?.choices?.[0]?.message?.content ?? "").trim();
  } catch {
    return { ok: false, error: "vision model returned a response that was not JSON" };
  }

  if (!text) return { ok: false, error: `vision model ${model} returned an empty answer` };

  logger.info("vision.described", {
    model,
    ms: Date.now() - startedAt,
    bytes: input.bytes.byteLength,
    chars: text.length,
  });
  return { ok: true, text, model };
}
