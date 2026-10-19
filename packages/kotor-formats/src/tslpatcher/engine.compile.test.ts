import { promises as fsp } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Tlk, writeTlk } from "../tlk.js";
import { parseChangesIni } from "./config.js";
import { TslPatcher, type CompileScriptRequest } from "./engine.js";
import { NodePatcherFs } from "./nodeFs.js";

let tmp: string;
let gameDir: string;
let dataDir: string;

const TLK_AND_COMPILE = `[TLKList]\nStrRef0=0\n[CompileList]\nFile0=hello.nss\n`;
const COMPILE_ONLY = `[CompileList]\nFile0=hello.nss\n`;

beforeEach(async () => {
  tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "kotor-formats-compile-"));
  gameDir = path.join(tmp, "game");
  dataDir = path.join(tmp, "mod", "tslpatchdata");
  await fsp.mkdir(path.join(gameDir, "Override"), { recursive: true });
  await fsp.mkdir(dataDir, { recursive: true });
  const dialog = new Tlk(0);
  dialog.add("Zero");
  await fsp.writeFile(path.join(gameDir, "dialog.tlk"), writeTlk(dialog));
  const append = new Tlk(0);
  append.add("Appended");
  await fsp.writeFile(path.join(dataDir, "append.tlk"), writeTlk(append));
});
afterEach(async () => {
  await fsp.rm(tmp, { recursive: true, force: true });
});

function patcher(options: { compileScript?: (req: CompileScriptRequest) => Promise<Uint8Array>; dryRun?: boolean; game?: 1 | 2 } = {}): TslPatcher {
  return new TslPatcher({ tslpatchdataDir: dataDir, gameDir, fs: new NodePatcherFs(), ...options });
}

describe("[CompileList] external compiler hook", () => {
  it("substitutes memory tokens, encodes windows-1252 and writes the produced ncs", async () => {
    await fsp.writeFile(path.join(dataDir, "hello.nss"), Buffer.from("void main() { int a = #StrRef0#; } // caf\xe9", "latin1"));
    const requests: CompileScriptRequest[] = [];
    const log = await patcher({
      compileScript: async (req) => {
        requests.push(req);
        return Uint8Array.from([0x4e, 0x43, 0x53, 7]);
      },
    }).apply(parseChangesIni(TLK_AND_COMPILE));
    expect(log.errors).toEqual([]);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.name).toBe("hello.nss");
    expect(requests[0]!.game).toBe(1);
    expect(requests[0]!.includeDirs).toEqual([dataDir]);
    expect(Buffer.from(requests[0]!.source).toString("latin1")).toBe("void main() { int a = 1; } // caf\xe9");
    expect(Array.from(await fsp.readFile(path.join(gameDir, "Override", "hello.ncs")))).toEqual([0x4e, 0x43, 0x53, 7]);
    expect(log.filesWritten).toContain(path.join(gameDir, "Override", "hello.ncs"));
    expect(log.warnings.join("\n")).not.toMatch(/precompiled/);
  });

  it("gives the hook override and base-game resources and detects the second game", async () => {
    await fsp.writeFile(path.join(dataDir, "hello.nss"), "void main() { }");
    await fsp.writeFile(path.join(gameDir, "swkotor2.exe"), "");
    await fsp.writeFile(path.join(gameDir, "Override", "nwscript.nss"), "// engine api");
    let seen: { game: number; nwscript: string | undefined; missing: Uint8Array | undefined } | undefined;
    const log = await patcher({
      compileScript: async (req) => {
        const nwscript = await req.readGameResource("nwscript.nss");
        seen = { game: req.game, nwscript: nwscript && Buffer.from(nwscript).toString(), missing: await req.readGameResource("absent_include.nss") };
        return Uint8Array.from([1]);
      },
    }).apply(parseChangesIni(COMPILE_ONLY));
    expect(log.errors).toEqual([]);
    expect(seen).toEqual({ game: 2, nwscript: "// engine api", missing: undefined });
  });

  it("lets an explicit game option win over detection", async () => {
    await fsp.writeFile(path.join(dataDir, "hello.nss"), "void main() { }");
    await fsp.writeFile(path.join(gameDir, "swkotor2.exe"), "");
    let game = 0;
    await patcher({ game: 1, compileScript: async (req) => ((game = req.game), Uint8Array.from([1])) }).apply(parseChangesIni(COMPILE_ONLY));
    expect(game).toBe(1);
  });

  it("reports a compiler failure as an error and writes nothing", async () => {
    await fsp.writeFile(path.join(dataDir, "hello.nss"), "void main() { }");
    const log = await patcher({
      compileScript: async () => {
        throw new Error("syntax error on line 3");
      },
    }).apply(parseChangesIni(COMPILE_ONLY));
    expect(log.errors.join("\n")).toMatch(/script compilation failed: hello\.nss: syntax error on line 3/);
    expect(log.filesWritten).toEqual([]);
  });

  it("rejects an empty compiler result", async () => {
    await fsp.writeFile(path.join(dataDir, "hello.nss"), "void main() { }");
    const log = await patcher({ compileScript: async () => new Uint8Array() }).apply(parseChangesIni(COMPILE_ONLY));
    expect(log.errors.join("\n")).toMatch(/produced an empty \.ncs/);
    expect(log.filesWritten).toEqual([]);
  });

  it("does not call the hook in a dry run and keeps the unverified record", async () => {
    await fsp.writeFile(path.join(dataDir, "hello.nss"), "void main() { }");
    let calls = 0;
    const log = await patcher({ dryRun: true, compileScript: async () => (calls++, Uint8Array.from([1])) }).apply(parseChangesIni(COMPILE_ONLY));
    expect(calls).toBe(0);
    expect(log.errors).toEqual([]);
    expect(log.unverified).toHaveLength(1);
    expect(log.filesWritten).toEqual([]);
  });

  it("prefers a shipped precompiled ncs over the hook", async () => {
    await fsp.writeFile(path.join(dataDir, "hello.nss"), "void main() { }");
    await fsp.writeFile(path.join(dataDir, "hello.ncs"), Uint8Array.from([9, 9]));
    let calls = 0;
    const log = await patcher({ compileScript: async () => (calls++, Uint8Array.from([1])) }).apply(parseChangesIni(COMPILE_ONLY));
    expect(calls).toBe(0);
    expect(log.errors).toEqual([]);
    expect(Array.from(await fsp.readFile(path.join(gameDir, "Override", "hello.ncs")))).toEqual([9, 9]);
  });

  it("still fails when there is neither source nor precompiled script, even with a hook", async () => {
    let calls = 0;
    const log = await patcher({ compileScript: async () => (calls++, Uint8Array.from([1])) }).apply(parseChangesIni(COMPILE_ONLY));
    expect(calls).toBe(0);
    expect(log.errors.join("\n")).toMatch(/requires a compiler or precompiled/);
  });

  it("keeps the no-compiler error without a hook", async () => {
    await fsp.writeFile(path.join(dataDir, "hello.nss"), "void main() { }");
    const log = await patcher().apply(parseChangesIni(COMPILE_ONLY));
    expect(log.errors.join("\n")).toMatch(/script compilation unavailable: hello\.nss/);
  });
});
