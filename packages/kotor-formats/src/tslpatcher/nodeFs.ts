import { promises as fsp } from "node:fs";
import * as path from "node:path";
import type { PatcherFs } from "./fs.js";

/** PatcherFs backed by node:fs/promises. */
export class NodePatcherFs implements PatcherFs {
  async isSymbolicLink(p: string): Promise<boolean> {
    try { return (await fsp.lstat(p)).isSymbolicLink(); }
    catch (err) { if ((err as NodeJS.ErrnoException).code === "ENOENT") return false; throw err; }
  }
  async realpath(p: string): Promise<string> {
    return fsp.realpath(p);
  }
  async exists(p: string): Promise<boolean> {
    try {
      await fsp.access(p);
      return true;
    } catch {
      return false;
    }
  }
  async readFile(p: string): Promise<Uint8Array> {
    const buf = await fsp.readFile(p);
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  }
  async writeFile(p: string, data: Uint8Array): Promise<void> {
    await fsp.mkdir(path.dirname(p), { recursive: true });
    await fsp.writeFile(p, data);
  }
  async mkdirp(p: string): Promise<void> {
    await fsp.mkdir(p, { recursive: true });
  }
  async readDir(p: string): Promise<string[]> {
    try {
      return await fsp.readdir(p);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") return [];
      throw err;
    }
  }
  async copyFile(src: string, dest: string): Promise<void> {
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    await fsp.copyFile(src, dest);
  }
  async rename(src: string, dest: string): Promise<void> {
    await fsp.rename(src, dest);
  }
  async unlink(p: string): Promise<void> {
    await fsp.unlink(p);
  }
}
