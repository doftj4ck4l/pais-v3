import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { TranscriptionAudioInput } from "./transcribe.service";

/** Ten minutes at 64 kbit/s is about 4.8 MB, below common Whisper limits. */
export const AUDIO_SEGMENT_SECONDS = 10 * 60;
export const MAX_DIRECT_WHISPER_BYTES = 8 * 1024 * 1024;

export type WhisperAudioSegment = {
  input: TranscriptionAudioInput;
  offsetSeconds: number;
};

export type PreparedWhisperAudio = {
  segments: WhisperAudioSegment[];
  cleanup: () => Promise<void>;
};

async function readProcessError(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let output = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    // Keep draining so FFmpeg cannot block on a full pipe, but bound retained
    // text because media is untrusted and may provoke repetitive diagnostics.
    if (output.length < 4_096) {
      output += decoder.decode(value, { stream: true }).slice(0, 4_096 - output.length);
    }
  }
  return output.trim();
}

/**
 * Strip video and split long media before it reaches the model gateway.
 *
 * Browser chunking solves the reverse proxy's per-request limit, but Whisper
 * gateways impose a second limit on the completed media file. Encoding mono
 * 16 kHz speech at 64 kbit/s makes segment size predictable even when the
 * source is a very large, high-bitrate video.
 */
export async function prepareWhisperAudio(
  input: TranscriptionAudioInput,
): Promise<PreparedWhisperAudio> {
  const root = await mkdtemp(join(tmpdir(), "pixelspace-whisper-"));
  const source = "bytes" in input ? join(root, "source") : input.filePath;
  const outputPattern = join(root, "segment-%06d.mp3");

  try {
    if ("bytes" in input) await writeFile(source, input.bytes);

    const process = Bun.spawn(
      [
        "ffmpeg",
        "-hide_banner",
        "-loglevel",
        "error",
        "-nostdin",
        "-i",
        source,
        "-map",
        "0:a:0",
        "-vn",
        "-ac",
        "1",
        "-ar",
        "16000",
        "-b:a",
        "64k",
        "-f",
        "segment",
        "-segment_time",
        String(AUDIO_SEGMENT_SECONDS),
        "-reset_timestamps",
        "1",
        outputPattern,
      ],
      { stdout: "ignore", stderr: "pipe" },
    );
    const stderrPromise = readProcessError(process.stderr);
    const exitCode = await process.exited;
    const stderr = (await stderrPromise).trim();
    if (exitCode !== 0) {
      throw new Error(
        `could not prepare audio for transcription: ${stderr.slice(0, 300) || `ffmpeg exited ${exitCode}`}`,
      );
    }

    const names = (await readdir(root))
      .filter((name) => /^segment-\d{6}\.mp3$/.test(name))
      .sort();
    if (names.length === 0) {
      throw new Error("could not prepare audio for transcription: no audio stream was found");
    }

    const segments = await Promise.all(names.map(async (name, index) => {
      const filePath = join(root, name);
      const info = await stat(filePath);
      return {
        input: {
          filePath,
          byteLength: info.size,
          contentType: "audio/mpeg",
          filename: basename(name),
        },
        offsetSeconds: index * AUDIO_SEGMENT_SECONDS,
      };
    }));
    return {
      segments,
      cleanup: () => rm(root, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}
