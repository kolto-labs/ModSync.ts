import { beforeEach, describe, expect, it, vi } from "vitest";

interface FakeModule {
  id: number;
  mounted: Set<string>;
  files: Map<string, string>;
  callMain: ReturnType<typeof vi.fn>;
}

type Behavior = (module: FakeModule, args: string[]) => number | void;

const fake = vi.hoisted(() => ({
  modules: [] as FakeModule[],
  behavior: undefined as Behavior | undefined,
  output: undefined as ((module: FakeModule) => string) | undefined,
}));

vi.mock("7z-wasm", () => ({
  default: async (opts: { print: (line: string) => void }) => {
    const module: FakeModule = {
      id: fake.modules.length + 1,
      mounted: new Set(),
      files: new Map(),
      callMain: vi.fn(),
    };
    const dirs = new Set<string>(["/"]);
    module.callMain.mockImplementation((args: string[]) => {
      const code = fake.behavior?.(module, args);
      opts.print(fake.output ? fake.output(module) : `module-${module.id}`);
      return code ?? 0;
    });
    fake.modules.push(module);
    const missing = () => Object.assign(new Error("ENOENT"), { errno: 44 });
    return {
      NODEFS: {},
      callMain: module.callMain,
      FS: {
        chmod: () => undefined,
        mkdir: (target: string) => {
          if (dirs.has(target)) throw Object.assign(new Error("EEXIST"), { errno: 20 });
          dirs.add(target);
        },
        rmdir: (target: string) => {
          dirs.delete(target);
        },
        mount: (_fs: unknown, _opts: unknown, mountPoint: string) => {
          module.mounted.add(mountPoint);
        },
        unmount: (mountPoint: string) => {
          module.mounted.delete(mountPoint);
        },
        writeFile: (target: string, content: string) => {
          module.files.set(target, content);
        },
        unlink: (target: string) => {
          module.files.delete(target);
        },
        stat: (target: string) => {
          if (dirs.has(target)) return { mode: 1 };
          if (module.files.has(target)) return { mode: 2 };
          throw missing();
        },
        isDir: (mode: number) => mode === 1,
        readdir: () => [".", ".."],
      },
    };
  },
}));

const TRAP_MESSAGE = "table index is out of bounds";

function trap(): never {
  throw new WebAssembly.RuntimeError(TRAP_MESSAGE);
}

async function loadAdapter() {
  vi.resetModules();
  return import("./sevenZip.js");
}

beforeEach(() => {
  fake.modules.length = 0;
  fake.behavior = undefined;
  fake.output = undefined;
});

describe("7z-wasm trap recovery", () => {
  it("retries once on a fresh module and re-establishes mounts and MEMFS files", async () => {
    const { runSevenZipWasm } = await loadAdapter();
    const observed: Array<{ module: number; mounted: string[]; files: string[] }> = [];
    fake.behavior = (module) => {
      observed.push({ module: module.id, mounted: [...module.mounted].sort(), files: [...module.files.keys()] });
      if (module.id === 1) trap();
    };

    const result = await runSevenZipWasm(
      ["x", "-y", "-o/mnt/m2", "-i@/mnt/list1.txt", "/mnt/m1/pack.7z"],
      [
        { host: "/host/in", mountPoint: "/mnt/m1" },
        { host: "/host/out", mountPoint: "/mnt/m2" },
      ],
      { "/mnt/list1.txt": "a.txt\n" },
    );

    expect(result).toEqual({ code: 0, stdout: "module-2", stderr: "" });
    expect(fake.modules).toHaveLength(2);
    expect(fake.modules[0]!.callMain).toHaveBeenCalledTimes(1);
    expect(fake.modules[1]!.callMain).toHaveBeenCalledTimes(1);
    expect(observed).toEqual([
      { module: 1, mounted: ["/mnt/m1", "/mnt/m2"], files: ["/mnt/list1.txt"] },
      { module: 2, mounted: ["/mnt/m1", "/mnt/m2"], files: ["/mnt/list1.txt"] },
    ]);
    expect(fake.modules[1]!.mounted.size).toBe(0);
    expect(fake.modules[1]!.files.size).toBe(0);
  });

  it("keeps using the fresh module after a recovered trap", async () => {
    const { runSevenZipWasm } = await loadAdapter();
    fake.behavior = (module) => {
      if (module.id === 1) trap();
    };

    await runSevenZipWasm(["l", "/mnt/m1/a.7z"], [{ host: "/host", mountPoint: "/mnt/m1" }]);
    const second = await runSevenZipWasm(["l", "/mnt/m2/a.7z"], [{ host: "/host", mountPoint: "/mnt/m2" }]);

    expect(second.stdout).toBe("module-2");
    expect(fake.modules).toHaveLength(2);
  });

  it("surfaces the original crash message when the retry also traps", async () => {
    const { runSevenZipWasm } = await loadAdapter();
    let calls = 0;
    fake.behavior = () => {
      calls += 1;
      if (calls === 1) throw new WebAssembly.RuntimeError(TRAP_MESSAGE);
      throw new WebAssembly.RuntimeError("memory access out of bounds");
    };

    await expect(runSevenZipWasm(["l", "/mnt/m1/a.7z"], [{ host: "/host", mountPoint: "/mnt/m1" }])).rejects.toThrow(
      `7z-wasm crashed running "l /mnt/m1/a.7z": ${TRAP_MESSAGE}`,
    );
    expect(calls).toBe(2);
    expect(fake.modules).toHaveLength(2);
  });

  it("does not retry non-trap failures but still drops the module", async () => {
    const { runSevenZipWasm } = await loadAdapter();
    let calls = 0;
    fake.behavior = () => {
      calls += 1;
      if (calls === 1) throw 42;
    };

    await expect(runSevenZipWasm(["l", "/mnt/m1/a.7z"], [{ host: "/host", mountPoint: "/mnt/m1" }])).rejects.toThrow(
      "native exception 42",
    );
    expect(calls).toBe(1);
    expect(fake.modules).toHaveLength(1);

    const next = await runSevenZipWasm(["l", "/mnt/m2/a.7z"], [{ host: "/host", mountPoint: "/mnt/m2" }]);
    expect(next.stdout).toBe("module-2");
    expect(fake.modules).toHaveLength(2);
  });

  it("does not retry non-zero 7z exit codes", async () => {
    const { runSevenZipWasm } = await loadAdapter();
    fake.behavior = () => 2;

    const result = await runSevenZipWasm(["l", "/mnt/m1/a.7z"], [{ host: "/host", mountPoint: "/mnt/m1" }]);

    expect(result.code).toBe(2);
    expect(fake.modules).toHaveLength(1);
    expect(fake.modules[0]!.callMain).toHaveBeenCalledTimes(1);
  });

  it("recovers a listing through the archive adapter without a CLI fallback", async () => {
    const { openSevenZip } = await loadAdapter();
    const listing = ["Path = docs/readme.txt", "Size = 5", "Folder = -", "Attributes = A", ""].join("\n");
    const argLists: string[][] = [];
    fake.behavior = (module, args) => {
      argLists.push(args);
      if (module.id === 1) trap();
    };
    fake.output = () => listing;

    const reader = await openSevenZip("/virtual/pack.7z");
    const entries = await reader.list();

    expect(entries).toContainEqual({ path: "docs/readme.txt", isDirectory: false, size: 5 });
    expect(argLists).toHaveLength(2);
    expect(argLists[1]).toEqual(argLists[0]);
    expect(argLists[0]).toEqual(expect.arrayContaining(["l", "-ba", "-slt"]));
    expect(fake.modules).toHaveLength(2);
  });

  it("rethrows the original crash through the adapter when both attempts trap and no CLI is configured", async () => {
    const { openSevenZip } = await loadAdapter();
    fake.behavior = () => trap();

    await expect(openSevenZip("/virtual/pack.7z")).rejects.toThrow(
      `7z-wasm crashed running "l -ba -slt -bd -bsp0 /mnt/m1/pack.7z": ${TRAP_MESSAGE}`,
    );
    expect(fake.modules).toHaveLength(2);
  });
});

describe("7z-wasm proactive recycling", () => {
  it("keeps one module through the mount budget and recycles on the next operation", async () => {
    const { runSevenZipWasm, SEVEN_ZIP_WASM_RECYCLE_MOUNTS } = await loadAdapter();
    let mountCounter = 0;
    const run = () => {
      mountCounter += 1;
      return runSevenZipWasm(["l", `/mnt/m${mountCounter}/a.7z`], [{ host: "/host", mountPoint: `/mnt/m${mountCounter}` }]);
    };

    for (let index = 0; index < SEVEN_ZIP_WASM_RECYCLE_MOUNTS; index += 1) {
      expect((await run()).stdout).toBe("module-1");
    }
    expect(fake.modules).toHaveLength(1);

    expect((await run()).stdout).toBe("module-2");
    expect(fake.modules).toHaveLength(2);
    expect((await run()).stdout).toBe("module-2");
    expect(fake.modules).toHaveLength(2);
    expect(fake.modules.every((module) => module.mounted.size === 0)).toBe(true);
  });

  it("counts every mount of an operation toward the budget", async () => {
    const { runSevenZipWasm, SEVEN_ZIP_WASM_RECYCLE_MOUNTS } = await loadAdapter();
    let mountCounter = 0;
    const run = () => {
      const first = `/mnt/m${(mountCounter += 1)}`;
      const second = `/mnt/m${(mountCounter += 1)}`;
      return runSevenZipWasm(["x", first, second], [
        { host: "/host/in", mountPoint: first },
        { host: "/host/out", mountPoint: second },
      ]);
    };

    const operations = SEVEN_ZIP_WASM_RECYCLE_MOUNTS / 2;
    for (let index = 0; index < operations; index += 1) await run();
    expect(fake.modules).toHaveLength(1);

    await run();
    expect(fake.modules).toHaveLength(2);
  });

  it("never loses concurrent operations that straddle a recycle", async () => {
    const { runSevenZipWasm, SEVEN_ZIP_WASM_RECYCLE_MOUNTS } = await loadAdapter();
    const total = SEVEN_ZIP_WASM_RECYCLE_MOUNTS + 25;
    fake.behavior = (module, args) => {
      const mountPoint = args[1]!;
      if (!module.mounted.has(mountPoint)) return 9;
    };

    const results = await Promise.all(
      Array.from({ length: total }, (_unused, index) => {
        const mountPoint = `/mnt/m${index + 1}`;
        return runSevenZipWasm(["l", mountPoint], [{ host: "/host", mountPoint }]);
      }),
    );

    expect(results.every((result) => result.code === 0)).toBe(true);
    expect(fake.modules).toHaveLength(2);
    expect(fake.modules[0]!.callMain).toHaveBeenCalledTimes(SEVEN_ZIP_WASM_RECYCLE_MOUNTS);
    expect(fake.modules[1]!.callMain).toHaveBeenCalledTimes(25);
    expect(fake.modules.every((module) => module.mounted.size === 0)).toBe(true);
  });

  it("restarts the budget after a trap recovery", async () => {
    const { runSevenZipWasm, SEVEN_ZIP_WASM_RECYCLE_MOUNTS } = await loadAdapter();
    fake.behavior = (module) => {
      if (module.id === 1) trap();
    };
    let mountCounter = 0;
    const run = () => {
      mountCounter += 1;
      return runSevenZipWasm(["l", `/mnt/m${mountCounter}`], [{ host: "/host", mountPoint: `/mnt/m${mountCounter}` }]);
    };

    await run();
    expect(fake.modules).toHaveLength(2);
    for (let index = 0; index < SEVEN_ZIP_WASM_RECYCLE_MOUNTS - 1; index += 1) await run();
    expect(fake.modules).toHaveLength(2);

    await run();
    expect(fake.modules).toHaveLength(3);
  });
});
