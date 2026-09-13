import { afterEach, describe, expect, it } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WorkspaceTranscriptionAudioStorage } from "./transcription-audio.service";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function storage() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pixelspace-transcription-audio-"));
  roots.push(root);
  return {
    root,
    store: new WorkspaceTranscriptionAudioStorage((workspaceId) => path.join(root, workspaceId)),
  };
}

describe("WorkspaceTranscriptionAudioStorage", () => {
  it("persists in-memory audio under the owning workspace and removes it", async () => {
    const { store } = await storage();
    const saved = await store.save({
      id: "trx_demo",
      workspaceId: "ws1",
      title: "meeting.mp3",
      contentType: "audio/mpeg",
      source: { bytes: new Uint8Array([1, 2, 3, 4]) },
    });

    expect(saved.relativePath).toBe(".pixelspace/transcriptions/trx_demo.mp3");
    expect(saved.absolutePath).toContain(`${path.sep}ws1${path.sep}`);
    const opened = await store.open("ws1", saved.relativePath, saved.contentType);
    expect(opened?.byteLength).toBe(4);
    expect(await opened?.file.arrayBuffer()).toEqual(new Uint8Array([1, 2, 3, 4]).buffer);
    expect(await store.open("ws2", saved.relativePath, saved.contentType)).toBeNull();

    await store.remove("ws1", saved.relativePath);
    expect(await store.open("ws1", saved.relativePath, saved.contentType)).toBeNull();
  });

  it("moves owned disk-backed uploads and derives a safe media type", async () => {
    const { root, store } = await storage();
    const source = path.join(root, "upload.m4a");
    await fs.writeFile(source, new Uint8Array([9, 8, 7]));
    const saved = await store.save({
      id: "trx_disk",
      workspaceId: "ws1",
      title: "voice.m4a",
      contentType: "text/html\r\nX-Bad: yes",
      source: { filePath: source, byteLength: 3 },
      moveSource: true,
    });

    expect(saved.contentType).toBe("audio/mp4");
    expect(new Uint8Array(await Bun.file(saved.absolutePath).arrayBuffer())).toEqual(new Uint8Array([9, 8, 7]));
    expect(await Bun.file(source).exists()).toBe(false);
  });

  it("refuses an agent-controlled symlink in the internal path", async () => {
    const { root, store } = await storage();
    const workspace = path.join(root, "ws1");
    await fs.mkdir(workspace, { recursive: true });
    await fs.symlink(root, path.join(workspace, ".pixelspace"));

    await expect(store.save({
      id: "trx_link",
      workspaceId: "ws1",
      title: "voice.wav",
      contentType: "audio/wav",
      source: { bytes: new Uint8Array([1]) },
    })).rejects.toThrow("invalid transcription audio directory");
  });
});
