import { logger } from "../../lib/logger";
import { env } from "../../config/env";
import { effectiveApiKey, MODELS } from "../../catalog/llm-models";
import { ingestText } from "./ingest.service";
import type { DocumentStore } from "../../repositories/document.repository";

/**
 * Audio -> timestamped transcript -> the documents corpus.
 *
 * The transcribing half is an OpenAI-compatible whisper deployment over HTTP,
 * the same shape `vision.service` uses for its model: the API process posts
 * bytes and gets text back. Unlike a PDF upload there is no extraction freedom
 * involved — whisper decides what the words are and when they start, and this
 * file's only real work is to turn that into text the existing ingestion
 * pipeline already handles.
 *
 * The transcript is written as `[MM:SS] line` per segment and fed to
 * `ingestText` verbatim. That keeps speaker-agnostic timestamps searchable so a
 * later diarization pass ("who said what") becomes a format change in this file
 * and nothing else: the corpus does not care what the text looks like.
 */

export type TranscriptionSegment = { start: number; text: string };

export type TranscribeResult =
  | { ok: true; model: string; language?: string | null; segments: TranscriptionSegment[] }
  | { ok: false; error: string };

/**
 * Injected rather than read from `env`/`process.env` at call time, exactly as
 * `vision.service` does: a test setting env in `beforeEach` would have no
 * effect, so the service would look configured while being empty.
 */
type TranscribeDeps = {
  fetchImpl?: typeof fetch;
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  language?: string;
  store?: DocumentStore;
};

const audioFile = (bytes: Uint8Array, filename: string, contentType: string) => {
  // `File` is global in Bun (undici), so no polyfill is needed for fetch.
  return new File([bytes], filename, { type: contentType || "application/octet-stream" });
};

/**
 * The whisper endpoint's own config, borrowed from the chat gateway because the
 * two usually share a deployment. An explicit `TRANSCRIBE_*` wins over it.
 */
export function transcribeConfig(): { baseUrl: string; apiKey: string | undefined; model: string } {
  const any = MODELS.find((m) => m.provider === "custom");
  return {
    baseUrl: env.transcribeBaseUrl || any?.baseUrl || "",
    apiKey: env.transcribeApiKey || (any ? effectiveApiKey(any) : undefined),
    model: env.transcribeModel,
  };
}

/**
 * POST the audio to `${base}/audio/transcriptions` and read the segments back.
 *
 * Whisper's verbose JSON returns `segments`; faster-whisper-server nests them
 * under `audio.segments`; a server without timestamps returns only `text`, in
 * which case the whole answer becomes one segment at 00:00 rather than being
 * thrown away.
 */
export async function transcribeAudio(
  input: { bytes: Uint8Array; contentType: string; filename: string },
  deps: TranscribeDeps = {},
): Promise<TranscribeResult> {
  const config = transcribeConfig();
  const baseUrl = (deps.baseUrl ?? config.baseUrl).replace(/\/+$/, "");
  const apiKey = deps.apiKey ?? config.apiKey;
  const model = (deps.model ?? config.model).trim();
  const doFetch = deps.fetchImpl ?? fetch;
  const startedAt = Date.now();

  if (!baseUrl || !apiKey || !model) {
    return { ok: false, error: "no transcription model is configured (TRANSCRIBE_* / CUSTOM_API_KEY)" };
  }

  const form = new FormData();
  form.append("model", model);
  form.append("file", audioFile(input.bytes, input.filename, input.contentType));
  form.append("response_format", "verbose_json");
  if (deps.language) form.append("language", deps.language);

  let res: Response;
  try {
    res = await doFetch(`${baseUrl}/audio/transcriptions`, {
      method: "POST",
      // FormData sets its own multipart Content-Type; setting one here would
      // drop the boundary and the body would fail to parse.
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
    });
  } catch (e: any) {
    return { ok: false, error: `transcription request failed: ${e?.message ?? String(e)}` };
  }

  const body = await res.text();
  if (!res.ok) {
    let detail = body.slice(0, 300);
    try {
      detail = JSON.parse(body)?.error?.message ?? detail;
    } catch {
      // Keep the raw body — a non-JSON error is still worth reporting.
    }
    logger.warn("transcribe.failed", { model, status: res.status, detail: detail.slice(0, 200) });
    return { ok: false, error: `whisper model ${model} refused: ${detail}` };
  }

  let parsed: any;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { ok: false, error: "whisper returned a response that was not JSON" };
  }

  const rawSegments = Array.isArray(parsed?.segments)
    ? parsed.segments
    : Array.isArray(parsed?.audio?.segments)
      ? parsed.audio.segments
      : null;
  if (rawSegments?.length || typeof parsed?.text === "string") {
    const segments: TranscriptionSegment[] = (rawSegments ?? [])
      .map((s: any) => ({ start: Number(s?.start) || 0, text: String(s?.text ?? "").trim() }))
      .filter((s: TranscriptionSegment) => s.text.length);

    const plain = String(parsed?.text ?? "")
      .split("\n")
      .map((line: string) => line.trim())
      .filter((line: string) => line.length);
    const flattened: TranscriptionSegment[] = segments.length > 0 ? segments : plain.map((line: string) => ({ start: 0, text: line }));

    if (flattened.length) {
      logger.info("transcribe.ok", {
        model,
        ms: Date.now() - startedAt,
        bytes: input.bytes.byteLength,
        segments: flattened.length,
        chars: flattened.reduce((n, s) => n + s.text.length, 0),
      });
      return { ok: true, model, language: parsed?.language ?? null, segments: flattened };
    }
  }

  return { ok: false, error: `whisper model ${model} returned an empty transcript` };
}

/** The `[MM:SS]` stamping of a segment's start time, snapped to a second. */
export function stamp(seconds: number): string {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  const mm = Math.floor(total / 60);
  const ss = total % 60;
  return `[${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}]`;
}

/**
 * Segments to the plain text the corpus ingests: one `[MM:SS] line` per
 * segment. The newline between turns is what the chunker's paragraph split
 * keys on, so a chunk rarely tears a speaker label off its own words.
 */
export function formatTranscript(segments: TranscriptionSegment[]): string {
  return segments.map((s) => `${stamp(s.start)} ${s.text}`.trim()).join("\n").trim();
}

/**
 * Transcribe an upload and index the result, as one unit.
 *
 * The failure path deliberately writes *nothing*: a failed transcription is a
 * `failed` job in the `transcriptions` table, and an error document in the
 * corpus as well would make the same incident visible twice for different
 * reasons. PDF ingestion still records its errors as rows, because there is no
 * job table for a PDF — the corpus row is the only record a failed upload gets.
 */
export async function transcribeToCorpus(
  workspaceId: string,
  title: string,
  input: { bytes: Uint8Array; contentType: string; filename: string },
  deps: TranscribeDeps = {},
): Promise<CorpusOutcome> {
  const t = await transcribeAudio(input, deps);
  if (!t.ok) return { ok: false, error: t.error.slice(0, 300) };

  // `ingestText` handles an empty transcript too, but an empty audio upload is
  // a failure worth surfacing as such, not an empty document in the corpus.
  const text = formatTranscript(t.segments);
  const result = await ingestText(workspaceId, title, text, deps.store);
  if (result.status === "indexed") {
    return {
      ok: true,
      documentId: result.documentId,
      chunks: result.chunks,
      model: t.model,
      language: t.language ?? null,
      // The corpus stores the same words split how the chunker chose; the job
      // keeps the original so a `.txt` export is byte-exact.
      text,
    };
  }
  return { ok: false, error: result.error ?? "the exported transcript was empty" };
}

/**
 * What one transcription job produced. `ok` only when a transcript exists in
 * the corpus to link; nothing is written on the failure branch.
 */
export type CorpusOutcome =
  | { ok: true; documentId: string; chunks: number; model: string; language: string | null; text: string }
  | { ok: false; error: string };
