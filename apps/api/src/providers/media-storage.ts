import { mkdir, stat, unlink, writeFile } from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";

export const maxVideoBytes = 100 * 1024 * 1024;
const mediaRoot = path.resolve(process.env.PRIVATE_MEDIA_DIR ?? path.join(process.cwd(), "private-media"));

export interface MediaStorage {
  put(key: string, bytes: Buffer): Promise<void>;
  remove(key: string): Promise<void>;
  open(key: string, start?: number, end?: number): ReturnType<typeof createReadStream>;
  size(key: string): Promise<number>;
}

export class LocalPrivateMediaStorage implements MediaStorage {
  private file(key: string) {
    if (!/^[a-f0-9-]{36}\.(mp4|webm|mov)$/.test(key)) throw new Error("Invalid storage key");
    return path.join(mediaRoot, key);
  }
  async put(key: string, bytes: Buffer) {
    await mkdir(mediaRoot, { recursive: true });
    await writeFile(this.file(key), bytes, { flag: "wx", mode: 0o600 });
  }
  async remove(key: string) {
    try { await unlink(this.file(key)); } catch { /* old local files may already be absent */ }
  }
  open(key: string, start?: number, end?: number) {
    return createReadStream(this.file(key), start === undefined ? {} : { start, end });
  }
  async size(key: string) { return (await stat(this.file(key))).size; }
}

export const mediaStorage: MediaStorage = new LocalPrivateMediaStorage();
