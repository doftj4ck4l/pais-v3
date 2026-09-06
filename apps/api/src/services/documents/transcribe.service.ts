import { logger } from "../../lib/logger";
import { env } from "../../config/env";
import { effectiveApiKey, MODELS } from "../../catalog/llm-models";
import { ingestText, type IngestResult } from "./ingest.service";
import { documentStore, type DocumentStore } from "../../repositories/document.repository";

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

/** Same scheme as `ingest.service`, so ids did not need a separate namespace. */
const newDocId = () => `doc_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

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
 * Returns the same `IngestResult` shape as a PDF upload so the web client can
 * render both without knowing which one happened. A transcription that failed
 * is *recorded*, never thrown: like a PDF that would not extract, the user
 * uploaded it and needs to see what happened to it, and only the Docs row can
 * tell "done" from "whisper never answered".
 */
export async function transcribeToDocs(
  workspaceId: string,
  title: string,
  input: { bytes: Uint8Array; contentType: string; filename: string },
  deps: TranscribeDeps = {},
): Promise<IngestResult> {
  const t = await transcribeAudio(input, deps);
  if (!t.ok) {
    const store = deps.store ?? documentStore;
    const documentId = newDocId();
    const error = t.error.slice(0, 300);
    await store.save(
      { id: documentId, workspaceId, title, bytes: input.bytes.byteLength, pages: 0, status: "error", error },
      [],
    );
    return { documentId, title, status: "error", pages: 0, chunks: 0, error };
  }

  // `ingestText` handles an empty transcript too, recording it as an empty
  // document rather than dropping the upload; this file just has to not stand
  // in its way.
  return ingestText(workspaceId, title, formatTranscript(t.segments), deps.store);
}
