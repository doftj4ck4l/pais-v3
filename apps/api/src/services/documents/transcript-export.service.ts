import {
  renderBrandedDocx,
  renderBrandedPdf,
  type Block,
} from "../agent/chat-export.service";
import {
  parseFormattedTranscript,
  type TranscriptionSegment,
} from "./transcribe.service";

export type TranscriptExportFormat = "pdf" | "docx";

/**
 * How long each printed passage covers.
 *
 * The live player follows the transcript segment by segment; this grouping exists
 * only for the printed page, where a heading every 30 seconds keeps the reading
 * flow without drowning the text in per-segment timestamps.
 */
const INTERVAL_SECONDS = 30;

/**
 * Group the timestamped segments into 30-second intervals and render a branded
 * PDF or DOCX with the title under the logo.
 *
 * The title is passed by the caller already stripped of its file extension.
 */
export async function renderTranscriptExport(input: {
  title: string;
  text: string;
  format: TranscriptExportFormat;
}): Promise<Uint8Array> {
  const blocks = transcriptBlocks(parseFormattedTranscript(input.text));
  return input.format === "pdf"
    ? renderBrandedPdf({ title: input.title, blocks })
    : renderBrandedDocx({ title: input.title, blocks });
}

/** Segments to blocks: a `[MM:SS – MM:SS]` heading per 30-second interval. */
export function transcriptBlocks(segments: TranscriptionSegment[]): Block[] {
  const blocks: Block[] = [];
  let current = -1;
  let buffer: string[] = [];
  const flush = () => {
    if (current < 0) return;
    blocks.push({ kind: "heading", level: 3, text: intervalLabel(current) });
    blocks.push({ kind: "body", text: buffer.join(" ") });
    buffer = [];
  };
  for (const segment of segments) {
    const bucket = Math.floor(segment.start / INTERVAL_SECONDS);
    if (bucket !== current) {
      flush();
      current = bucket;
    }
    buffer.push(segment.text.trim());
  }
  flush();
  return blocks;
}

function intervalLabel(bucket: number): string {
  const start = bucket * INTERVAL_SECONDS;
  return `${clock(start)} – ${clock(start + INTERVAL_SECONDS)}`;
}

function clock(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = String(Math.floor((seconds % 3600) / 60)).padStart(2, "0");
  const secs = String(Math.floor(seconds % 60)).padStart(2, "0");
  return hours > 0 ? `${hours}:${minutes}:${secs}` : `${minutes}:${secs}`;
}
