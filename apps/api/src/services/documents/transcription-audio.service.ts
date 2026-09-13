import fs from "node:fs/promises";
import path from "node:path";
import { workspaceRoot } from "../../repositories/workspace.repository";
import type { TranscriptionAudioSource } from "./transcribe.service";

const INTERNAL_DIRECTORY = [".pixelspace", "transcriptions"] as const;
const SAFE_ID = /^[a-zA-Z0-9_-]+$/;

const MEDIA_TYPES: Record<string, string> = {
  ".aac": "audio/aac",
  ".flac": "audio/flac",
  ".m4a": "audio/mp4",
  ".mp3": "audio/mpeg",
  ".mp4": "video/mp4",
  ".oga": "audio/ogg",
  ".ogg": "audio/ogg",
  ".opus": "audio/ogg",
  ".wav": "audio/wav",
  ".webm": "audio/webm",
};
const SAFE_MEDIA_TYPES = new Set(Object.values(MEDIA_TYPES));

export type StoredTranscriptionAudio = {
  relativePath: string;
  absolutePath: string;
  byteLength: number;
  contentType: string;
};

export type OpenTranscriptionAudio = StoredTranscriptionAudio & {
  file: ReturnType<typeof Bun.file>;
};

export interface TranscriptionAudioStorage {
  save(input: {
    id: string;
    workspaceId: string;
    title: string;
    contentType: string;
    source: TranscriptionAudioSource;
    /** The caller owns this temp file, so rename it when both roots share a filesystem. */
    moveSource?: boolean;
  }): Promise<StoredTranscriptionAudio>;
  open(workspaceId: string, relativePath: string, contentType: string | null): Promise<OpenTranscriptionAudio | null>;
  remove(workspaceId: string, relativePath: string): Promise<void>;
}

/**
 * Durable source recordings, kept beside the workspace but outside its normal
 * file picker. A recording may be 2GiB, so putting it in SQLite would turn
 * every database backup and migration into a large-blob operation.
 *
 * The `.pixelspace` directory can also be reached by the workspace sandbox.
 * Every directory component is therefore checked with lstat before a write;
 * an agent-created symlink must never redirect a recording onto the API host.
 */
export class WorkspaceTranscriptionAudioStorage implements TranscriptionAudioStorage {
  constructor(private readonly rootFor: (workspaceId: string) => string = workspaceRoot) {}

  async save(input: {
    id: string;
    workspaceId: string;
    title: string;
    contentType: string;
    source: TranscriptionAudioSource;
    moveSource?: boolean;
  }): Promise<StoredTranscriptionAudio> {
    if (!SAFE_ID.test(input.id)) throw new Error("invalid transcription id");

    const root = this.rootFor(input.workspaceId);
    const directory = await ensureInternalDirectory(root);
    const extension = safeExtension(input.title);
    const filename = `${input.id}${extension}`;
    const absolutePath = path.join(directory, filename);
    const relativePath = [...INTERNAL_DIRECTORY, filename].join("/");
    const temporaryPath = `${absolutePath}.${crypto.randomUUID()}.tmp`;

    try {
      if ("bytes" in input.source) {
        await fs.writeFile(temporaryPath, input.source.bytes, { flag: "wx" });
      } else if (input.moveSource) {
        try {
          await fs.rename(input.source.filePath, temporaryPath);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
          await fs.copyFile(input.source.filePath, temporaryPath, fs.constants.COPYFILE_EXCL);
        }
      } else {
        await fs.copyFile(input.source.filePath, temporaryPath, fs.constants.COPYFILE_EXCL);
      }
      await fs.rename(temporaryPath, absolutePath);
    } catch (error) {
      await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
      throw error;
    }

    return {
      relativePath,
      absolutePath,
      byteLength: "bytes" in input.source ? input.source.bytes.byteLength : input.source.byteLength,
      contentType: safeContentType(input.contentType, extension),
    };
  }

  async open(
    workspaceId: string,
    relativePath: string,
    contentType: string | null,
  ): Promise<OpenTranscriptionAudio | null> {
    const absolutePath = this.resolveInternalPath(workspaceId, relativePath);
    if (!absolutePath) return null;
    const stat = await fs.lstat(absolutePath).catch(() => null);
    if (!stat?.isFile() || stat.isSymbolicLink()) return null;
    const extension = path.extname(absolutePath).toLowerCase();
    return {
      relativePath,
      absolutePath,
      byteLength: stat.size,
      contentType: safeContentType(contentType ?? "", extension),
      file: Bun.file(absolutePath),
    };
  }

  async remove(workspaceId: string, relativePath: string): Promise<void> {
    const absolutePath = this.resolveInternalPath(workspaceId, relativePath);
    if (!absolutePath) return;
    const stat = await fs.lstat(absolutePath).catch(() => null);
    if (!stat || stat.isSymbolicLink() || !stat.isFile()) return;
    await fs.rm(absolutePath, { force: true });
  }

  private resolveInternalPath(workspaceId: string, relativePath: string): string | null {
    const normalized = relativePath.replaceAll("\\", "/");
    const match = normalized.match(/^\.pixelspace\/transcriptions\/([a-zA-Z0-9_-]+\.[a-zA-Z0-9]+)$/);
    if (!match) return null;
    const root = this.rootFor(workspaceId);
    const candidate = path.resolve(root, ...normalized.split("/"));
    const rel = path.relative(root, candidate);
    return rel.startsWith("..") || path.isAbsolute(rel) ? null : candidate;
  }
}

async function ensureInternalDirectory(root: string): Promise<string> {
  await fs.mkdir(root, { recursive: true });
  const rootStat = await fs.lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error("invalid transcription audio directory");
  }
  let current = root;
  for (const segment of INTERNAL_DIRECTORY) {
    current = path.join(current, segment);
    await fs.mkdir(current).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
    });
    const stat = await fs.lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("invalid transcription audio directory");
  }
  return current;
}

function safeExtension(title: string): string {
  const extension = path.extname(title).toLowerCase();
  return Object.hasOwn(MEDIA_TYPES, extension) ? extension : ".audio";
}

function safeContentType(contentType: string, extension: string): string {
  const normalized = contentType.trim().toLowerCase();
  if (SAFE_MEDIA_TYPES.has(normalized)) return normalized;
  return MEDIA_TYPES[extension] ?? "application/octet-stream";
}

export const transcriptionAudioStorage: TranscriptionAudioStorage = new WorkspaceTranscriptionAudioStorage();
