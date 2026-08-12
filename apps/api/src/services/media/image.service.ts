import { env } from "../../config/env";
import { logger } from "../../lib/logger";
import { putObject } from "./media.service";
import { imageStore, type ImageStore, type NewImage } from "../../repositories/image.repository";

/**
 * Image generation through OpenRouter (Gemini by default).
 *
 * OpenRouter has no separate image endpoint — generation is `/chat/completions`
 * with `modalities: ["image", "text"]`, and the result comes back on
 * `message.images[]` as a data URI while `message.content` is null. Reading
 * `content` and finding nothing is the obvious wrong conclusion here, so the
 * parsing below goes straight for `images`.
 */

export type GeneratedImage = {
  id: string;
  prompt: string;
  model: string;
  contentType: string;
  bytes: number;
  costMicros: number | null;
  /** Path the console serves it from, ready to drop into markdown. */
  url: string;
};

export type GenerateResult =
  | { ok: true; images: GeneratedImage[] }
  | { ok: false; error: string };

/** `data:image/jpeg;base64,...` → bytes + mime. Null when it isn't a data URI. */
export function decodeDataUri(uri: string): { bytes: Uint8Array; contentType: string } | null {
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(uri);
  if (!match) return null;
  try {
    return { contentType: match[1], bytes: Uint8Array.fromBase64(match[2]) };
  } catch {
    return null;
  }
}

/** `image/jpeg` → `jpg`, for a key that is recognisable in a bucket listing. */
function extensionFor(contentType: string): string {
  const subtype = contentType.split("/")[1]?.split("+")[0] ?? "bin";
  return subtype === "jpeg" ? "jpg" : subtype;
}

type Deps = {
  store?: ImageStore;
  fetchImpl?: typeof fetch;
  /** Injected so tests exercise the real parsing without a live bucket. */
  putImpl?: typeof putObject;
  /**
   * Injected rather than read from `env` at call time, because `env` resolves
   * once at import: a test that sets process.env in `beforeEach` would have no
   * effect on it, and would look configured while being empty.
   */
  apiKey?: string;
};

/**
 * Generate one or more images and persist them.
 *
 * Costs real money per call — ~$0.03 for a flash image, ~4x that for pro — so
 * failures are returned rather than thrown: a tool that reports "billing
 * declined" to the model is more useful than one that crashes the run.
 */
export async function generateImage(
  opts: {
    workspaceId: string;
    prompt: string;
    conversationId?: string;
    model?: string;
  },
  deps: Deps = {},
): Promise<GenerateResult> {
  const store = deps.store ?? imageStore;
  const doFetch = deps.fetchImpl ?? fetch;
  const put = deps.putImpl ?? putObject;
  const apiKey = deps.apiKey ?? env.openrouterApiKey;

  const prompt = opts.prompt.trim();
  if (!prompt) return { ok: false, error: "prompt is required" };
  if (!apiKey) {
    return { ok: false, error: "image generation is not configured — OPENROUTER_API_KEY is unset" };
  }

  const model = opts.model?.trim() || env.imageModel;
  const startedAt = Date.now();

  let res: Response;
  try {
    res = await doFetch(`${env.openrouterBaseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        // Without this the model answers in text and describes the picture it
        // would have drawn.
        modalities: ["image", "text"],
        messages: [{ role: "user", content: prompt }],
        // Deliberately no max_tokens. On these models reasoning tokens are
        // drawn from the same budget, so a small cap returns finish_reason
        // "length" with an empty result and no error.
      }),
      // Generation is slow — a pro image can take most of a minute.
      signal: AbortSignal.timeout(120_000),
    });
  } catch (e) {
    return { ok: false, error: `could not reach OpenRouter: ${(e as Error).message}` };
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    return { ok: false, error: `OpenRouter returned HTTP ${res.status}: ${detail.slice(0, 300)}` };
  }

  let payload: any;
  try {
    payload = await res.json();
  } catch (e) {
    return { ok: false, error: `malformed OpenRouter response: ${(e as Error).message}` };
  }

  if (payload?.error) {
    return { ok: false, error: `OpenRouter error: ${payload.error.message ?? "unknown"}` };
  }

  const message = payload?.choices?.[0]?.message;
  const raw: any[] = message?.images ?? [];
  if (!raw.length) {
    // A refusal or a text-only answer lands here. Surfacing whatever the model
    // did say beats reporting an empty generic failure.
    const said = String(message?.content ?? message?.refusal ?? "").trim();
    return {
      ok: false,
      error: said
        ? `${model} returned no image. It said: ${said.slice(0, 300)}`
        : `${model} returned no image and no explanation`,
    };
  }

  // Cost is reported once for the whole call; split it so per-image rows sum
  // back to what OpenRouter actually billed.
  const totalCost = Number(payload?.usage?.cost);
  const accepted = raw.slice(0, Math.max(1, env.imageMaxPerCall));
  const perImageMicros = Number.isFinite(totalCost)
    ? Math.round((totalCost * 1e6) / accepted.length)
    : null;

  const images: GeneratedImage[] = [];
  for (const [i, entry] of accepted.entries()) {
    const uri = entry?.image_url?.url;
    if (typeof uri !== "string") continue;
    const decoded = decodeDataUri(uri);
    if (!decoded) {
      logger.warn("image.decode.failed", { model, prefix: uri.slice(0, 32) });
      continue;
    }

    const id = crypto.randomUUID();
    // Workspace-prefixed so one workspace's media is a single listing, and so
    // a future per-workspace lifecycle rule has something to match on.
    const key = `${opts.workspaceId}/${id}.${extensionFor(decoded.contentType)}`;

    try {
      await put(key, decoded.bytes, decoded.contentType);
    } catch (e) {
      // The image is generated and billed at this point. Failing the whole call
      // because storage is down would hide that, so report it as it happened.
      return {
        ok: false,
        error:
          `${model} generated the image but it could not be stored ` +
          `(${(e as Error).message}). The generation was still billed.`,
      };
    }

    const row: NewImage = {
      id,
      workspaceId: opts.workspaceId,
      conversationId: opts.conversationId ?? null,
      prompt,
      model,
      storageKey: key,
      contentType: decoded.contentType,
      bytes: decoded.bytes.byteLength,
      costMicros: perImageMicros,
    };
    await store.save(row);

    images.push({
      id,
      prompt,
      model,
      contentType: decoded.contentType,
      bytes: decoded.bytes.byteLength,
      costMicros: perImageMicros,
      url: `/api/images/${id}`,
    });
    logger.info("image.generated", { id, model, bytes: decoded.bytes.byteLength, index: i });
  }

  if (!images.length) return { ok: false, error: `${model} returned images in an unreadable format` };

  logger.info("image.generate.done", {
    model,
    count: images.length,
    ms: Date.now() - startedAt,
    costUsd: Number.isFinite(totalCost) ? totalCost : "unknown",
  });
  return { ok: true, images };
}
