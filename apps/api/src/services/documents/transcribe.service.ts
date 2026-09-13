import { logger } from "../../lib/logger";
import { env } from "../../config/env";
import { effectiveApiKey, MODELS } from "../../catalog/llm-models";
import { ingestText } from "./ingest.service";
import type { DocumentStore } from "../../repositories/document.repository";
import {
  MAX_DIRECT_WHISPER_BYTES,
  prepareWhisperAudio,
  type PreparedWhisperAudio,
} from "./audio-segment.service";

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
  /** Called after Whisper returns and before the transcript enters the index. */
  onIndexing?: () => void | Promise<void>;
  /** Test seam for FFmpeg-backed preparation of oversized media. */
  prepareAudio?: (input: TranscriptionAudioInput) => Promise<PreparedWhisperAudio>;
};

export type TranscriptionAudioSource =
  | { bytes: Uint8Array }
  | { filePath: string; byteLength: number };

export type TranscriptionAudioInput = TranscriptionAudioSource & {
  contentType: string;
  filename: string;
};

export const transcriptionAudioBytes = (input: TranscriptionAudioSource) =>
  "bytes" in input ? input.bytes.byteLength : input.byteLength;

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
async function transcribeAudioPart(
  input: TranscriptionAudioInput,
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
  if ("bytes" in input) {
    // `File` is global in Bun (undici), so no polyfill is needed for fetch.
    form.append("file", new File(
      [input.bytes],
      input.filename,
      { type: input.contentType || "application/octet-stream" },
    ));
  } else {
    // Bun.file is a lazy, disk-backed Blob. Wrapping that Blob gives multipart
    // the original filename without reading/copying its contents into memory.
    const diskFile = Bun.file(input.filePath, {
      type: input.contentType || "application/octet-stream",
    });
    form.append("file", new File([diskFile], input.filename, { type: diskFile.type }));
  }
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
        bytes: transcriptionAudioBytes(input),
        segments: flattened.length,
        chars: flattened.reduce((n, s) => n + s.text.length, 0),
      });
      return { ok: true, model, language: parsed?.language ?? null, segments: flattened };
    }
  }

  return { ok: false, error: `whisper model ${model} returned an empty transcript` };
}

/**
 * Transcribe one model-safe file, or split oversized media and merge its
 * timestamped results. Browser upload chunks are transport pieces and cannot
 * be sent to Whisper directly because most of them are not valid media files;
 * FFmpeg creates independently decodable audio segments after upload instead.
 */
export async function transcribeAudio(
  input: TranscriptionAudioInput,
  deps: TranscribeDeps = {},
): Promise<TranscribeResult> {
  const byteLength = transcriptionAudioBytes(input);
  if (byteLength <= MAX_DIRECT_WHISPER_BYTES) {
    return transcribeAudioPart(input, deps);
  }

  let prepared: PreparedWhisperAudio;
  try {
    prepared = await (deps.prepareAudio ?? prepareWhisperAudio)(input);
  } catch (error: any) {
    return { ok: false, error: error?.message ?? String(error) };
  }

  const segments: TranscriptionSegment[] = [];
  let model = "";
  let language: string | null = null;
  try {
    for (const [index, part] of prepared.segments.entries()) {
      logger.info("transcribe.segment.start", {
        filename: input.filename,
        part: index + 1,
        parts: prepared.segments.length,
        bytes: transcriptionAudioBytes(part.input),
      });
      const result = await transcribeAudioPart(part.input, deps);
      if (!result.ok) {
        return {
          ok: false,
          error: `audio segment ${index + 1}/${prepared.segments.length} failed: ${result.error}`,
        };
      }
      model ||= result.model;
      language ??= result.language ?? null;
      segments.push(...result.segments.map((segment) => ({
        ...segment,
        start: segment.start + part.offsetSeconds,
      })));
    }
  } finally {
    try {
      await prepared.cleanup();
    } catch (error: any) {
      logger.warn("transcribe.segment.cleanup_failed", {
        filename: input.filename,
        message: String(error?.message ?? error),
      });
    }
  }

  logger.info("transcribe.segmented.ok", {
    filename: input.filename,
    bytes: byteLength,
    parts: prepared.segments.length,
    segments: segments.length,
  });
  return { ok: true, model, language, segments };
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

/** Recover timestamped segments from the exact text kept with a finished job. */
export function parseFormattedTranscript(text: string): TranscriptionSegment[] {
  return text
    .split("\n")
    .map((line) => {
      const match = line.trim().match(/^\[(\d+):(\d{2})(?::(\d{2}))?\]\s*(.*)$/);
      if (!match) return null;
      const first = Number(match[1]);
      const second = Number(match[2]);
      const hasHours = match[3] !== undefined;
      const start = hasHours ? first * 3600 + second * 60 + Number(match[3]) : first * 60 + second;
      const content = match[4].trim();
      return content ? { start, text: content } : null;
    })
    .filter((segment): segment is TranscriptionSegment => segment !== null);
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
  input: TranscriptionAudioInput,
  deps: TranscribeDeps = {},
): Promise<CorpusOutcome> {
  const t = await transcribeAudio(input, deps);
  if (!t.ok) return { ok: false, error: t.error.slice(0, 300) };

  // `ingestText` handles an empty transcript too, but an empty audio upload is
  // a failure worth surfacing as such, not an empty document in the corpus.
  await deps.onIndexing?.();
  const text = formatTranscript(t.segments);
  const result = await ingestText(workspaceId, title, text, deps.store);
  if (result.status === "indexed") {
    return {
      ok: true,
      documentId: result.documentId,
      chunks: result.chunks,
      model: t.model,
      language: t.language ?? null,
      // Keep the exact formatted text for a byte-stable `.txt` export; corpus
      // chunks are shaped for search and may have different boundaries.
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
