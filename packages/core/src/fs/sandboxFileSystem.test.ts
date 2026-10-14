import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RealFileSystem } from "./realFileSystem.js";
import { SandboxFileSystem } from "./sandboxFileSystem.js";
import { VirtualFileSystem } from "./virtualFileSystem.js";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "modsync-sandbox-"));
  await mkdir(`${root}/game`);
  await mkdir(`${root}/mods`);
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe.each([false, true])("native canonical containment (virtual=%s)", (virtual) => {
  function create(): SandboxFileSystem {
    const fs = new RealFileSystem();
    return new SandboxFileSystem(virtual ? new VirtualFileSystem(fs) : fs, { modDirectory: `${root}/mods`, kotorDirectory: `${root}/game` });
  }
  it("rejects links and direct paths to a distinct sibling differing only in case", async () => {
    if (process.platform !== "linux") return;
    await mkdir(`${root}/GAME`);
    await writeFile(`${root}/GAME/secret.txt`, "untouched");
    await symlink(`${root}/GAME`, `${root}/game/linked`, "dir");
    const fs = create();
    await expect(fs.readFile(`${root}/game/linked/secret.txt`)).rejects.toMatchObject({ name: "PathEscapeError" });
    await expect(fs.writeFile(`${root}/game/linked/secret.txt`, new TextEncoder().encode("bad"))).rejects.toMatchObject({ name: "PathEscapeError" });
    await expect(fs.readFile(`${root}/GAME/secret.txt`)).rejects.toMatchObject({ name: "PathEscapeError" });
    expect(await readFile(`${root}/GAME/secret.txt`, "utf8")).toBe("untouched");
  });
  it("retains case-insensitive child lookups resolving within the configured root", async () => {
    await mkdir(`${root}/game/Override`);
    await writeFile(`${root}/game/Override/Item.TXT`, "safe");
    const fs = create();
    expect(new TextDecoder().decode(await fs.readFile(`${root}/game/override/item.txt`))).toBe("safe");
    expect(await fs.resolveCase(`${root}/game/OVERRIDE/ITEM.txt`)).toBe(`${root}/game/Override/Item.TXT`);
  });
});
